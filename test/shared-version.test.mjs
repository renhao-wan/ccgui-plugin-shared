// bin/shared-version.mjs 的行为测试。
//
// 这个脚本只在「包升级了但某个插件没跟上」时才说话，平时是静默的。
// 静默的检查最容易坏掉而没人发现，所以三种判据各钉一条用例：
// 落后要提醒、lock 与声明不一致要报错、lock 缺失要报错（这条会让 CI 直接挂）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "shared-version.mjs");
const PKG = "ccgui-plugin-shared";

/** 造一个临时插件仓库，返回其根目录。 */
function fixture({ spec = "github:renhao-wan/ccgui-plugin-shared#v0.1.0", lock = true, lockedCommit, declaredCommit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-version-"));
  const deps = spec ? { [PKG]: spec } : {};
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: deps }, null, 2));
  if (lock) {
    const L = { lockfileVersion: 3, packages: {} };
    if (spec) {
      L.packages["node_modules/" + PKG] = {
        version: "0.1.0",
        resolved: `git+ssh://git@github.com/renhao-wan/ccgui-plugin-shared.git#${lockedCommit || "2c07166d87bed76bd97e80ee7f9c1f0a51d81b3b"}`,
      };
    }
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify(L, null, 2));
  }
  return dir;
}

/** 跑脚本，返回 { code, out }。默认 --offline，避免测试依赖网络。 */
function run(dir, { offline = true } = {}) {
  const args = [BIN];
  if (offline) args.push("--offline");
  try {
    const out = execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test("lock 与声明一致时静默通过", () => {
  const dir = fixture();
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0, out);
    assert.ok(!out.includes("提醒"), "不该有提醒：" + out);
    assert.ok(!out.includes("错误"), "不该有错误：" + out);
  } finally {
    cleanup(dir);
  }
});

test("lock 缺失时报错（CI 的 npm ci 会挂）", () => {
  const dir = fixture({ lock: false });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 1, "lock 缺失必须返回非零：" + out);
    assert.ok(out.includes("缺少 package-lock.json"), out);
  } finally {
    cleanup(dir);
  }
});

test("lock 锁的 commit 与声明的 commit 不一致时报错", () => {
  const declared = "2222222222222222222222222222222222222222";
  const locked = "1111111111111111111111111111111111111111";
  const dir = fixture({
    spec: `github:renhao-wan/ccgui-plugin-shared#${declared}`,
    lockedCommit: locked,
  });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 1, out);
    assert.ok(out.includes("1111111") && out.includes("2222222"), "应同时指出两边的 commit：" + out);
  } finally {
    cleanup(dir);
  }
});

test("没依赖这个包时跳过，不算错", () => {
  const dir = fixture({ spec: null });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0, out);
    assert.ok(out.includes("没有依赖"), out);
  } finally {
    cleanup(dir);
  }
});

test("锁的是 tag 名（非 commit）时不误报 commit 不一致", () => {
  // 声明写 tag、lock 里是 tag 时，无法直接比 commit，不该当成错误。
  const dir = fixture({ spec: "github:renhao-wan/ccgui-plugin-shared#v0.1.0" });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0, out);
    assert.ok(!out.includes("错误"), out);
  } finally {
    cleanup(dir);
  }
});
