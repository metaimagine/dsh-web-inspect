# dsh-web-inspect 方案（PLAN）

一句话：给右侧栏的 HTML 预览加一个「检查元素」开关——悬停高亮、点击选中，把元素的上下文以 Markdown 块**插入当前会话输入框（不发送）**。

## 关键前置事实（已侦察，带证据）

内置 HTML 预览（`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`）两种模式**都是 opaque origin**：

- 静态模式：`jsx("iframe", { srcDoc: html, sandbox: "" , ... })` —— 空 sandbox，`contentDocument === null`；
- 交互模式：`jsx("iframe", { src: frame.url /* Blob URL */, sandbox: "allow-scripts", ... })` —— 无 `allow-same-origin`，同样拿不到 `contentDocument`，且源码注释明说 “A fixed bootstrap runs inside the opaque iframe; no Host callbacks enter its document.”
- iframe 的 `name` 是 `dsh-sidebar-html-<tab-id>`，父页面只能拿 `window.frames[name]` 这个 WindowProxy，跨源后 DOM 不可读。

结论：**hook 内置 iframe 是死路**。不走它。

## ① 怎么拿到当前激活预览 tab 的 iframe

不拿内置的，**换掉渲染器**：`ctx.documentPreviews.register({ id: "dsh-web-inspect/html", extensions: ["html","htm"], priority: "extension", loading: "bytes-complete", wrap: false, title: () => t("title") })`。注册表规则是 “External implementations win over product implementations; defaults to extension”，内置 HTML 是 `priority: "builtin"`，所以我们的 renderer 在 `.html/.htm` 上胜出（同前缀再比注册顺序，不影响结果）。

正文通过 keyed slot 挂到 `sidebar.right.tab.document`（key = 上面的 renderer id），组件拿到 `content: {kind:'bytes', data}` 与 `resourceAddress`，自己 `new TextDecoder().decode(data)` 建 `<iframe srcDoc={...} sandbox="allow-scripts">`。开关按钮仍按要求放在 `sidebar.right.tab.document.actions`（owner prop `absolutePath`）。

**为什么不再用同源 iframe**（发布前安全收紧，2026-11-22 修订）：`srcdoc + allow-same-origin` 会让被预览的任意 HTML 与 DSH 同源——它能读父页面 DOM、拿会话数据、调本地 API。发布版本改成 **`sandbox="allow-scripts"`（opaque origin）**：页面脚本照常跑，但 `iframe.contentDocument === null`，父窗口不读子 DOM；页面里也读不到 `parent.document`。检查器改为**注入文档内部的运行时**（见 ②）。

## ② 怎么在 iframe 内注入 overlay（opaque-origin 版）

父窗口拼 `srcdoc` 时把一段**自包含运行时脚本**插到文档最前面：
`<script data-dsh-web-inspect-runtime="1">(function(){…})();</script>`。
注入点兼容四种文档：有 `<head>` 插到 `<head>` 后；只有 `<html>` 插到它后面；以 doctype 开头插到 doctype 后；否则直接前置。运行时脚本 `toString()` 后内联，零依赖、不引用父作用域。

运行时（在 iframe 内、与父窗口仅靠 `postMessage` 通信）：

1. 启动即向父窗口 `postMessage({source:"dsh-web-inspect", type:"ready"})`（带 350ms×10 重试，处理父窗口 listener 尚未挂好的时序；父窗口收到后回发当前模式 `enable`/`disable`）。
2. `enable` 时注入 `<style data-dsh-web-inspect>` 与两个 `position:fixed; pointer-events:none` 层——高亮框（outline）与 tooltip（标签/尺寸），捕获阶段监听 `mousemove`（`event.target` 命中，忽略自己的层）、`click`（`preventDefault + stopPropagation` 定格）、`scroll`/`resize`（重算）、`keydown Escape`（回传 `exit`）。
3. 点击后运行时自己算完整上下文（选择器、签名、文本、rect、非默认样式、padding/margin、`data-*`/`aria-*` 线索、定位祖先、祖先链、outerHTML），`postMessage({type:"select", payload})` 给父窗口。父窗口只做「格式化 Markdown → 插入 chip」。
4. `disable` 时移除样式/两层/监听，恢复光标与页面原有交互。
5. 页面 CSP 禁止内联脚本时运行时不会 `ready`；父窗口 2.5s 超时后在状态条提示「该页面的 CSP 或脚本策略阻止了检查脚本」，不静默失败。
6. 父窗口**完全不触碰 `contentDocument`**；`iframe` 的 `sandbox` 恰好是 `allow-scripts`。

