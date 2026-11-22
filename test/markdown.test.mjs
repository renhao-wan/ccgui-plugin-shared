import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline } from "../src/markdown.mjs";

/** 把节点数组压成便于断言的形式。 */
const kinds = (blocks) => blocks.map((b) => b.type);

test("段落合并连续行", () => {
  const out = parseMarkdown("第一行\n第二行\n\n另一段");
  assert.deepEqual(kinds(out), ["paragraph", "paragraph"]);
  assert.equal(out[0].inlines.map((n) => n.v).join(""), "第一行 第二行");
});

test("标题按级别产出，超长的 ###### 收敛到 6", () => {
  const out = parseMarkdown("## 二级\n\n###### 六级\n\n####### 不算标题");
  assert.equal(out[0].type, "heading");
  assert.equal(out[0].level, 2);
  assert.equal(out[1].level, 6);
  assert.equal(out[2].type, "paragraph", "七个 # 不是标题");
});

test("GFM 表格：表头、对齐、行", () => {
  const md = ["| 仓库 | 方向 |", "| :--- | ---: |", "| a/b | 工具 |", "| c/d | 框架 |"].join("\n");
  const out = parseMarkdown(md);
  assert.equal(out.length, 1);
  const t = out[0];
  assert.equal(t.type, "table");
  assert.deepEqual(t.align, ["left", "right"]);
  assert.equal(t.head.length, 2);
  assert.equal(t.head[0][0].v, "仓库");
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[1][0][0].v, "c/d");
  assert.equal(t.rows[1][1][0].v, "框架");
});

test("只有表头没有分隔行时不算表格", () => {
  const out = parseMarkdown("| a | b |\n普通文字");
  assert.notEqual(out[0].type, "table");
});

test("单元格里的转义竖线不会切列", () => {
  const md = ["| a | b |", "| - | - |", "| x \\| y | z |"].join("\n");
  const t = parseMarkdown(md)[0];
  assert.equal(t.rows[0][0][0].v, "x | y");
  assert.equal(t.rows[0].length, 2);
});

test("少写的单元格按表头列数补齐，不多出列", () => {
  const md = ["| a | b | c |", "| - | - | - |", "| 1 |"].join("\n");
  const t = parseMarkdown(md)[0];
  assert.equal(t.rows[0].length, 3);
  assert.equal(t.rows[0][2][0] == null ? "" : t.rows[0][2].map((n) => n.v).join(""), "");
});

test("多写的单元格被截到表头列数", () => {
  const md = ["| a | b |", "| - | - |", "| 1 | 2 | 3 |"].join("\n");
  const t = parseMarkdown(md)[0];
  assert.equal(t.rows[0].length, 2);
});

test("无序与有序列表切换时重开列表", () => {
  const out = parseMarkdown("- a\n- b\n1. c\n2. d");
  assert.deepEqual(kinds(out), ["ul", "ol"]);
  assert.equal(out[0].items.length, 2);
  assert.equal(out[1].items.length, 2);
});

test("缩进换算成层级", () => {
  const out = parseMarkdown("- a\n  - b\n    - c");
  // 缩进变化会重开列表：各自独立一块，层级写在 items[].depth 上
  assert.equal(out[0].type, "ul");
  const depths = out.flatMap((list) => list.items.map((i) => i.depth));
  assert.deepEqual(depths, [0, 1, 2]);
});

test("代码块整体保留，含空行与围栏语言", () => {
  const out = parseMarkdown("```js\nconst a = 1;\n\nconst b = 2;\n```");
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "code");
  assert.equal(out[0].lang, "js");
  assert.equal(out[0].text, "const a = 1;\n\nconst b = 2;");
  assert.deepEqual(kinds(parseMarkdown("~~~\nx\n~~~")), ["code"]);
});

test("未闭合的代码块吃到末尾（流式中途的常见形态）", () => {
  const out = parseMarkdown("正文\n\n```\nint main()");
  assert.deepEqual(kinds(out), ["paragraph", "code"]);
  assert.equal(out[1].text, "int main()");
});

test("引用、分隔线", () => {
  const out = parseMarkdown("> 一句引用\n> 接一行\n\n---");
  assert.equal(out[0].type, "quote");
  assert.equal(out[0].inlines.map((n) => n.v).join(""), "一句引用 接一行");
  assert.equal(out[1].type, "hr");
});

