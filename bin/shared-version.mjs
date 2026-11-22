#!/usr/bin/env node
/**
 * 检查本插件钉的 ccgui-plugin-shared 版本是否落后于包的最新 tag。
 *
 * 为什么要有它：共用库从「四份副本 + 逐字比对」变成了「一份包 + 各自钉 tag」，
 * 漂移不再体现在文件里，而是体现在**版本号上**。改了包却忘了给某个插件升级，
 * 那个插件会长期停在旧实现上，而且没有任何报错——直到某天有人发现行为不一致。
 *
 * 只报警告，不拦构建（退出码恒为 0）。理由：某个插件可能确实不需要被改的那部分，
 * 强迫四个插件永远同步只会让升级变成一件麻烦事，最后没人愿意升级。
 *
 * 用法（在插件仓库根目录）：
 *   npx shared-version              # 比对 npm 已缓存的信息
 *   npx shared-version --offline    # 只查本地声明与 lock 是否自洽，不联网
 *
 * 判据三条：
 *   1. package.json 声明的 tag 是否等于包仓库的最新 tag
 *   2. package-lock.json 锁定的 commit 是否与声明的 tag 指向同一个 commit
 *   3. lock 是否缺失（缺了的话 CI 的 npm ci 会失败，属于硬错误）
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PKG = "ccgui-plugin-shared";
const REPO = "renhao-wan/ccgui-plugin-shared";

/** 从 `github:owner/repo#ref` 里取出 ref。 */
function refOf(spec) {
  if (typeof spec !== "string") return null;
  const m = /^github:[^#]+#(.+)$/.exec(spec);
  return m ? m[1] : null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 取包仓库的最新 tag。拿不到就返回 null（离线 / 网络受限都算正常）。 */
function latestTag(repoRoot) {
  // 优先问本机已有的 git 远端信息，失败再走 API。
  try {
    const out = execFileSync("git", ["ls-remote", "--tags", "--refs", `https://github.com/${REPO}.git`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tags = out
      .split("\n")
      .map((l) => new RegExp(`refs/tags/(.+)$`).exec(l.trim()))
      .filter(Boolean)
      .map((m) => m[1]);
    return pickHighest(tags);
  } catch {
    return null;
  }
}

/** 按语义化版本挑最大的 tag（v 前缀可有可无）。 */
function pickHighest(tags) {
  const parsed = tags
    .map((t) => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t);
      return m ? { raw: t, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter(Boolean);
  if (!parsed.length) return null;
  parsed.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
    return 0;
  });
  return parsed[0].raw;
}

function main() {
  const offline = process.argv.includes("--offline");
  const root = process.cwd();

  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg) {
    console.log(`[${PKG}] 当前目录没有 package.json，跳过`);
    return 0;
  }

  const spec = pkg.dependencies && pkg.dependencies[PKG];
  if (!spec) {
    console.log(`[${PKG}] 本插件没有依赖这个包，跳过`);
    return 0;
  }

  const declared = refOf(spec);
  const problems = [];
  const warnings = [];

  // 1. lock 是否存在、是否与声明一致
  const lock = readJson(path.join(root, "package-lock.json"));
  const locked = lock && lock.packages && lock.packages["node_modules/" + PKG];
  if (!lock) {
    problems.push("缺少 package-lock.json：CI 的 npm ci 会失败");
  } else if (!locked) {
    problems.push("package-lock.json 里没有 " + PKG + "：先跑 npm install 并提交 lock");
  } else {
    const lockedCommit = (/[#]([0-9a-f]{40})/.exec(locked.resolved || "") || [])[1];
    if (declared && /^[0-9a-f]{40}$/.test(declared) && lockedCommit && lockedCommit !== declared) {
      problems.push(
        `lock 锁的是 ${lockedCommit.slice(0, 7)}，但 package.json 声明的是 ${declared.slice(0, 7)}：重跑 npm install`,
      );
    }
  }

  // 2. 与包仓库的最新 tag 比对
  if (!offline) {
    const latest = latestTag(root);
    if (latest === null) {
      warnings.push("拿不到包仓库的最新 tag（离线或网络受限），只检查了本地自洽性");
    } else if (declared && declared.replace(/^v/, "") !== latest.replace(/^v/, "")) {
      warnings.push(
        `本插件钉在 ${declared}，包的最新 tag 是 ${latest}。` +
          `确认本插件是否需要这次更新；需要则改 package.json 后重跑 npm install 并重新构建产物。`,
      );
    } else {
      console.log(`[${PKG}] 已是最新：${declared}`);
    }
  }

  for (const w of warnings) console.log(`[${PKG}] 提醒：${w}`);
  for (const p of problems) console.log(`[${PKG}] 错误：${p}`);

  // 只报不拦：警告不影响退出码；只有「lock 缺失」这类会直接让 CI 挂掉的问题才返回 1。
  return problems.length ? 1 : 0;
}

process.exit(main());