## ③ 元素 → 上下文算法

1. **唯一性校验的 CSS 选择器路径**：从元素向上到 `body`，每段优先 `#id`（唯一）、否则 `tag:nth-of-type(n)`；拼好后 `doc.querySelectorAll(path).length === 1` 才用，否则退回完整路径再校验。
2. `tag#id.class` 摘要 + 命中属性（`data-*`、`aria-*`、`src/href/alt`）。
3. 文本片段：`textContent.trim().replace(/\s+/g," ")` 截 80 字。
4. 盒子：`getBoundingClientRect` 的 `w×h` + 计算样式的 `padding/margin`（只输出非 0）。
5. 关键计算样式白名单 `display/position/color/background-color/font-size/font-weight/z-index/overflow/border-radius`，**与元素默认值比较，仅输出非默认值**（默认值用同 tag 的 `doc.createElement(tag)` 采样或内置表）。
6. 最近线索：`data-*`、class 列表、内联 `style`、相邻定位祖先（`position` 非 static 的最近祖先选择器）。

## ④ 怎么插进输入框（原子 chip 版）

`sidebar.right.tab.document` 是 **session 作用域** slot，组件标准 props 里直接带 `inputActions`（`InputActions`）和 `sessionId`（conversation 包 `uiSession.provide` 注入；证据：`dsh-client-ui-conversation/lib/client.js:22775-22794`、`dsh-client-ui-session/lib/client.js:1028-1047`）。但 `InputActions` **没有** `insertReference`；带它的是 `SessionInput`（`ctx.sessions.scope(id).get("conversation").input.for(scope)`）。

选 **reference chip**（官方引用文本同款原子节点）：

1. 插入：`input.insertReference({source:"inspect", ref, label, appearance:"file", clipboardText: label}, props.inputActions.captureInsertion())`；失败重取 span 重试一次。输入框里只出现一个 chip，文案 = 短标签（`<h1#doc-title>`，≤24 字符）。
2. 模型侧：注册 `ctx.inputTriggers.registerSource({trigger:"@", name:"inspect", codec:{clipboardText(ref), serialize(ref)}})`。`ref` 自带完整 Markdown（`dsh-web-inspect:v1:` + base64url(JSON{markdown,label})），提交时 host 调 `codec.serialize` 把整段展开进 prompt；没有 codec 时 host 会**拒绝发送**（不是静默降级），所以 chip 一定带得出完整上下文。
3. 展开查看：`openReference` 回调按 ref 解码，在父页面弹 popover 显示完整内容（selector + html + 样式）。
4. 持久化：`appearance` 用合法枚举值 `file`（持久化 zod enum 只允许 `session|file|folder`，自定义值不保证还原）；chip 的视觉区分用 `[data-composer-input] [title^="<"]` 这个 CSS 前缀选择器（不侵入官方组件）。
5. 失败降级链：`insertReference` 不可用 → 官方 quote chip（`inputActions.insertQuote`，勾选文本同款，提交自动展开）→ 纯文本（`insertText` + 段落分隔）→ host `requestDraftInitialization` → 剪贴板。**任何路径都不调用 `submit()`。**

