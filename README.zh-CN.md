# dsh-web-inspect

[English](./README.md) | **中文**

<p align="center"><strong>给 DSH 右侧栏 HTML 预览用的元素检查器。</strong><br/>
<em>直接指给模型看「这个元素」，不用手抄 CSS。</em></p>

<p align="center"><sub>悬停高亮 · 单击选中 · 折叠引用块进输入框 · 不透明源沙箱</sub></p>

![点开检查元素 → 悬停描边 → 单击 → 输入框出现折叠引用 chip](assets/demo.gif)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-web-inspect"><img src="https://img.shields.io/npm/v/dsh-web-inspect.svg?style=flat-square" alt="npm version"></a>
  <a href="https://github.com/metaimagine/dsh-web-inspect/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/dsh-web-inspect.svg?style=flat-square" alt="license"></a>
  <a href="https://github.com/metaimagine/dsh-web-inspect"><img src="https://img.shields.io/badge/GitHub-metaimagine%2Fdsh--web--inspect-181717?style=flat-square&logo=github" alt="GitHub"></a>
  <img src="https://img.shields.io/badge/DSH-Web%20plugin-4B6BFF?style=flat-square" alt="DSH Web plugin">
  <img src="https://img.shields.io/badge/e2e-31%20checks%20passing-brightgreen?style=flat-square" alt="e2e checks">
</p>

<p align="center">
<code>dsh plugin --profile web add dsh-web-inspect</code>
</p>

`dsh-web-inspect` 是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web 客户端插件。
在右侧栏预览 HTML 文件时打开「检查元素」：鼠标悬停的节点会被描边，并显示 `tag#id.class 宽×高`
的提示；单击即可把该元素的上下文以**一个折叠引用块**插入当前会话输入框——交互感与官方「引用文本」一致，
但不会替你发送。消息发出时，模型收到的仍是完整 Markdown 上下文（选择器、HTML、计算样式、文本、定位祖先）。

## 为什么需要它

你正看着 HTML 预览，想让它改一块区域：

> 「把**这张卡片**的圆角加大、背景调亮一点，12px 内边距保持不变。」

用文字描述意味着要手抄选择器和计算样式——慢，还容易错。如果你用过 Chrome DevTools 的「检查元素」选取器，
这里就是同一个手势，只是指向你的 AI 会话：点了就指到了。模型拿到的是你指的那个节点（选择器、HTML、
非默认计算样式、`data-*` 线索、尺寸），你只需要补一句意图。

- **元素级指代**：指的不是「这个文件」，而是渲染结果里的具体节点。
- **输入框保持干净**：显示一个 chip（如 `<h1>`），而不是一屏 Markdown。
- **不会自动发送**：chip 只落在输入框里，你确认、补充意图，再按发送。
- **预览始终在沙箱里**：页面被放在不透明源 iframe 中渲染，被检查的 HTML 读不到你的 DSH 会话、
  cookie、localStorage 或应用 DOM。

## 工作原理

```text
┌─────────────── DSH Web 应用（你的会话） ─────────────────┐
│  右侧栏                                                   │
│  ┌─ 文档预览（本插件接管的渲染器）─────────────────────┐  │
│  │  ┌─ iframe sandbox="allow-scripts"（不透明源）──┐  │  │
│  │  │  你的 HTML + 注入的检查器 runtime            │  │  │
│  │  │  悬停描边 · tooltip · 点击捕获               │  │  │
│  │  └─────────────────┬────────────────────────────┘  │  │
│  │        postMessage │ ready / select / exit         │  │
│  └────────────────────┼───────────────────────────────┘  │
│   父窗口：生成 Markdown → 插入引用 chip                    │
│   输入框： [<h1#doc-title>]  ← 你补意图，再发送            │
└───────────────────────────────────────────────────────────┘
```

1. **接管渲染器**：以 `priority: "extension"` 注册 HTML 渲染器，优先级高于内置 `.html` / `.htm`
   预览器。新打开的预览 tab 走本插件；tab 头部会多一个「检查元素」开关。
2. **不透明源预览**：文档挂在一个 sandbox 恰为 `allow-scripts`（没有 `allow-same-origin`）的 iframe 中。
   检查器 runtime 被注入 srcdoc 文档（兼容有无 `<head>`、带 `<base>`、只有 doctype 的页面）。
