# dsh-web-inspect — 实机 E2E 复验（第二轮，独立链路）

Verified live on **2026-11-22** against the running GUI at <http://127.0.0.1:3080>
(app `0.2.2-rc.1`, plugin boot bundle rev **`866f7bed6135`** read from `window.__DSH_BOOT__.entries`;
headless Chrome `157.0.8103.79` via CDP `:9444`, profile `/tmp/dsh-web-inspect-chrome2`,
viewport 1440×900 — 截图内容区 1440×813；`dsh web` 服务全程未重启）。

状态：**PASS — 23 项断言全通过（`SUMMARY: 23 passed, 0 failed, 24 checks`），连续 4 次运行一致，页面无未捕获错误。**
覆盖任务要求的 (a) 检查元素按钮存在 → (b) 同源 iframe + overlay 注入 → (c) hover outline+tooltip →
(d) 点击后 Markdown 进入 composer 草稿且**不自动发送** → (e) 截图证据。

- Harness（零 npm 依赖，raw CDP + Node 24 全局 WebSocket）：
  [`tests/screens/second/harness/live-e2e.mjs`](../../tests/screens/second/harness/live-e2e.mjs)
  （+ 同目录 `cdp.mjs`）。
- 复现命令：`node tests/screens/second/harness/live-e2e.mjs`（约 35 s；exit 0=PASS / 1=FAIL）。
  前置：3080 上的 `dsh web` 在跑、插件已装入 `~/.dsh/profiles/web`、`~/.dsh/.credentials.yaml` 可读。
- 证据：`tests/screens/second/live-e2e.log`、`live-report.json`（每步断言明细）、7 张截图（见 §4）。

---

## 1. 鉴权与打开 GUI

- 未带 cookie 的 `curl http://127.0.0.1:3080/` → 401（鉴权墙存在）。
- Harness 从 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` 记录取持久化 secret，
  自签 `dsh-auth-<b64url(sha256(127.0.0.1:3080))>` cookie（`v1.<body>.<HMAC>`），
  经 CDP `Network.setCookie` 注入后 `Page.navigate` 到 `/`，等待 `[data-composer-input]` 出现。
- 每次运行前对 `http://127.0.0.1:3080` 执行 `Storage.clearDataForOrigin {storageTypes:"local_storage"}`
  清掉上轮 UI 状态（否则右侧栏会以“已展开”状态恢复，见 §5），auth cookie 不受影响。

## 2. 逐步骤结果

| # | 步骤 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | GUI 打开 + 插件 boot 条目 | PASS | `entries=87`，`url=plugins/??dsh-web-inspect/client.js&rev=866f7bed6135`，`style[data-plugin="dsh-web-inspect"]` 存在 |
| 2 | 工作区 = dsh-web-inspect-plugin | PASS | `button[aria-label="选择工作区"]` chip 文本 |
| 3a | 右侧栏展开按钮可定位 | PASS | `button[data-sidebar-right-expand=true]` rect 中心 `{x:1414,y:25}`（pristine shell，面板收起） |
| 3b | 右侧栏展开 + guides | PASS | `guides=["files","dsh-context","terminal"]`，`data-sidebar-right-open="true"` |
| 4a | 自定义 renderer 接管 HTML 预览 | PASS | `iframe[data-dsh-web-inspect-frame]` sandbox `allow-scripts allow-same-origin allow-forms allow-modals allow-popups`，rect `{x:793,y:76,w:647,h:737}`；builtin `iframe[data-html-preview]` 数量 = 0 |
| 4b | `iframe.contentDocument` 同源可读 | PASS | `readyState=complete`，`doc.title` 可读（同源成立，不是 opaque origin） |
| 4c | tab header 出现「检查元素」按钮 | PASS | `button.__dsh_web_inspect_toggle` text=`检查元素`，`data-on=false`，`aria-pressed=false`，rect 中心 `{x:1357,y:57}` |
| 5a | 真实鼠标点击开关 → 进入检查模式 | PASS | `data-on=true`，`aria-pressed=true`，按钮文案变 `退出检查` |
| 5b | iframe 内注入 overlay | PASS | 同源 iframe 文档内 `style[data-dsh-web-inspect]`=1、`.__dsh_web_inspect_hl`=1、`.__dsh_web_inspect_tip`=1、`documentElement.style.cursor=crosshair` |
| 5c | 状态条出现 | PASS | `.__dsh_web_inspect_bar[data-tone=info]`：「检查元素 检查元素：悬停高亮，单击选中并插入上下文，Esc 退出」 |
| 6a | 定位 `#doc-title` 坐标 | PASS | 元素 rect `{left:24,top:18,w:599,h:33}` → 页面坐标中心 `{x:1117,y:140}` |
| 6b | hover 高亮框 + 1px outline | PASS | `.__dsh_web_inspect_hl` display block，computed border `1px solid rgb(37, 99, 235)`，框 `24px/18px/599px/33px` 与元素 rect 对齐 |
| 6c | hover tooltip | PASS | `.__dsh_web_inspect_tip` display block，文本 `h1#doc-title  599×33` |
| 7a | 点击选中态冻结 | PASS | `.__dsh_web_inspect_hl[data-pinned="true"]`，border 变为 `rgb(249, 115, 22)`（橙色 pin） |
| 7b | 状态条显示插入结果 | PASS | `.__dsh_web_inspect_bar[data-tone=info]`：「检查元素 已插入当前会话输入框（未发送）」 |
| 7c | 草稿含 `> 选中元素：` | PASS | `[data-composer-input]` 内文 231 字符，全文见 §3 |
| 7d | 草稿含 ```html 围栏 | PASS | 同上 |
| 7e | 草稿含被选元素 selector/签名 | PASS | 匹配 `/doc-title/`、`/h1/` |
| 7f | **没有新增用户消息** | PASS | `[data-message-id]` 数量 0→0，user message 元素 0 |
| 7g | **没有发出消息请求** | PASS | Network POST 且 URL 匹配 `/message|send|turn|submit/i` 的请求数 = 0 |
| 8a | Esc 退出并清理 overlay | PASS | toggle `data-on=false`，`hl`=0、`style`=0、bar 消失、`cursor` 还原、hint 无残留 |
| 8b | 退出后草稿仍保留 | PASS | 草稿仍含「选中元素」 |
| 9 | 页面无未捕获错误 | PASS | Runtime exceptions / console error / Log error 均为空，无 `[dsh-web-inspect]` warn |

## 3. 实际插入 composer 的草稿（逐字）

````text
> 选中元素：#doc-title（h1#doc-title，599×33）

```html
<h1 id="doc-title">dsh-web-inspect 演示页面</h1>
```

- 文本：「dsh-web-inspect 演示页面」
- 样式：color: rgb(248, 250, 252); font-size: 22px
- 定位祖先：`#page-header`（position: relative）

（在这里补充你要对这块 HTML 做的修改）
````

（第一行格式为 `> 选中元素：<selector>（<signature>，W×H）`；正文含 ```html 围栏、文本/样式/定位祖先
线索，块尾预留一段「在这里补充…」。点击后**只**写 composer 草稿，未触发发送。）

## 4. 截图证据（`tests/screens/second/`）

| 文件 | 内容 |
| --- | --- |
| `01-files-tree.png` | 右侧栏展开 → 文件 guide → fixtures 目录已展开 |
| `02-preview-open.png` | 点击 `fixtures/inspect-demo.html` 后：tab 显示「HTML（可检查元素）」、我们自己渲染的 iframe 全量渲染、右上「检查元素」按钮 |
| `03-inspect-enabled.png` | 打开检查模式：状态条 hint 文案 + 开关变「退出检查」 |
| `04-hover.png` | hover `#doc-title`：1px outline + tooltip `h1#doc-title 599×33` |
| `05-selected.png` | 点击后：橙色选中框 + 状态条「已插入当前会话输入框（未发送）」+ composer 出现整块 Markdown |
| `06-composer-draft.png` | composer 草稿特写（含 ```html 围栏） |
| `07-escape-exit.png` | Esc 退出：overlay 清理、草稿保留 |

## 5. 右侧栏选择器（供 install-e2e 交叉核对）

- 展开按钮：`button[data-sidebar-right-expand=true]`，`aria-label="打开右侧边栏"`，
  `aria-keyshortcuts="Shift+Meta+B"`，1440×900 下 rect 约 `{x:1400,y:11,w:28,h:28}`（中心 1414,25）。
- 面板：`[data-sidebar-right-panel]`，展开后 `data-sidebar-right-open="true"`（字符串），
  收起按钮 `button[data-sidebar-right-toggle=true]`（`aria-label="收起右侧边栏"`）。
- **失败模式**：如果 GUI 恢复了上轮持久化的 UI 状态（右侧栏本来就是打开态，甚至带上一轮的
  `inspect-demo.html` tab），则 `[data-sidebar-right-expand=true]` **不挂载** → 查询数为 0。
  稳健顺序：等 `[data-composer-input]` 就绪 + ~1.5 s 稳定 → 若已有 `li[data-files-entry]` 直接用 →
  否则有 `[data-sidebar-right-guide-entry=files]` 就点它 → 否则点 expand → 否则先 toggle 收起再 expand →
  再 `[data-sidebar-right-guide-entry=files]` → `li[data-files-entry]`。必要时用 `Shift+Meta+B` 兜底。
- 本轮在 pristine shell（localStorage 已清）上 confirm：expand 按钮存在、点击后面板展开，
  说明 install-e2e 早期 `{"expand":0,"toggle":0,"panel":0}` 是**时序/持久化状态**问题，而非选择器错误。

## 6. 与第一轮 install-e2e 的交叉验证

install-e2e 的 `docs/notes/install-verify.md` 报 17/17 PASS、`tools/e2e.mjs` 全绿；本报告用**另一套独立
实现**（独立 Chrome 实例 :9444、独立 profile、独立 cookie 注入与断言脚本，未复用 `tools/e2e.mjs`）
复现同一条链路，并额外覆盖了 hover tooltip、Esc 清理、草稿保留、无消息发送、无页面错误等断言。
两边结论一致：**插件安装、renderer 接管、检查元素 → 插入草稿链路在真实 GUI 上可用。**

## 7. 已知限制 / 未覆盖项

- 只在 headless Chrome 157 上验证，未覆盖 Firefox/Safari。
- 插入实现只触发了主路径 `props.inputActions.insertText(...)`；兜底
  `requestDraftInitialization` 未被触发，故未在实机验证兜底分支（需要刻意让主路径失败才能覆盖）。
- fixture 中没有 `<a href>`，因此“点击链接不跳转”的实时断言未覆盖；该行为由引擎单测
  （`tests/engine-selftest.html` 中 click `defaultPrevented` 断言）覆盖。
- 未验证：嵌套同源 iframe/Shadow DOM 的实机表现、页面内滚动时 overlay 贴合、多次重复选择、
  composer 已有草稿时再次插入的追加/去重行为（均属单测范围或后续任务）。
- 截图内容区为 1440×813（headless 窗口 1440×900 去掉窗口装饰后的视口），坐标断言均基于该视口。
- 复现需要清 localStorage 才能稳定得到“右侧栏收起”的初始状态；不清也能跑（脚本有兜底路径），
  但首次点击路径会不同。