test("行内：粗体优先于斜体", () => {
  const nodes = parseInline("**粗体** 和 *斜体*");
  assert.deepEqual(nodes.map((n) => n.t), ["strong", "text", "em"]);
  assert.equal(nodes[0].v, "粗体");
  assert.equal(nodes[2].v, "斜体");
});

test("行内：代码、删除线", () => {
  const nodes = parseInline("`a|b` 和 ~~删~~");
  assert.deepEqual(nodes.map((n) => n.t), ["code", "text", "del"]);
  assert.equal(nodes[0].v, "a|b", "行内代码里的竖线不参与表格切列");
});

test("行内：只放行 http(s) 链接，其他协议降级成文字", () => {
  assert.equal(parseInline("[点我](https://github.com/a/b)")[0].t, "link");
  assert.equal(parseInline("[点我](https://github.com/a/b)")[0].href, "https://github.com/a/b");
  const bad = parseInline("[点我](javascript:alert(1))");
  assert.ok(bad.every((n) => n.t !== "link"), "javascript: 不能变成链接");
  assert.equal(parseInline("[点我](file:///C:/x)")[0].t, "text");
});

test("未闭合的行内标记按原文输出，不吞字符", () => {
  const nodes = parseInline("**还没写完");
  assert.equal(nodes.map((n) => n.v).join(""), "**还没写完");
  assert.ok(nodes.every((n) => n.t === "text"));
});

test("单个星号不会被当成强调", () => {
  const nodes = parseInline("2 * 3 = 6");
  assert.ok(nodes.every((n) => n.t === "text"));
});

test("流式中途的半截表格不吞内容", () => {
  // 只到表头行：当普通段落
  const partial = parseMarkdown("### 值得看的项目\n\n| 仓库 | 方向 |");
  assert.deepEqual(kinds(partial), ["heading", "paragraph"]);
  // 表头 + 分隔行 + 只写了一行：正常渲染
  const mid = parseMarkdown("| a | b |\n| - | - |\n| 1 | 2");
  assert.equal(mid[0].type, "table");
  assert.equal(mid[0].rows.length, 1);
});

test("空输入与纯空白不抛错", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("\n\n\n"), []);
  assert.deepEqual(parseMarkdown(null), []);
  assert.deepEqual(parseInline(undefined), []);
});

test("CRLF 换行与制表符缩进都能处理", () => {
  const out = parseMarkdown("## 标题\r\n\r\n- a\r\n\t- b");
  assert.equal(out[0].type, "heading");
  assert.equal(out[1].type, "ul");
  assert.equal(out[2].items[0].depth, 1);
});

test("标题行里的行内标记也解析", () => {
  const out = parseMarkdown("### 今天在热 `Rust`");
  assert.equal(out[0].type, "heading");
  assert.ok(out[0].inlines.some((n) => n.t === "code" && n.v === "Rust"));
});

test("粗体里包行内代码时反引号不残留", () => {
  // 模型很爱写 **`owner/repo`**：外层粗体，内层行内代码
  const nodes = parseInline("最值得看的是 **`jingyaogong/minimind`** 这个");
  const strong = nodes.find((n) => n.t === "strong");
  assert.ok(strong, "应该有一个 strong 节点");
  assert.equal(strong.children.length, 1);
  assert.equal(strong.children[0].t, "code");
  assert.equal(strong.children[0].v, "jingyaogong/minimind");
  // 外层不能残留字面量星号或反引号
  assert.ok(!nodes.some((n) => n.t === "text" && n.v.includes("**")));
  assert.ok(!nodes.some((n) => n.t === "text" && n.v.includes("`")));
});

test("删除线里包行内代码同样递归解析", () => {
  const nodes = parseInline("~~`old-api`~~ 已被移除");
  const del = nodes.find((n) => n.t === "del");
  assert.ok(del, "应该有一个 del 节点");
  assert.equal(del.children[0].t, "code");
  assert.equal(del.children[0].v, "old-api");
});

test("强调标记不跨行，流式中途的半截行不会吃掉下一行", () => {
  const nodes = parseInline("**第一行\n第二行**");
  assert.ok(nodes.every((n) => n.t === "text"));
  assert.equal(nodes.map((n) => n.v).join(""), "**第一行\n第二行**");
});

test("表格单元格里的行内标记也会解析", () => {
  const out = parseMarkdown("| 仓库 | 方向 |\n| --- | --- |\n| **`a/b`** | 框架 |");
  const cell = out[0].rows[0][0];
  assert.equal(cell[0].t, "strong");
  assert.equal(cell[0].children[0].t, "code");
  assert.equal(cell[0].children[0].v, "a/b");
});
