/**
 * 插件自己的「内联清单」——构建与自检共用的唯一真相。
 *
 * 三个地方原先各写一份清单：
 *   - scripts/build.mjs 的 LIB_ORDER / SHARED
 *   - scripts/validate-manifest.mjs 的 LIB / SHARED_ENTRIES
 *   - package.json 依赖的版本
 * 三份之间没有任何约束，漂开了也不会有人发现。真实发生过：slash-palette 的
 * build 早已换成 v0.1.6，validate 还在按 0.1.2 的目录结构 require——直到
 * validate-core 改成 `import "./dropdown.mjs"` 才炸出来。
 *
 * 现在每个插件根目录放一个 plugin.libs.mjs，只写一个**有序**数组：
 *
 *   export default ["parse", "rising", "feedback", "feedback-ui"];
 *
 * 顺序即内联顺序，有依赖的排前面。来源不用写：先按共用包的 exports 解析，
 * 解析不到再读 src/lib/<name>.mjs。这样「哪个库来自哪里」不会和真实情况漂开，
 * 也不必维护 shared / local 两份名单（它们还得额外保证不重名）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * 归一成有序的 [{name, source, file}]。
 *
 * @param {string[]} order plugin.libs.mjs 的默认导出
 * @param {string} root 插件根目录
 * @returns {{libs:{name:string, source:"shared"|"local", file:string}[], errors:string[]}}
 */
export function resolveLibs(order, root) {
  const require = createRequire(path.join(root, "__libs__.mjs"));
  const libs = [];
  const errors = [];
  const seen = new Set();

  for (const name of order) {
    if (seen.has(name)) {
      errors.push(`内联清单里 ${name} 出现了两次`);
      continue;
    }
    seen.add(name);

    let sharedFile = null;
    try {
      sharedFile = require.resolve("ccgui-plugin-shared/" + name);
    } catch {
      // 不是共用库，往下看本地
    }
    if (sharedFile) {
      libs.push({ name, source: "shared", file: sharedFile });
      continue;
    }

    const localFile = path.join(root, "src", "lib", name + ".mjs");
    if (fs.existsSync(localFile)) {
      libs.push({ name, source: "local", file: localFile });
      continue;
    }

    errors.push(
      `读不到 ${name}：共用包 ccgui-plugin-shared 没有这个入口（先跑 npm install），` +
        `src/lib/${name}.mjs 也不存在`,
    );
  }

  return { libs, errors };
}
