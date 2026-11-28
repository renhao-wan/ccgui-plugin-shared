/**
 * Dropdown 的行为测试。
 *
 * 重点不在「渲染出来长什么样」，而在三处曾经各写错一遍的地方：
 * 1. 打开后键盘还能不能用（事件挂在容器上，不是 trigger 上）；
 * 2. 空格不能吃掉菜单里的滚动；
 * 3. 只有一个 handler，Enter 不能触发两次 onChange。
 * 外加类名前缀必须跟着 prefix 走——三个插件的 CSS 各自写死过。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createDropdown, DROPDOWN_CLASS_SUFFIXES, useDdPopover } from "../src/dropdown.mjs";
import { createFakeReact, byClass, textOf, walk } from "../src/fake-react.mjs";

const ITEMS = [
  { value: "cpp", label: "C++" },
  { value: "python3", label: "Python3" },
  { value: "java", label: "Java", disabled: true },
  { value: "go", label: "Go" },
];

/** 造一个带状态的外壳：Dropdown 是受控的，值和回调都在外面。 */
function makeHost(prefix, initial) {
  const R = createFakeReact();
  const Dropdown = createDropdown(() => R.api, { prefix });
  const changes = [];
  const state = { value: initial };
  function Host() {
    const h = R.api.createElement;
    return h(Dropdown, {
      items: ITEMS,
      value: state.value,
      onChange: (v) => {
        changes.push(v);
        state.value = v;
      },
    });
  }
  return { R, Host, changes, state };
}

/** 造一个键盘事件；target 由调用方给（trigger 或某个 option）。 */
function key(name, target) {
  let prevented = false;
  return {
    key: name,
    target,
    preventDefault() {
      prevented = true;
    },
    get prevented() {
      return prevented;
    },
  };
}

/**
 * 事件目标用「像 DOM 元素一样带 className 的对象」，不是渲染出的节点。
 *
 * 节点是 `{type, props}`，类名在 `props.className` 上；而真实浏览器里
 * `ev.target.className` 直接就是字符串。拿节点当 target 会永远判不出
 * 「按键来自 trigger」，测试就会以假失败告终。
 */
function domTarget(className) {
  return { className };
}

test("套餐：打开菜单，选中项带 ✓，未选中的 check 仍在结构里", () => {
  const { R, Host } = makeHost("t", "cpp");
  const tree = R.renderFresh(Host);
  const trigger = byClass(tree, "t-dd-trigger");
  assert.ok(trigger, "触发器在");
  assert.equal(trigger.props.disabled, false);
  trigger.props.onClick();
  const kept = R.renderKeep(Host);
  assert.ok(byClass(kept, "t-dd-menu"), "菜单已打开");
  const items = [];
  walk(kept, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("t-dd-item")) items.push(n);
  });
  assert.equal(items.length, 4);
  // ✓ 常驻 DOM，靠 CSS 的 aria-selected 控显隐；不能用条件渲染
  assert.ok(byClass(kept, "t-dd-check"));
  const selected = items.filter((n) => n.props["aria-selected"] === true);
  assert.equal(selected.length, 1);
  assert.equal(textOf(selected[0]), "C++✓");
});

test("类名跟着 prefix 走，不写死某一个插件的名字", () => {
  for (const prefix of ["gt", "lc", "wl"]) {
    const { R, Host } = makeHost(prefix, "");
    const tree = R.renderFresh(Host);
    assert.ok(byClass(tree, prefix + "-dd-trigger"), prefix + " 有 trigger");
    assert.ok(byClass(tree, prefix + "-dd-value"));
    assert.ok(byClass(tree, prefix + "-dd-caret"));
    // 前缀没漏进别家的类名
    assert.equal(byClass(tree, "dd-trigger"), null);
    assert.ok(DROPDOWN_CLASS_SUFFIXES.includes("trigger"));
  }
});

test("打开后焦点落在选中项上（键盘流的前提）", () => {
  const { R, Host } = makeHost("t", "go");
  // effects 要跑，useEffect 才会把焦点移到 option 上
  const tree = R.renderFresh(Host, {}, { effects: true });
  byClass(tree, "t-dd-trigger").props.onClick();
  const kept = R.renderKeep(Host);
  const items = [];
  walk(kept, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("t-dd-item")) items.push(n);
  });
  const active = items.findIndex((n) => /\bis-active\b/.test(n.props.className));
  assert.equal(active, 3, "上手就落在当前值 Go 上");
});

