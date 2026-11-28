/**
 * 自绘下拉菜单（不用原生 <select>）。
 *
 * 为什么必须自绘：Windows 下 <select> 会渲染成系统控件，和宿主完全不是一套外观。
 *
 * 为什么放进共用包：trending / worklog / leetcode 各写了一份，129 / 156 / 129 行，
 * 行为一致但细节已经漂开——trending 有 ✓ 勾选和 hover 同步焦点，worklog 用的是
 * 两套 keydown handler（菜单里方向键会失效），leetcode 用文本 "▾" 而不是 CSS 箭头。
 * 每写一个新插件就重抄一遍，所以「下拉还有问题」反复出现。
 *
 * 库只产出**结构和类名**，不产出 CSS：类名固定为 `${prefix}-dd-*`，
 * 配色由各插件自己的 token 决定（自建 token 与直接用宿主 token 两条路线并存，不强行统一）。
 * 类名清单见 DROPDOWN_CLASS_SUFFIXES，validate-core 据此检查插件有没有把 CSS 写全。
 */

/** 下拉会产出的全部类名后缀。改这里必须同步改三个插件的 CSS。 */
export const DROPDOWN_CLASS_SUFFIXES = Object.freeze([
  "trigger",
  "value",
  "caret",
  "scrim",
  "menu",
  "group",
  "item",
  "label",
  "check",
  "empty",
]);

/**
 * 浮层开合与方向。
 *
 * 向上弹的判断放在打开前做一次：菜单开着时再测，会把菜单自身的高度算进去。
 */
export function useDdPopover(R) {
  const openState = R.useState(false);
  const upState = R.useState(false);
  const triggerRef = R.useRef(null);

  /** 打开前估一下菜单高度：下方不够且上方更宽裕时向上弹，免得被视口裁掉。 */
  const openPopover = (estHeight) => {
    const el = triggerRef.current;
    let shouldUp = false;
    if (el && typeof el.getBoundingClientRect === "function" && typeof window !== "undefined") {
      const rect = el.getBoundingClientRect();
      const below = (window.innerHeight || 800) - rect.bottom;
      shouldUp = below < estHeight + 12 && rect.top > below;
    }
    upState[1](shouldUp);
    openState[1](true);
  };

  return {
    open: openState[0],
    setOpen: openState[1],
    up: upState[0],
    triggerRef,
    openPopover,
  };
}

/**
 * 造一个 Dropdown 组件。
 *
 * `getR` 是**取 React 的函数**而不是 React 本身：插件的 `appCtx` 要等 activate
 * 才赋值，顶层写 `createDropdown(appCtx.react, ...)` 拿到的是 null。
 *
 * 选项形状：`{ value, label, disabled?, title?, group? }`
 *   - `disabled` 可以是布尔值，也可以是 `isDisabled(item)` 回调——语义一样，
 *     回调那种是给「禁用条件依赖选中值或外部状态」的调用方用的。
 *   - `title` 会落到选项的 title 属性上，用于「仅名称 / 仅手动」这类
 *     不看说明就看不懂的取值。
 *   - `group` 相同的连续选项前面会插一条分组标题。
 *
 * @param {() => object} getR  返回 { useState, useRef, useEffect, createElement }
 * @param {{ prefix: string }} opts  prefix 决定类名，如 "gt" → gt-dd-trigger
 */
