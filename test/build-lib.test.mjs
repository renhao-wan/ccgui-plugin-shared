// build-lib 的用例：每条对应一个真实踩过的坑，或者一个插件的实际形态。
// 六个插件原本各写一份 build.mjs，这里逐条验证公共实现能覆盖它们的差异。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPlugin, stripExports } from "../src/build-lib.mjs";

/**
 * 造一份最小插件：head + 若干本地库。
 * libs 的键是库名，值是该库源码；写成 null 表示「head 里写了 import 但文件不存在」。
 */
function makePlugin({ head, libs = {}, extra = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildlib-"));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.head.js"), head);
  for (const [name, body] of Object.entries(libs)) {
    if (body === null) continue;
    fs.writeFileSync(path.join(root, "src", "lib", name + ".mjs"), body);
  }
  for (const [rel, body] of Object.entries(extra)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function run(opts) {
  const root = opts.root;
  try {
    return buildPlugin(Object.assign({ write: false }, opts, { root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('stripExports 只剥行首的 export，不误伤字符串里的 "export"', () => {
  const src = 'export function f() {}\nexport const A = "export const B";\nconst s = \'export let x\';\n';
  const out = stripExports(src);
  assert.ok(out.startsWith("function f() {}"));
  assert.ok(out.includes("const A ="), "表达式本体应保留");
  assert.ok(out.includes('"export const B"'), "字符串里的 export 不能动");
  assert.ok(out.includes("'export let x'"));
  assert.ok(out.includes("const s ="), "非 export 的行原样保留");
});

test("最小的顶层内联：库拼进标记区，剥 export 与兄弟 import", () => {
  const root = makePlugin({
    head: 'const T = 1;\n/*__LIB_SOURCE__*/\nfunction useIt() { return helper(); }\n/*__LIB_SOURCE_END__*/\n',
    libs: {
      helper: 'import { dep } from "./dep.mjs";\nexport function helper() { return dep(); }\n',
      dep: "export function dep() { return 1; }\n",
    },
  });
  const { main, bytes } = run({ root, libs: ["helper", "dep"].map((name) => ({ name, source: "local" })) });
  assert.ok(main.includes("function helper() { return dep(); }"), "export 应被剥掉");
  assert.ok(!main.includes('from "./dep.mjs"'), "兄弟 import 应被剥掉");
  assert.ok(main.indexOf("function helper") < main.indexOf("function dep"), "顺序应保持 LIB_ORDER");
  assert.ok(!main.includes("__LIB_SOURCE__"), "标记应被替换掉");
  assert.equal(bytes, Buffer.byteLength(main));
});

test("只写开始标记（workspace-config 的形态）也能内联", () => {
  const root = makePlugin({
    head: "const T = 1;\n/*__LIB_SOURCE__*/\nconst after = 2;\n",
    libs: { a: "export const A = 1;\n" },
  });
  const { main } = run({ root, libs: [{ name: "a", source: "local" }] });
  assert.ok(main.includes("const A = 1;"));
  assert.ok(main.includes("const after = 2;"), "标记之后的内容不能被吞掉");
  assert.ok(!main.includes("__LIB_SOURCE__"));
});

test("indent 模式：库整体补两格，重名自检只看这一层（cli-install-audit 的形态）", () => {
  const root = makePlugin({
    head: [
      "export default function activate(ctx) {",
      "  const { h } = ctx;",
      "  /*__LIB_SOURCE__*/",
      "  function Local() { const count = 1; return count; }",
      "  return Local;",
      "}",
      "",
    ].join("\n"),
    libs: {
      lib: "export function Shared() {\n  const count = 2;\n  return count;\n}\n",
    },
  });
  const { main } = run({ root, libs: [{ name: "lib", source: "local" }], indent: "  " });
  // 库的每一行都在两格缩进上，函数体内不会被误当成顶层声明
  assert.ok(main.includes("  function Shared() {"), "库应补缩进");
  assert.ok(main.includes("    const count = 2;"), "库内两格应变成四格");
});

test("indent 模式下重名会被抓到，而函数体内的局部量不会误报", () => {
  const root = makePlugin({
    head: "function activate(ctx) {\n  /*__LIB_SOURCE__*/\n  function Local() { const shared = 1; return shared; }\n  return Local;\n}\n",
    libs: { clash: "export const Local = 1;\n" },
  });
  assert.throws(
    () => run({ root, libs: [{ name: "clash", source: "local" }], indent: "  " }),
    /顶层标识符重名：Local/,
  );
});

test("顶层模式下重名同样抓到（trending / worklog / leetcode 的形态）", () => {
  const root = makePlugin({
    head: "function A() {}\n/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n",
    libs: { clash: "export function A() {}\n" },
  });
  assert.throws(
    () => run({ root, libs: [{ name: "clash", source: "local" }] }),
    /顶层标识符重名：A/,
  );
});

test("脚本内联：生成 const <name> = \"...\"，含 prepend 时把库拼在前面", () => {
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n/*__SCAN_SOURCE__*/\n",
    libs: { model: "export function readModel() { return 1; }\n" },
    extra: { "scripts/scan.mjs": "#!/usr/bin/env node\nimport { readModel } from \"../src/lib/model.mjs\";\nmain();\n" },
  });
  const { main } = run({
    root,
    libs: [{ name: "model", source: "local" }],
    scripts: [
      {
        marker: "/*__SCAN_SOURCE__*/",
        file: "scripts/scan.mjs",
        constName: "SCAN_SOURCE",
        prepend: ["model"],
        stripShebang: true,
      },
    ],
  });
  // 整段源码是 JSON 字符串字面量，shebang 与 model 的 import 都不该留在里面
  const m = /const SCAN_SOURCE = (".*");\n?$/s.exec(main);
  assert.ok(m, "应生成 SCAN_SOURCE 常量");
  const body = JSON.parse(m[1]);
  assert.ok(!body.startsWith("#!"), "shebang 应被剥掉");
  assert.ok(!body.includes('from "../src/lib/model.mjs"'), "本地库 import 应被剥掉");
  assert.ok(body.includes("function readModel()"), "prepend 的库源码应拼在脚本前面");
  assert.ok(body.includes("main();"), "脚本主体应保留");
});

test("脚本内联默认保留 shebang：落盘后可执行的文件需要它", () => {
  const root = makePlugin({
    head: "/*__SCAN_SOURCE__*/\n",
    extra: { "scripts/scan.mjs": "#!/usr/bin/env node\nconsole.log(1);\n" },
  });
  const { main } = run({
    root,
    scripts: [{ marker: "/*__SCAN_SOURCE__*/", file: "scripts/scan.mjs", constName: "SCAN_SOURCE" }],
  });
  const body = JSON.parse(/const SCAN_SOURCE = (".*");\n?$/s.exec(main)[1]);
  assert.ok(body.startsWith("#!/usr/bin/env node"), "shebang 应保留");
});

test("stripImports: false 时保留 import（运行时落盘成独立文件的脚本）", () => {
  // leetcode 的 login.mjs 会落盘到用户目录后执行，mini-ws.mjs 也要各落一份；
  // 剥掉 import 后落盘的 login 找不到 mini-ws。
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n/*__LOGIN_SOURCE__*/\n",
    libs: { "mini-ws": "export function ws() {}\n" },
    extra: { "scripts/login.mjs": 'import { ws } from "./mini-ws.mjs";\nws();\n' },
  });
  const { main } = run({
    root,
    libs: [{ name: "mini-ws", source: "local" }],
    scripts: [{ marker: "/*__LOGIN_SOURCE__*/", file: "scripts/login.mjs", constName: "LOGIN_SOURCE", stripImports: false }],
  });
  const body = JSON.parse(/const LOGIN_SOURCE = (".*");\n?$/s.exec(main)[1]);
  assert.ok(body.includes('from "./mini-ws.mjs"'), "import 必须保留");
});

test("脚本内联用函数形式替换：$& / $' 这类替换模式不会破坏内容", () => {
  const root = makePlugin({
    head: "/*__SCAN_SOURCE__*/\n",
    extra: { "scripts/scan.mjs": "const r = 'a'.replace(/a/, '$&$&');\nconsole.log('$` and $\'');\n" },
  });
  const { main } = run({
    root,
    scripts: [{ marker: "/*__SCAN_SOURCE__*/", file: "scripts/scan.mjs", constName: "SCAN_SOURCE" }],
  });
  assert.ok(main.includes("$&$&"), "$& 必须原样保留");
  assert.ok(main.includes("$` and $'"), "$` / $' 必须原样保留");
});

test("外部依赖的 import 必须拦下：内联后宿主加载会直接失败", () => {
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n",
    libs: { bad: 'import x from "lodash";\nexport const A = x;\n' },
  });
  assert.throws(() => run({ root, libs: [{ name: "bad", source: "local" }] }), /无法内联的 import/);
});