**为什么不直接平铺 Markdown**：用户要的交互是「输入框里一个标识，点开看全文」。reference chip 是官方唯一支持“折叠显示 + 提交时展开成完整文本”的原子节点；`insertText` 只能平铺，`insertQuote` 会把 ```html 围栏逐行加 `> ` 破坏格式。

## ⑤ 发送后的气泡也折叠（UserText rule，2026-11-22 追加）

问题：chip 的 `clipboardText` 就是消息正文；发送时引用被序列化成纯文本，所以气泡里是整段
Markdown。修的是**气泡渲染**（官方「引用文本」同款接缝），不是插入：

1. 发送时 `codec.serialize` 返回 `> 选中元素：…（首行，保持会话标题可读）\n<!--dsh-web-inspect:v1-->\n<完整 Markdown>\n<!--/dsh-web-inspect-->`
   （HTML 注释哨兵夹住正文；模型仍收到完整可读内容，渲染时不可见；首行不是注释，避免会话标题被 `<!--` 污染）。
2. `ctx.uiConversation.userText.register({id:"dsh-web-inspect", order:-20, match(text, from)})`：
   正向扫描原文，命中哨兵块（或旧格式 `> 选中元素：` … `（在这里补充…）` 块）返回
   `{id, start, end, data:{label, markdown}}`；块前后 `\n\n` 返回 `text` 节点并 `display:" "`，
   避免气泡里多出空行。**order 必须是 -20**：可读首行让我们的候选与官方
   `dsh-message-quotes` 的 `quoteRule`（order -10）在 start=0 平局，host
   `UserTextDocument.reconcile` 按 order 升序先到先得——order 20 时前 38 字符会被 quote
   节点吞掉、气泡退化成「quote + 原始文本」；改成 -20 后整块折叠，普通 `>` 引用不受影响。
3. `ctx.slots.inject("conversation.user.text.node", … register({name, key:"dsh-web-inspect", priority:100}))`
   渲染 `InspectUserText`：气泡里是蓝色 chip（`<h1#doc-title>`），点击复用父页面 popover
   展示完整 Markdown。
4. 证据链：`dsh-message-quotes/lib/client.js` 的 `quoteRule` + `QuotedUserText` 是本接缝的
   官方先例；旧消息（无哨兵）也会被同一条 rule 折叠。普通文本 / 官方 `>` 引用不在匹配范围。
5. 实测：`node tools/e2e.mjs` 28/28 PASS（真发一条消息后断言气泡只有 1 个 chip、无 Markdown/
   哨兵泄漏、点击弹层 230 字符、会话标题可读；plain 与官方 `>` 引用回归通过），
   记录见 `docs/notes/chip-bubble-verify.md`。

## 插入格式（MVP）

输入框里（可见）只有一个 chip：`<h1#doc-title>`。点击 chip 弹出的完整上下文 / 发送后模型收到的内容：

```
> 选中元素：<selector>（<tag#id.class>，<w>×<h>）

```html
<该元素 outerHTML，≤40 行>
```

- 文本：「…」
- 样式：display:flex; color:#111; …
- 线索：data-testid="x" class="a b" style="…"

（在这里补充你要对这块 HTML 做的修改）
```

## 验收 / 风险

- A 文档（本文件）；B lib 实现；C link 进 `~/.dsh/profiles/web` 后真机验证（开关 → 悬停 → 点击 → 输入框出现 Markdown）。
- 风险：只对“我们自己渲染的 .html/.htm 预览”生效（内置预览 hook 不到，属已证实的技术限制，写进 README）；`srcdoc` 无 base URL，预览里相对路径的图片/样式可能加载不出来（MVP 限制）；**被预览 HTML 的脚本在 opaque-origin iframe 中运行，无法访问父页面/会话/API**（发布前已收紧，见 ②）；页面 CSP 禁止内联脚本时无法检查（状态条提示）；`appearance` 只能用宿主枚举值 `file`（自定义值会让宿主丢草稿）。

## ⑥ 发布前整理（2026-11-22 追加）

- 最终名 `dsh-web-inspect`（`dsh-inspect` 在 npm 被占名，`dsh-element-inspect` 为中间版本名）；旧标识兼容：两代旧哨兵 `<!--dsh-inspect:v1-->`、`<!--dsh-element-inspect:v1-->` 仍然折叠，两代旧 chip ref 前缀 `dsh-inspect:v1:`、`dsh-element-inspect:v1:` 仍然解码。
- 安全模型：`sandbox="allow-scripts"` + 注入式运行时 + `postMessage`（见 ②），不再使用 `allow-same-origin`。
- 发布物料：`LICENSE`（MIT）、`.gitignore`、README 顶部三种安装方式 + `assets/shot-sent-bubble.png` 截图、`npm pack` 双产物（`dsh-web-inspect-0.1.0.tgz` 与不带版本号的 `dsh-web-inspect.tgz`）。
- 回归：`node tools/e2e.mjs` 断言不透明源、`postMessage` 链路、chip/气泡折叠、模型侧完整与 plain/quote 回归。