export function createDropdown(getR, opts) {
  const prefix = (opts && opts.prefix) || "dd";
  const base = prefix + "-dd";
  const cls = (name) => base + "-" + name;

  return function Dropdown(props) {
    const R = getR();
    const h = R.createElement;
    const { open, setOpen, up, triggerRef, openPopover } = useDdPopover(R);
    const focusState = R.useState(-1);
    const focusIdx = focusState[0];
    const setFocusIdx = focusState[1];
    const itemRefs = R.useRef([]);

    const items = Array.isArray(props.items) ? props.items : [];
    const value = props.value == null ? "" : String(props.value);
    const selectedIdx = items.findIndex((it) => String(it.value) === value);
    const selected = selectedIdx >= 0 ? items[selectedIdx] : null;
    const placeholder = props.placeholder || "请选择";

    /**
     * 统一的禁用判断。
     *
     * 组件里每个用到「这一项能不能选」的地方都走它，不要有的地方读
     * `item.disabled`、有的地方调回调——两套判断迟早分叉，表现是
     * 「灰着但能点」或「能点但方向键跳过去了」。
     */
    const disabledOf = (item) => {
      if (!item) return true;
      if (typeof props.isDisabled === "function") return Boolean(props.isDisabled(item));
      return Boolean(item.disabled);
    };

    R.useEffect(() => {
      if (!open) return;
      const el = itemRefs.current[focusIdx];
      if (el && typeof el.focus === "function") el.focus();
    }, [open, focusIdx]);

    const openMenu = () => {
      if (props.disabled || items.length === 0) return;
      let i = selectedIdx;
      if (i < 0) i = items.findIndex((it) => !disabledOf(it));
      setFocusIdx(i < 0 ? 0 : i);
      openPopover(Math.min(260, items.length * 32 + 8));
    };

    const choose = (item) => {
      if (!item || disabledOf(item)) return;
      setOpen(false);
      if (String(item.value) !== value) props.onChange(item.value);
    };

    const move = (step) => {
      if (!items.length) return;
      let i = focusIdx;
      for (let n = 0; n < items.length; n += 1) {
        i = (i + step + items.length) % items.length;
        if (!disabledOf(items[i])) break;
      }
      setFocusIdx(i);
    };

    /**
     * 键盘处理挂在**容器**上，不是 trigger 上。
     *
     * 菜单一打开，useEffect 会把焦点移到 option 上（option 带 tabIndex=-1），
     * 此后按键事件从 option 冒泡到容器。只挂在 trigger 上的话，打开之后方向键、
     * Enter 确认、Esc 关闭全部失灵——只剩鼠标能用。
     *
     * 容器与 trigger 不能各挂一个：同一事件会冒泡两遍，Enter 会触发两次 onChange。
     * 所以只有一个 handler，靠 ev.target 的 className 认来源。
     */
    const onKeyDown = (ev) => {
      if (props.disabled) return;
      // 按 className 认来源，不用 triggerRef.current：ref 在假宿主/替身里
      // 未必被赋值，一旦为 null 判断就会恒假，空格键静默失效。
      const t = ev && ev.target;
      const onTrigger = Boolean(
        t && typeof t.className === "string" && t.className.split(/\s+/).includes(cls("trigger")),
      );
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (!open) openMenu();
        else move(ev.key === "ArrowDown" ? 1 : -1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (open) choose(items[focusIdx]);
        else openMenu();
      } else if (ev.key === " ") {
        // 空格只在 trigger 上当「打开」：菜单项里按空格同理会冒泡到这里，
        // 但那是可滚动列表，别为了这个吃掉滚动键。
        if (onTrigger) {
          ev.preventDefault();
          if (open) choose(items[focusIdx]);
          else openMenu();
        }
      } else if (ev.key === "Escape" && open) {
        ev.preventDefault();
        setOpen(false);
        // 焦点回到触发器：菜单关上后焦点若还留在已卸载的 option 上，
        // 浏览器会把焦点丢回 body，接着按 Tab 就得从头走一遍整页。
        const el = triggerRef.current;
        if (el && typeof el.focus === "function") el.focus();
      } else if (ev.key === "Tab" && open) {
        // 焦点会离开这个组件；scrim 是 fixed 全屏，不关掉会留下一层看不见的
        // 遮罩继续吞点击。
        setOpen(false);
      }
    };

    const noItems = items.length === 0;

    return h(
      "div",
      {
        // className 透传：调用方常靠它做布局（`.lc-settings .lc-dd { width:100% }`）。
        className:
          base +
          (props.className ? " " + props.className : "") +
          (open ? " is-open" : "") +
          (up ? " is-up" : ""),
        onKeyDown,
      },
      h(
        "button",
        {
          type: "button",
          className: cls("trigger"),
          ref: triggerRef,
          // 没有选项时也禁用：点开一个空菜单只会让人以为坏了。
          disabled: props.disabled || noItems,
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          onClick: () => (open ? setOpen(false) : openMenu()),
        },
        h(
          "span",
          { className: cls("value") + (selected ? "" : " is-empty") },
          selected ? selected.label : noItems ? props.emptyText || "没有可选项" : placeholder,
        ),
        h("span", { className: cls("caret"), "aria-hidden": "true" }),
      ),
      open ? h("div", { className: cls("scrim"), onClick: () => setOpen(false) }) : null,
      open
        ? h(
            "div",
            { className: cls("menu"), role: "listbox" },
            items.length
              ? items.reduce((rows, item, i) => {
                  // 分组标题：只在组名变化时插一条，且不参与键盘焦点。
                  // 不用「值相同的项必然相邻」这种假设——按出现顺序判断，
                  // 调用方把同组项隔开就插两条标题，那是调用方的问题，不猜。
                  const prevGroup = i > 0 ? items[i - 1].group : undefined;
                  if (item.group && item.group !== prevGroup) {
                    rows.push(
                      h("div", { key: "g:" + item.group + ":" + i, className: cls("group") }, item.group),
                    );
                  }
                  const dis = disabledOf(item);
                  rows.push(
                    h(
                      "div",
                      {
                        // value 可能重复（不同分组的同名项），带上下标才唯一。
                        key: String(item.value) + ":" + i,
                        ref: (el) => {
                          itemRefs.current[i] = el;
                        },
                        className:
                          cls("item") +
                          (i === focusIdx ? " is-active" : "") +
                          (dis ? " is-disabled" : ""),
                        role: "option",
                        "aria-selected": String(item.value) === value,
                        "aria-disabled": dis ? true : undefined,
                        // 「仅名称 / 仅手动」这类取值，不看说明判断不了，
                        // 悬停必须给出完整含义。
                        title: item.title || undefined,
                        tabIndex: -1,
                        onClick: () => choose(item),
                        onMouseEnter: () => {
                          if (!dis) setFocusIdx(i);
                        },
                      },
                      h("span", { className: cls("label") }, item.label),
                      h("span", { className: cls("check"), "aria-hidden": "true" }, "✓"),
                    ),
                  );
                  return rows;
                }, [])
              : h("div", { className: cls("empty") }, props.emptyText || "没有可选项"),
          )
        : null,
    );
  };
}
