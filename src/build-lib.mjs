/**
 * 插件构建期共用的「内联成单文件」工具。
 *
 * 背景：宿主以 **ESM blob** 加载插件，运行时不能 `import` 兄弟文件，所以
 * src/lib/*.mjs、npm 里的共用库、以及要给子进程执行的脚本，全部得在构建期
 * 拼进 main.js。六个插件各写了一份 build.mjs，骨架一模一样（读 head → 逐个
 * 读库 → 剥 export 与兄弟 import → 拼接 → 自检），细节却漂开了：有的漏了
 * 重名自检，有的没做 CRLF 归一，有的黑名单少了 bare import。
 *
 * 这里把骨架收成一份，差异全部走**配置 + 钩子**，插件只需描述「我有哪些库」：
 *
 *   buildPlugin({
 *     root,
 *     libs: ["parse", "rising", { name: "feedback", source: "shared" }],
 *     indent: "  ",                       // 库内联进 activate() 时用
 *     scripts: [{ marker, file, constName, prepend: ["model"] }],
 *     banned: [...],                      // 追加黑名单
 *     extra(written) { ... },             // 插件自有的产物检查
 *   })
 *
 * 新增插件不需要再改本文件；真有覆盖不到的形态，往 opts 里加一个钩子即可，
 * 不动其余插件的行为。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

/** 产物里绝不能出现的写法。validate-core 有一份更全的，这里只拦构建期就能发现的。 */
const DEFAULT_BANNED = [
  [/\beval\s*\(/, "eval("],
  [/\bnew\s+Function\s*\(/, "new Function("],
  [/__TAURI__/, "__TAURI__"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bimport\s*\(\s*["'`]https?:/, "远程 import("],
  [/^\s*import\s+.+from\s+["'][^./]/m, "bare import"],
];

/** 2MB 是宿主的硬上限，超了直接拒绝加载。 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 超过这个值就打警告：单文件越大，宿主每次加载越慢。 */
const WARN_BYTES = 512 * 1024;

/**
 * 剥掉行首的 `export `。
 *
 * 库文件是 ESM（单测要能直接 import），内联进函数体后 `export function` 是语法
 * 错误。只动行首，避免误伤字符串里的 "export"。
 */
export function stripExports(source) {
  return source.replace(/^export\s+(?=(?:function|const|let|var|class)\s)/gm, "");
}

/**
 * 剥掉指向兄弟库的 import。
 *
 * 支持两种写法：`./name.mjs`（库之间）与 `../src/lib/name.mjs`（脚本引本地库）。
 * 用 `[^}]*` 而不是 `[\s\S]*?`：后者会从任意一个 `import {` 一路吃到目标文件的
 * `}`，把夹在中间的 node 内置 import 一起吞掉——workspace-config 的落盘脚本就
 * 踩过这个坑（剥完之后 child_process 消失，运行时报「xxx is not defined」）。
 *
 * 不在 allow 里的依赖不剥：那是真实外部依赖，留着交给后面的「不许有 import」拦。
 */
function stripLocalImports(source, name, allow) {
  const re = /^import\s*\{[^}]*\}\s*from\s*["'](?:\.\/|\.\.\/src\/lib\/)([A-Za-z0-9_-]+)\.mjs["'];?[ \t]*\r?\n/gm;
  return source.replace(re, (all, dep) => {
    if (!allow.includes(dep)) {
      throw new Error(`${name} 引用了不在内联清单里的库：${dep}.mjs`);
    }
    return "";
  });
}

/** 每行补缩进；空行保持空行，免得产出一堆只有空格的空白行。 */
function indentLines(source, pad) {
  if (!pad) return source;
  return source
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : pad + line))
    .join("\n");
}

/**
 * 顶层重名自检。
 *
 * 库文件和 head 会拼进同一个作用域，重名不是「后者覆盖前者」而是整个模块
 * 语法错误，宿主 import 即失败。只扫目标作用域那一层的声明（indent 模式下
 * 是两格缩进的那些），函数体内的局部量不受影响。
 */
function checkDuplicateDecls(written, pad) {
  const decl = new RegExp(
    "^" + pad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:export\\s+)?(?:function|const|let|var|class)\\s+([A-Za-z0-9_$]+)",
    "gm",
  );
  const seen = new Map();
  let m;
  while ((m = decl.exec(written))) {
    const name = m[1];
    const line = written.slice(0, m.index).split("\n").length;
    if (seen.has(name)) {
      throw new Error(`顶层标识符重名：${name}（第 ${seen.get(name)} 行与第 ${line} 行）`);
    }
    seen.set(name, line);
  }
}

/**
 * 把库与脚本内联进 main.head.js，写出 main.js。
 *
 * @param {object} opts
 * @param {string} opts.root 插件根目录
 * @param {(string|{name:string, source?:"shared"|"local"|"auto", file?:string})[]} [opts.libs]
 *        内联顺序即数组顺序。字符串形态按「先共用包、再 src/lib」自动识别来源。
 * @param {string} [opts.indent] 库内联进函数体时的缩进，默认顶层
 * @param {string} [opts.libMarker] 库内联区开始标记
 * @param {string} [opts.libMarkerEnd] 库内联区结束标记；head 里只有开始标记时，
 *        整个开始标记会被替换掉（workspace-config 就是这个形态）
 * @param {{marker:string, file:string, constName:string, prepend?:string[],
 *          stripImports?:boolean, stripShebang?:boolean}[]} [opts.scripts]
 *        以 `const <constName> = "..."` 形式内联的整文件脚本；`prepend` 里的库源码
 *        会拼在脚本前面（脚本在子进程里独立执行，拿不到主文件的库定义）。
 *        `stripImports: false` 用于**运行时会落盘成独立文件**的脚本（leetcode 的
 *        login.mjs 与 mini-ws.mjs 各写一份再互相 import），这时 import 必须保留。
 *        `stripShebang` 默认 false：落盘后可执行的文件保留 `#!`；只在不落盘、
 *        纯当源码拼接时剥掉（workspace-config 的 config-io.mjs）。
 * @param {[RegExp,string][]} [opts.banned] 追加黑名单
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.warnBytes]
 * @param {boolean} [opts.hash] 是否打印 md5
 * @param {(written:string, ctx:object)=>void} [opts.extra] 插件自有的产物检查
 * @param {boolean} [opts.write] false 时只算不写（单测用）
 * @param {string} [opts.head] 覆盖 head 文件路径
 * @param {string} [opts.out] 覆盖产物路径
 * @returns {{main:string, bytes:number, md5:string|null}}
 */
export function buildPlugin(opts) {
  const root = opts.root;
  if (!root) throw new Error("buildPlugin 需要 root");

  const pad = opts.indent || "";
  const libMarker = opts.libMarker || "/*__LIB_SOURCE__*/";
  const libMarkerEnd = opts.libMarkerEnd || "/*__LIB_SOURCE_END__*/";
  const require = createRequire(path.join(root, "__build__.mjs"));
  const headPath = opts.head || path.join(root, "src", "main.head.js");
  const outPath = opts.out || path.join(root, "main.js");

  // 归一成 {name, source, file}。字符串按「先共用包、再 src/lib」自动识别来源；
  // 对象可以显式指定 source 与 file（少数形态需要）。
  const libs = (opts.libs || []).map((lib) => {
    if (typeof lib === "string") return { name: lib, source: "auto" };
    return { name: lib.name, source: lib.source || "auto", file: lib.file };
  });
  const order = libs.map((l) => l.name);

  function readLib(name) {
    const spec = libs.find((l) => l.name === name);
    if (!spec) throw new Error(`内联清单里没有 ${name}`);
    if (spec.file) return fs.readFileSync(spec.file, "utf8");

    if (spec.source !== "local") {
      try {
        return fs.readFileSync(require.resolve("ccgui-plugin-shared/" + name), "utf8");
      } catch (err) {
        if (spec.source === "shared") {
          throw new Error(
            `读不到共用库 ccgui-plugin-shared/${name}（${err.message}）。` +
              "先跑 npm install——这个包是 npm 依赖，不在仓库里。",
          );
        }
        // source: "auto" 时落到本地库
      }
    }
    const local = path.join(root, "src", "lib", name + ".mjs");
    if (!fs.existsSync(local)) {
      throw new Error(`读不到 ${name}：共用包没有这个入口，src/lib/${name}.mjs 也不存在`);
    }
    return fs.readFileSync(local, "utf8");
  }

  /** 库的真实来源，用来在内联注释里写清楚是哪一份。 */
  function originOf(name) {
    const spec = libs.find((l) => l.name === name);
    if (spec.file) return path.relative(root, spec.file).replace(/\\/g, "/");
    if (spec.source === "local") return "src/lib";
    try {
      require.resolve("ccgui-plugin-shared/" + name);
      return "ccgui-plugin-shared";
    } catch {
      return "src/lib";
    }
  }

  /** 读 + 剥兄弟 import + 剥 export。所有库和脚本内联都必须走这一套，自检才成立。 */
  function transform(name) {
    const src = stripLocalImports(readLib(name).replace(/\r\n/g, "\n"), name, order);
    if (/^\s*import\s/m.test(src)) throw new Error(`${name}.mjs 含无法内联的 import`);
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(src)) throw new Error(`${name}.mjs 含禁用写法`);
    return stripExports(src).trim();
  }

  const transformed = new Map();
  const getTransformed = (name) => {
    if (!transformed.has(name)) transformed.set(name, transform(name));
    return transformed.get(name);
  };

  let out = fs.readFileSync(headPath, "utf8");
  // 强制 LF：Windows 检出后 CRLF 会让 CI 的 git diff 假失败。
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ---- 库内联区 ----
  if (order.length === 0 && (out.includes(libMarker) || out.includes(libMarkerEnd))) {
    throw new Error(`main.head.js 有内联标记，但 build 没声明任何 libs`);
  }
  if (order.length > 0) {
    if (!out.includes(libMarker)) {
      throw new Error(`main.head.js 缺少内联标记 ${libMarker}`);
    }
    const chunks = order.map((name) => {
      const body = indentLines(getTransformed(name), pad);
      return pad + "// ---- " + originOf(name) + "/" + name + ".mjs ----\n" + body + "\n";
    });
    const hasLocal = order.some((name) => {
      const o = originOf(name);
      return o.startsWith("src/lib");
    });
    const banner =
      pad +
      "// ---- 以下由 " +
      (hasLocal ? "src/lib/*.mjs 与共用库" : "ccgui-plugin-shared") +
      " 内联生成 ----\n";

    if (out.includes(libMarkerEnd)) {
      const startAt = out.indexOf(libMarker);
      const endAt = out.indexOf(libMarkerEnd);
      if (endAt < startAt) throw new Error("内联标记顺序颠倒");
      out =
        out.slice(0, startAt) +
        banner +
        chunks.join("\n") +
        out.slice(endAt + libMarkerEnd.length);
    } else {
      // 只有开始标记：整条标记替换成内联内容（workspace-config 的形态）。
      out = out.replace(libMarker, () => banner + chunks.join("\n"));
    }
  }

  // ---- 整文件脚本内联 ----
  const scriptBodies = new Map();
  for (const s of opts.scripts || []) {
    if (!out.includes(s.marker)) throw new Error(`main.head.js 缺少标记 ${s.marker}`);
    let body = fs.readFileSync(path.join(root, s.file), "utf8").replace(/\r\n/g, "\n");
    if (s.stripShebang) body = body.replace(/^#!.*\n/, "");
    // 默认剥掉指向内联库的 import：脚本会被拼成一段独立源码，带上 import 执行不了。
    // 但**运行时会落盘成独立文件**的脚本（leetcode 的 login.mjs / mini-ws.mjs
    // 各写一份再互相 import）要保留，否则落盘后 import 目标不存在。
    if (s.stripImports !== false) body = stripLocalImports(body, s.file, order);
    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(body)) throw new Error(`${s.file} 含禁用写法`);
    const prelude = (s.prepend || []).map((n) => getTransformed(n)).join("\n\n");
    const source = prelude ? prelude + "\n\n" + body : body;
    scriptBodies.set(s.constName, source);
    // 用函数形式替换：字符串替换值会把 $&、$' 当成特殊模式。
    out = out.replace(s.marker, () => "const " + s.constName + " = " + JSON.stringify(source) + ";");
  }

  // 产物必须自包含：行首 import 一条都不允许。
  const badImport = out.split("\n").find((line) => /^\s*import\s/.test(line));
  if (badImport) throw new Error("main.js 里出现了 import：" + badImport.trim());

  // ---- 自检 ----
  // 内联内容必须与源文件逐字一致（剥 export / 兄弟 import / 补缩进之后）。
  for (const name of order) {
    if (!out.includes(indentLines(getTransformed(name), pad))) {
      throw new Error(`内联校验失败：${name}.mjs 与产物不一致`);
    }
  }
  if (out.includes(libMarker) || out.includes(libMarkerEnd)) {
    throw new Error("产物里残留内联标记");
  }
  // 脚本常量必须逐字等于源文件（换行、$& 之类都还原成原样），
  // 否则「运行时会落盘的那份文件」与仓库里的源文件就不是一回事了。
  for (const [constName, source] of scriptBodies) {
    if (!out.includes("const " + constName + " = " + JSON.stringify(source) + ";")) {
      throw new Error(constName + " 与源文件不一致");
    }
  }
  for (const s of opts.scripts || []) {
    if (out.includes(s.marker)) throw new Error("产物里残留内联标记 " + s.marker);
  }

  checkDuplicateDecls(out, pad);

  for (const [re, label] of DEFAULT_BANNED.concat(opts.banned || [])) {
    if (re.test(out)) throw new Error("产物命中黑名单：" + label);
  }

  if (typeof opts.extra === "function") opts.extra(out, { root, outPath });

  const bytes = Buffer.byteLength(out);
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const warnBytes = opts.warnBytes == null ? WARN_BYTES : opts.warnBytes;
  if (bytes > maxBytes) throw new Error(`main.js 超过 ${Math.round(maxBytes / 1024)}KB 上限：${bytes}`);
  if (warnBytes && bytes > warnBytes) {
    process.stderr.write(`警告：main.js 超过 ${Math.round(warnBytes / 1024)}KB 警告线：${bytes}\n`);
  }

  const md5 = opts.hash ? createHash("md5").update(out).digest("hex") : null;

  if (opts.write !== false) fs.writeFileSync(outPath, out, "utf8");

  return { main: out, bytes, md5 };
}