3. **只走 postMessage**：runtime 在 iframe 内绘制 overlay，把选中的元素以 JSON 通过 `postMessage` 上报；
   父窗口从不读取 `contentDocument`（实测为 `null`，双向访问都抛 `SecurityError`）。父窗口只负责
   生成 Markdown、插入 chip，且从不 submit。

## 安装

需要 DSH Web profile（`~/.dsh/profiles/web`），三种方式任选：

```bash
# 1) npm
dsh plugin --profile web add dsh-web-inspect

# 2) 直接从 GitHub 安装
dsh plugin --profile web add https://github.com/metaimagine/dsh-web-inspect

# 3) 本地开发：link 本仓库
dsh plugin --profile web add "link:/path/to/dsh-web-inspect"
```

安装后**刷新页面**即可——不需要重启 `dsh web`（profile 会实时重组，客户端 bundle 带新 rev 加载）。
安装前已经打开的预览 tab 需要关掉重开，插件渲染器才会接管。

确认已加载：

```bash
dsh plugin --profile web list   # 或：ls ~/.dsh/profiles/web/node_modules | grep dsh-web-inspect
```

## 快速上手

1. 在右侧栏打开一个 HTML 文件（工作区文件树 → 点文件）。
2. 点预览 tab 头部的「检查元素」。
3. 在页面上悬停：元素被描边，并显示 `tag#id.class 618×48` 提示
   （尺寸是元素当前实际渲染的盒子，随视口宽度变化）。
4. 单击：输入框出现类似 `<div.topbar>` 的 chip（未发送）。
5. 点 chip 可查看完整上下文；按 `Esc` 退出检查模式。
6. 用自然语言补一句意图，然后发送。气泡里仍是一个折叠 chip，模型收到完整上下文。

<p align="center">
<img src="assets/howto.png?v=20261123" alt="带批注的操作示意：① 预览头部「检查元素」开关、② 悬停元素时的描边与 div.topbar 618×48 提示、③ 输入框里那个折叠的 div.topbar 引用块" width="1100">
</p>

<p align="center"><sub>① 点右上角「检查元素」 · ② 悬停定位：元素被描边，tooltip 显示 <code>tag#id.class W×H</code>（尺寸是实测盒子，随视口宽度变化） · ③ 单击一次，输入框里就多一个折叠引用块；模型侧收到的仍是完整上下文。</sub></p>

## 何时使用这个插件

同时满足以下条件时使用：

- 用户指的是**右侧栏已预览的 HTML 页面里的某个具体元素**（这个按钮、这个卡片、这个 div）；
- 下一步需要这个元素的**身份或外观信息**：CSS 选择器、HTML 片段、渲染尺寸、计算样式、`data-*` 线索；
- 目标是**描述或修改这个元素**（改大小、改颜色、挪位置、调样式），而不是整页。

Agent 工作流示例：

1. 用户（预览开着）说「把这个按钮改大一点、圆角大一点」；
2. agent 判断需要该元素的选择器与样式，而不是一句文字描述；
3. agent 打开「检查元素」→ 单击元素 → 输入框出现折叠引用块（由用户确认后发送）；
4. 模型收到选择器 + HTML + 非默认样式，精确改文件。

### 各种说法对照（agent 检索用）

| 英文说法 | 中文说法 | 本插件做什么 |
| --- | --- | --- |
| inspect element, element picker, DOM inspector, devtools picker | 检查元素、元素选择器、拾取元素、拾取页面元素 | 进入页面元素拾取模式 |
| pick element, select element, point at element | 定位元素、选元素、选中页面元素 | 悬停高亮，单击选中 |
| CSS selector, element context, extract styles, computed styles | 拿到选择器、提取样式、元素上下文、计算样式 | 把选择器 + HTML + 非默认样式插入会话 |
| restyle this div, change this card, tweak this button | 改某个 div、改这个卡片、改这个按钮 | 给 agent 精确节点，而不是文字描述 |
| in-app devtools, preview inspector | 内置开发者工具、预览调试 | 与 Chrome DevTools 的检查元素拾取同款手势 |

## 何时不该用

- **整页工作**（「把页面改成响应式」「重做 header」）——用 `@` 引用文件；元素上下文只会增加噪音。
- **跑测试 / 构建 / 启动应用**——用终端或工作工具，不是本插件。
- **非 HTML 预览**（Markdown、PDF、图片、代码视图）——本插件只接管 `.html` / `.htm` 预览。
- **只想引用一段对话文本**——用官方「引用文本」。
- **调试 JS 运行时**（console / network / performance）——本插件只报告 DOM/CSS，不报告执行状态。

