# ccgui-plugin-shared

CC GUI 插件的共用层。四个插件（每日热点 / 工作志 / 斜杠命令面板 / CLI 安装检测）
此前各自复制同一份代码，靠 `check-feedback-sync.mjs` 检查复制品是否一致。
这个包把「复制 + 检查」换成「一份源码 + 版本号」。

## 为什么分两类引入

CC GUI 插件以单文件 ESM `main.js` 被宿主加载（ESM blob，没有文件系统路径），
**运行时的 `import` 不可用**。所以这里的模块分两种用法：

| 入口 | 用法 | 谁用 |
|---|---|---|
| `./fake-react`、`./validate-core` | 开发期真 `import` | 测试与自检脚本 |
| `./feedback`、`./feedback-net`、`./feedback-ui`、`./markdown`、`./markdown-view`、`./dropdown` | 构建期读源码内联 | 插件的 `scripts/build.mjs` |

后者在产物里不会留下任何 `import`：`build.mjs` 用 `require.resolve` 定位到
本包 `src/*.mjs` 的真实路径，读出来剥掉 `export` 与兄弟 import，拼进 `main.js`。

## 入口

```js
// 开发期工具
import { createFakeReact, walk, textOf, byClass } from "ccgui-plugin-shared/fake-react";
import { validatePlugin } from "ccgui-plugin-shared/validate-core";

// 构建期内联（插件 build.mjs 读源码，不在运行时代码里写 import）
// feedback       纯函数：正文收敛、Issue 链接、请求体白名单、额度与失败文案
// feedback-net   网络层工厂 createFeedbackNet(ctx, { endpoint, pluginId })
// feedback-ui    行为层 useFeedbackForm(R, opts) → 状态 + render(h, style)
// markdown       纯解析：parseInline / parseMarkdown
// markdown-view  渲染：markdownBlocks / inlineNodes / renderMarkdown
// dropdown       自绘下拉 createDropdown(getR, { prefix }) + useDdPopover(R)
```

### dropdown 的额外约定

`createDropdown` 只产出**结构与类名**（`${prefix}-dd-*`），**不产出 CSS**。
配色随各插件自己的 token 走，样式由插件负责；`DROPDOWN_CLASS_SUFFIXES`
是完整类名清单，`validate-core` 用它检查插件有没有把 CSS 写全。

`getR` 传的是**函数**（`() => ctx.react`）而不是 React 对象：插件的 `appCtx`
要等 activate 才赋值，顶层求值拿到的是 null。

## 内部依赖

保持单向、无环：

```
feedback-ui  → feedback
markdown-view → markdown
validate-core → dropdown（只取类名清单常量）
feedback-net → （无）
dropdown → （无）
fake-react / validate-core → （无）
```

`feedback-ui` 与 `markdown-view` 顶部各有一条指向兄弟模块的 `import`。
`build.mjs` 的 `stripLocalImports` 会把它剥掉——前提是依赖方在同一次内联里、
且顺序在前。

## 测试

```bash
npm test        # 144 条，覆盖 8 个模块
```

这些测试原来散在插件仓库里（trending 的 `test/` 下）。搬到这里之后，
共用层的改动不再需要「四个仓库各跑一遍」才知道有没有坏。

## 发版

插件用 tag 锁版本：

```json
"dependencies": { "ccgui-plugin-shared": "github:renhao-wan/ccgui-plugin-shared#v0.1.0" }
```

所以改完共用代码要：打新 tag → 四个插件升版本号 → 各自 `npm install` → 重新 build。
这是用依赖性换掉的成本：不会再出现「改了忘了同步」，代价是改动要发版。

## 隐私边界

`feedback-net` 发出的请求体只含白名单五个字段（text、pluginId、pluginVersion、
hostVersion、ts），不含工作区路径、会话内容或代码。这条由 `test/feedback-net.test.mjs`
钉死，新增字段会直接测试失败。