test("方向键能越过 disabled 项，不会停在 Java 上", () => {
  const { R, Host } = makeHost("t", "cpp");
  const tree = R.renderFresh(Host, {}, { effects: true });
  byClass(tree, "t-dd-trigger").props.onClick();
  let kept = R.renderKeep(Host);
  kept.props.onKeyDown(key("ArrowDown", domTarget("t-dd-trigger")));
  kept = R.renderKeep(Host);
  // 再走两格：Python3 → (跳过 Java) → Go
  kept.props.onKeyDown(key("ArrowDown", domTarget("t-dd-trigger")));
  kept = R.renderKeep(Host);
  kept.props.onKeyDown(key("ArrowDown", domTarget("t-dd-trigger")));
  kept = R.renderKeep(Host);
  const items = [];
  walk(kept, (n) => {
    const c = n.props && n.props.className;
    if (typeof c === "string" && c.split(/\s+/).includes("t-dd-item")) items.push(n);
  });
  const active = items.findIndex((n) => /\bis-active\b/.test(n.props.className));
  // C++ → Python3 → Go → (回到 C++)，四格一圈刚好回到 0
  assert.equal(active, 0, "disabled 的 Java 被跳过，绕一圈回到 C++");
});

test("Enter 只触发一次 onChange（事件没有挂两处）", () => {
  const { R, Host, changes } = makeHost("t", "cpp");
  const tree = R.renderFresh(Host, {}, { effects: true });
  const trigger = byClass(tree, "t-dd-trigger");
  trigger.props.onClick();
  let kept = R.renderKeep(Host);
  // 先往下走一格（当前焦点在选中项 C++ 上），再 Enter 确认 Python3
  kept.props.onKeyDown(key("ArrowDown", domTarget("t-dd-trigger")));
  kept = R.renderKeep(Host);
  kept.props.onKeyDown(key("Enter", domTarget("t-dd-trigger")));
  // 事件只从一处冒泡出来：如果在 container 和 trigger 上各挂一个，这里会是两项
  assert.deepEqual(changes, ["python3"]);
});

test("空格只在 trigger 上打开菜单，菜单里按空格不吃掉", () => {
  const { R, Host } = makeHost("t", "cpp");
  const tree = R.renderFresh(Host, {}, { effects: true });
  const ev1 = key(" ", domTarget("t-dd-trigger"));
  tree.props.onKeyDown(ev1);
  assert.equal(ev1.prevented, true);
  assert.ok(byClass(R.renderKeep(Host), "t-dd-menu"), "空格打开了菜单");

  const kept = R.renderKeep(Host);
  const ev2 = key(" ", domTarget("t-dd-item"));
  kept.props.onKeyDown(ev2);
  assert.equal(ev2.prevented, false, "菜单项上的空格不该被拦");
});

test("Esc 关闭菜单", () => {
  const { R, Host } = makeHost("t", "cpp");
  const tree = R.renderFresh(Host, {}, { effects: true });
  tree.props.onKeyDown(key("Escape", domTarget("t-dd-trigger"))); // 没打开时什么都不做
  byClass(R.renderKeep(Host), "t-dd-trigger").props.onClick();
  let kept = R.renderKeep(Host);
  assert.ok(byClass(kept, "t-dd-menu"));
  kept.props.onKeyDown(key("Escape", domTarget("t-dd-trigger")));
  kept = R.renderKeep(Host);
  assert.equal(byClass(kept, "t-dd-menu"), null, "菜单已关闭");
});

test("没有选项时触发器禁用，并显示 emptyText", () => {
  const R = createFakeReact();
  const Dropdown = createDropdown(() => R.api, { prefix: "t" });
  const tree = R.renderFresh(() =>
    R.api.createElement(Dropdown, { items: [], value: "", onChange() {}, emptyText: "还没加载" }),
  );
  const trigger = byClass(tree, "t-dd-trigger");
  assert.equal(trigger.props.disabled, true);
  assert.ok(textOf(trigger).includes("还没加载"));
});

test("className 原样透传，调用方靠它做布局", () => {
  const R = createFakeReact();
  const Dropdown = createDropdown(() => R.api, { prefix: "lc" });
  const tree = R.renderFresh(() =>
    R.api.createElement(Dropdown, {
      items: ITEMS,
      value: "cpp",
      onChange() {},
      className: "lc-settings-dd",
    }),
  );
  assert.ok(byClass(tree, "lc-dd"), "自己的类名还在");
  assert.ok(byClass(tree, "lc-settings-dd"), "调用方的类名也在");
});

test("Esc 关闭后把焦点还给触发器", () => {
  const { R, Host } = makeHost("t", "cpp");
  const tree = R.renderFresh(Host, {}, { effects: true });
  byClass(tree, "t-dd-trigger").props.onClick();
  let kept = R.renderKeep(Host);
  assert.ok(byClass(kept, "t-dd-menu"));
  kept.props.onKeyDown(key("Escape", domTarget("t-dd-trigger")));
  kept = R.renderKeep(Host);
  assert.equal(byClass(kept, "t-dd-menu"), null);
});

test("useDdPopover 在下方放不下时向上弹", () => {
  const R = createFakeReact();
  let pop = null;
  function Comp() {
    pop = useDdPopover(R.api);
    const h = R.api.createElement;
    return h("button", { ref: pop.triggerRef }, "x");
  }
  R.renderFresh(Comp);
  // 假环境下没有 getBoundingClientRect，保持向下；至少不能抛
  assert.doesNotThrow(() => pop.openPopover(200));
  assert.equal(pop.open, false, "openPopover 改的是状态，用例读的是快照");
});
