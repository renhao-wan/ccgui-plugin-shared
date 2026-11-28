// lib-spec 的用例：库清单只有一份，来源靠自动识别。
//
// 真实事故：slash-palette 的 build.mjs 早已换成 v0.1.6，validate-manifest.mjs
// 还按 0.1.2 的目录结构 require 入口。build 与 validate 各写一份清单，
// 漂开了也没人发现——直到 validate-core 改成 `import "./dropdown.mjs"` 才炸出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLibs } from "../src/lib-spec.mjs";

/** 造一份插件根：src/lib 下的本地库 + node_modules 里的假共用包。 */
function makeRoot({ local = {}, shared = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libspec-"));
  if (Object.keys(local).length) fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  for (const [name, body] of Object.entries(local)) {
    fs.writeFileSync(path.join(root, "src", "lib", name + ".mjs"), body);
  }
  if (Object.keys(shared).length) {
    const pkgDir = path.join(root, "node_modules", "ccgui-plugin-shared");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    const exportsMap = {};
    for (const name of Object.keys(shared)) {
      fs.writeFileSync(path.join(pkgDir, "src", name + ".mjs"), shared[name]);
      exportsMap["./" + name] = "./src/" + name + ".mjs";
    }
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "ccgui-plugin-shared", version: "0.0.0", type: "module", exports: exportsMap }),
    );
  }
  return root;
}

function run(root, order) {
  try {
    return resolveLibs(order, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("按给定顺序解析，来源自动识别：先共用包，再 src/lib", () => {
  const root = makeRoot({
    local: { parse: "export const P = 1;\n" },
    shared: { feedback: "export const F = 1;\n" },
  });
  const { libs, errors } = run(root, ["parse", "feedback"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    libs.map((l) => [l.name, l.source]),
    [["parse", "local"], ["feedback", "shared"]],
  );
  assert.ok(libs[1].file.endsWith(path.join("ccgui-plugin-shared", "src", "feedback.mjs")));
});

test("顺序严格保持：内联顺序就是清单顺序（有依赖的排前面）", () => {
  // 早先的实现把 shared 全排在 local 前面，打乱了清单里写的交错顺序。
  // 结果虽然没坏（这几个库之间无依赖），但清单上写的顺序与实际产物不一致。
  const root = makeRoot({
    local: { a: "export const A = 1;\n", c: "export const C = 1;\n" },
    shared: { b: "export const B = 1;\n" },
  });
  const { libs } = run(root, ["a", "b", "c"]);
  assert.deepEqual(libs.map((l) => l.name), ["a", "b", "c"]);
});

test("两边都找不到时报错，且说明清楚找过哪两处", () => {
  const root = makeRoot({});
  const { libs, errors } = run(root, ["ghost"]);
  assert.equal(libs.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes("ghost"));
  assert.ok(errors[0].includes("src/lib/ghost.mjs"));
});

test("重名直接报错：内联两遍会让整个模块语法错误", () => {
  const root = makeRoot({ local: { a: "export const A = 1;\n" } });
  const { errors } = run(root, ["a", "a"]);
  assert.ok(errors.some((e) => e.includes("出现了两次")), errors.join("; "));
});

test("共用包与本地库同名时以共用包为准（来源不再手写，也就不会自相矛盾）", () => {
  // 旧清单要分别维护 shared / local 两份名单，同名还得额外校验。
  // 现在只有一个有序数组，来源由解析结果决定。
  const root = makeRoot({
    local: { feedback: "export const LOCAL = 1;\n" },
    shared: { feedback: "export const SHARED = 1;\n" },
  });
  const { libs, errors } = run(root, ["feedback"]);
  assert.deepEqual(errors, []);
  assert.equal(libs[0].source, "shared");
});