test("引用了不在清单里的兄弟库时报错，不会静默留下死 import", () => {
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n",
    libs: { a: 'import { b } from "./b.mjs";\nexport const A = b;\n' },
  });
  assert.throws(() => run({ root, libs: [{ name: "a", source: "local" }] }), /不在内联清单里/);
});

test("黑名单：eval / new Function / localStorage / bare import 一律拦下", () => {
  for (const [src, re] of [
    ["export const f = () => eval('1');\n", /禁用写法|黑名单/],
    ["export const f = new Function('a', 'return a');\n", /禁用写法|黑名单/],
    ["export const store = localStorage;\n", /localStorage/],
  ]) {
    const root = makePlugin({ head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n", libs: { x: src } });
    assert.throws(() => run({ root, libs: [{ name: "x", source: "local" }] }), re, src);
  }
});

test("产物里残留 import 时报错（head 自带 import 的形态）", () => {
  const root = makePlugin({
    head: 'import fs from "node:fs";\n/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n',
    libs: { a: "export const A = 1;\n" },
  });
  assert.throws(() => run({ root, libs: [{ name: "a", source: "local" }] }), /出现了 import/);
});

test("CRLF 的 head 与库都会归一成 LF，产物里不出现 \\r", () => {
  const root = makePlugin({
    head: "const T = 1;\r\n/*__LIB_SOURCE__*/\r\n/*__LIB_SOURCE_END__*/\r\n",
    libs: { a: "export const A = 1;\r\nexport const B = 2;\r\n" },
  });
  const { main } = run({ root, libs: [{ name: "a", source: "local" }] });
  assert.ok(!main.includes("\r"), "产物必须是 LF");
});

test("超过 maxBytes 直接报错（宿主的 2MB 硬上限）", () => {
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n",
    libs: { big: "export const BIG = '" + "x".repeat(2000) + "';\n" },
  });
  assert.throws(() => run({ root, libs: [{ name: "big", source: "local" }], maxBytes: 1000, warnBytes: 0 }), /上限/);
});

test("extra 钩子拿到完整产物，插件可以加自己的检查", () => {
  let seen = null;
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n",
    libs: { a: "export const A = 1;\n" },
  });
  run({
    root,
    libs: [{ name: "a", source: "local" }],
    extra(written) {
      seen = written;
    },
  });
  assert.ok(seen && seen.includes("const A = 1;"));
});

test("extra 里 fail 会中断构建（插件私有约束也能共享同一套报错出口）", () => {
  const root = makePlugin({
    head: "/*__LIB_SOURCE__*/\n/*__LIB_SOURCE_END__*/\n",
    libs: { a: "export const A = 1;\n" },
  });
  assert.throws(
    () =>
      run({
        root,
        libs: [{ name: "a", source: "local" }],
        extra() {
          throw new Error("插件自有的约束");
        },
      }),
    /插件自有的约束/,
  );
});