## 机器可读文档（给 agent）

agent 可直接抓取这些文件，不必解析本页：

| 文件 | 给 agent 什么 |
| --- | --- |
| [llms.txt](https://raw.githubusercontent.com/metaimagine/dsh-web-inspect/main/llms.txt) | 一页纯文本能力与用法摘要 |
| [docs/capabilities.json](https://raw.githubusercontent.com/metaimagine/dsh-web-inspect/main/docs/capabilities.json) | 结构化能力卡：触发词、输入/输出、安装、依赖 |
| `npm view dsh-web-inspect description keywords` | 包元数据 |

上面的「何时使用 / 何时不该用」就是给 agent 的工具选择提示词片段，可直接复制。

## 案例

### 1. 「把设计稿里的这个开关改一下」

演示页面是 `fixtures/apple-square.html`（一个圆角/方角形态研究）。悬停 `圆角` 开关 → 提示
`button#shape-round 44×30`；单击，输入框出现一个 chip；点开 chip 就能看到模型将收到的内容：

````text
> Selected element: #shape-round (button#shape-round, 44×30)

```html
<button id="shape-round" aria-pressed="false">圆角</button>
```

- Text: 「圆角」
- Styles: display: block; color: rgb(117, 133, 137); background-color: rgb(237, 242, 242); font-size: 10px; font-weight: 600; padding: 0px 12px 0px 12px
- Clues: `aria-pressed="false"`
- Positioned ancestor: `body > header:nth-of-type(1)` (position: relative)
- Source: /Users/you/Projects/design/apple-square.html

(Add what you want changed about this element here)
````

上面这段就是**插入到输入框里的原文**（未发送前可以随意改）。它固定是英文：读这段的是模型，不是你；
元素自身的文案（`圆角`）按页面原样保留。`- Source:` 给出被预览文件的绝对路径（预览的是 http(s)
页面时改为 `- URL:`），模型不用猜这段 HTML 出自哪个文件。

### 2. 「这个按钮为什么长这样？」

提示里已经有标签、id 与渲染尺寸（`44×30`）；插入的上下文还带着计算后的 `padding`、`font-size`、
`font-weight`、`background-color` 和 `aria-pressed` 线索，模型不用重读整页就能改这个按钮。

### 3. 发一次，对话仍然清爽

点击 → 放入 chip → 发送。会话里只有一个折叠 chip，而不是一整段 Markdown；会话标题也保持人读
（`> Selected element: #shape-round (…`）。同时模型仍收到完整的选择器、HTML、尺寸、样式与来源路径。

## 与相关功能的边界

| 需求 | 用什么 |
| --- | --- |
| 指代 HTML 预览里渲染出的**某个元素** | **dsh-web-inspect** |
| 引用对话消息里的一段文本 | 官方「引用文本」 |
| 按路径引用**文件** | 官方 `@` 文件引用 |

三者互不干扰：官方引用气泡、`@` 引用都不受影响，检查器 chip 可以和它们出现在同一条消息里。

## FAQ

**安装或更新后需要重启 `dsh web` 吗？**
不需要。profile 会自动重组，刷新页面即可加载新的客户端 bundle。只有 host 侧插件才需要重启——本插件的
host 半边是空的 `apply()`。

**装了但预览还是老样子？**
安装前已经打开的预览 tab 会保持原来的渲染器。关掉重开该 tab（或重新打开文件）即可；如果 profile 是在
页面打开期间重组的，硬刷新一次页面。

**页面有严格 CSP 会怎样？**
检查器脚本是内联注入预览文档的。如果页面的 CSP 禁止内联脚本（`script-src` 不含 `'unsafe-inline'`），
runtime 无法启动，状态条会提示该文件无法检查；预览本身仍正常渲染。这是浏览器层面的限制。

**被检查的 HTML 能读到我的会话、cookie 或剪贴板吗？**
不能。iframe 是不透明源（`sandbox="allow-scripts"`，没有 `allow-same-origin`），页面脚本无法访问 DSH
应用的 DOM、cookie、localStorage 或会话 API；父窗口也读不到 iframe 的 DOM，双方只通过 `postMessage`
单向传 JSON。

**它会自动发送吗？**
不会。选中元素只是往输入框插入一个引用 chip，只有你按发送按钮才会发出。

**能检查 Markdown、图片或其它预览吗？**
不能——渲染器只接管 `.html` / `.htm` 文档预览，其它预览类型不受影响。

**支持哪些 DSH 版本？**
在 DSH Web `0.2.2-rc.1` + Chrome 157 上做过端到端验证（headless E2E，31 项检查）。插件使用的是公开的
客户端扩展点（`documentPreviews`、slots、`inputTriggers`、`uiConversation`），其它版本理论上可用但未验证。

**相对路径的 `<script src>` / `<link>` 资源能加载吗？**
预览渲染的是隔离的 srcdoc 文档，不会从工作区取相对资源。自包含 HTML（内联脚本/样式、`data:` URI）可以完整
渲染；外部 URL 在页面允许时会加载。内置 DSH 预览器会把部分相对资源打包进 blob——本插件不做这件事。

## 已知限制

- **客户端特性**：折叠 chip 依赖本插件在 DSH Web 客户端里；消息原文仍带一段哨兵注释
  （`<!--dsh-web-inspect:v1-->` … `<!--/dsh-web-inspect-->`），其它客户端会把它当不可见注释显示，
  Markdown 文本仍然可读。
- **不透明源**：检查依赖同文档 runtime；禁止内联脚本的页面无法检查（见 FAQ）。
- **相对资源**不解析（自包含 HTML 体验最好）。
- **iframe 与 Shadow DOM**：不遍历嵌套的跨源 iframe 与 shadow root，选中的是顶层 frame/宿主元素。
- **选择器来自当前 DOM**（`#id` 或带唯一性校验的 `tag:nth-of-type` 路径）：上下文描述的是**当前渲染**
  的节点；动态重排的页面之后可能得到不同路径。
- **chip 标签最长 24 字符**（如 `<h1>`），过长的 id/class 会以 `…` 截断。
- **插件被禁用时**：已经含有检查器 chip 的草稿无法发送（host 拒绝序列化未知引用），重新启用或删掉 chip 即可。
- **向后兼容**：本插件更早版本发出的消息（旧哨兵名/旧前缀）仍会折叠成 chip。

## 开发

```bash
# 引擎自检（纯 DOM helpers + fixtures）
node tests/run-engine-selftest.mjs

# 完整真实浏览器 E2E：自签 auth cookie、临时 headless Chrome、原生 CDP
# （31 项：不透明源契约、postMessage 链路、悬停/选中、chip 插入、真发消息、
#   气泡折叠、旧格式兼容、普通文本/官方引用回归、console 干净）
node tools/e2e.mjs

# 只验安全链路、不真发消息
node tools/e2e.mjs --no-live-send

# 从 fixtures/apple-square.html 重新生成两张 README 特写
# （独立驱动脚本，不用 E2E harness：右侧面板局部特写 + 输入框/气泡拼图；
#   左侧边栏不入画，面包屑路径在截图时脱敏）
node tools/shots.mjs
```

配图检查清单与脱敏步骤：[`docs/notes/screenshot-redaction.md`](./docs/notes/screenshot-redaction.md)。

没有 bundler，也没有 JSX：浏览器半边是单个自包含 `lib/client.js`，通过
`window.__ModuleLoader__.load` 加载；host 半边是空的 `apply()`。

仓库结构：

```text
lib/client.js        浏览器半边：接管渲染器、注入 runtime、slots、chip、气泡折叠
lib/index.js         host 半边（空 apply）
llms.txt             给 AI agent 的一页纯文本能力摘要
docs/capabilities.json 结构化能力卡：触发词、输出、依赖
docs/PLAN.md         设计记录（中文）
docs/notes/*.md      验证记录：安装/认证、沙箱契约、chip/气泡、API 调研（中文）
tools/e2e.mjs        端到端 harness（原生 CDP，零 npm 依赖）
fixtures/            演示 HTML（apple-square.html 用于截图/E2E；inspect-demo.html 用于旧断言）
```

插件没有 host 路由、不存持久状态。安装细节、测试 harness 的认证方式、安全模型的实测数据都在
[`docs/notes/`](./docs/notes/)（中文）。

## License

MIT © 2026 [metaimagine](https://github.com/metaimagine)

如果这个插件对你有用，欢迎在 [GitHub](https://github.com/metaimagine/dsh-web-inspect) 点个 ⭐，也更容易让别人搜到。
