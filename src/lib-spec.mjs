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
 * 现在每个插件根目录放一个 plugin.libs.mjs，build 与 validate 都读它：
 *
 *   export default {
 *     shared: ["feedback", "feedback-net", "feedback-ui", "dropdown"],
 *     local: ["parse", "rising"],
 *   };
 *
 * 顺序即内联顺序（有依赖的排前面）。
 */

/** 把清单归一成 buildPlugin 需要的 [{name, source}]。 */
export function toBuildLibs(spec) {
  return [
    ...(spec.shared || []).map((name) => ({ name, source: "shared" })),
    ...(spec.local || []).map((name) => ({ name, source: "local" })),
  ];
}

/**
 * 按声明的顺序校验清单本身是否自洽。
 *
 * 这里只做能静态判的事：一个名字不能既当 shared 又当 local（build 里会读到
 * 两份不同源码，产物自检必然失败，但报错会指向「不一致」而不是真实原因）。
 */
export function checkLibSpec(spec) {
  const seen = new Map();
  for (const [kind, names] of [["shared", spec.shared || []], ["local", spec.local || []]]) {
    for (const name of names) {
      if (seen.has(name)) {
        return `内联清单里 ${name} 同时出现在 ${seen.get(name)} 与 ${kind}`;
      }
      seen.set(name, kind);
    }
  }
  return null;
}
