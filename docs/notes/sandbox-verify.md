# sandbox-verify — opaque-origin 安全检查器模型（dsh-web-inspect）

验证 `dsh-web-inspect` 在 **opaque-origin（不透明源）iframe** 安全模型下的端到端链路：预览 iframe 只能执行脚本、不能反向读取宿主页面；检查器 runtime 由父窗口注入到 srcdoc 文档内部，父子只通过 `postMessage` 通信；所有 iframe 内断言都经由 CDP 目标上下文完成，不依赖 `contentDocument`。

- 历史一轮实测版本：app `0.2.2-rc.1`，boot rev `16118aaa8ea3`，插件 bundle rev `7b59988e3740`，bundle 拉取 `59,959 B`，boot payload 87 个 client entry。改 bundle 后 rev 会变，文档里的 rev 仅代表当时的证据。
- **最终命名 `dsh-web-inspect` 后的复跑**：PASS **31/31**（0 SKIP，39.7 s，无 console error），boot rev `29531d886ac0`，插件 bundle rev `89be62c59913`（60,133 B）；新增第 31 项 `legacy-element-sentinel-fold`（中间代 `<!--dsh-element-inspect:v1-->` 旧哨兵仍折叠）。下面 30 项表内容不变，新增项与 `legacy-sentinel-fold` 同构。
- 运行方式：`node tools/e2e.mjs --no-live-send`（安全链路快验，不真发）→ `node tools/e2e.mjs`（完整，含真发）
- 历史结果：**PASS 30/30，0 SKIP，81.9 s，无 console error**；最终命名后复跑 **31/31，39.7 s**（`tests/screens/e2e-report.json`）
- 截图：`tests/screens/second/13-opaque-origin.png`（父页视角：不透明 iframe 正常渲染 + 工具按钮）、`14-bubble-fold.png`（legacy 哨兵发送后折叠成 chip 的气泡）、`09-sent-bubble.png`、`09-two-chips.png`、`10-bubble-expanded.png`、`10-send-aborted.png`、`11-plain-bubble.png`、`12-quote-regression.png`；主截图 `tests/screens/03-preview-plugin-frame.png`…`07-second-hover.png`。

## 1. 安全契约（实现侧）

| 层 | 契约 |
| --- | --- |
| iframe | `sandbox="allow-scripts"`（**没有** `allow-same-origin` / `allow-forms` / `allow-modals` / `allow-popups`），文档因此是 opaque origin |
| 父窗口 | 从不读 `contentDocument`；不注入、不修改 iframe 内 DOM；只 `iframe.contentWindow.postMessage(...)` 与 `getBoundingClientRect()` |
| 注入 | 父窗口把 serialized runtime 作为 `<script data-dsh-web-inspect-runtime="1">` 写进 **srcdoc 文档**，在文档内联脚本顺序中排第一 |
| 父 → iframe | `{source:"dsh-web-inspect", type:"enable"|"disable"}`（iframe 收到后 attach/detach overlay + 事件监听） |
| iframe → 父 | `{source:"dsh-web-inspect", type:"ready"|"select"|"exit"|"error", payload?}`；`select.payload` 携带完整元素上下文 |
| 坐标 | 点击坐标 = `iframe.getBoundingClientRect()` + 在 iframe execution context 内读到的元素 rect 偏移 |
| 失败兜底 | CSP 阻止内联脚本时 runtime 不 announce，父窗口显示 `.__dsh_web_inspect_bar[data-tone=error]` |

## 2. 实测证据（本轮 report facts）

### 2.1 不透明源与沙箱

```json
facts.frame = {
  "sandbox": "allow-scripts",
  "sandboxTokenList": ["allow-scripts"],
  "dataAttr": true,
  "sameOriginDocument": "null",
  "contentWindowDocument": "SecurityError",
  "rect": {"x": 938, "y": 76, "width": 647, "height": 824},
  "parentOrigin": "http://127.0.0.1:3080",
  "frameUrl": "about:srcdoc"
}
```

- 父页 `iframe.getAttribute("sandbox")` → 恰为 `allow-scripts`；token 列表仅一项，**不含** `allow-same-origin`。
- 父页 `iframe.contentDocument` → `null`；父页读 `iframe.contentWindow.document` → 抛 `SecurityError`。
- iframe 内读 `parent.document` → 抛 `SecurityError`。
- iframe 内 `location.origin` → `"null"`（opaque origin 的标准表现）；CDP 的 `auxData.origin` 显示为 `"://"`（同一事实的 CDP 表示）。

### 2.2 注入的 runtime（iframe 目标上下文内实测）

```json
facts.frameInFrame = {
  "docTitle": "dsh-web-inspect 演示页 fixture",
  "runtimeScript": true,
  "runtimeScriptCount": 1,
  "runtimeFirstScript": true,
  "runtimeScriptIndex": 0,
  "scriptCount": 2,
  "bodyChildren": 4,
  "bodyFirstChild": "HEADER",
  "origin": "null",
  "parentAccess": "SecurityError",
  "globals": ["__dsh_web_inspect_runtime__"],
  "readyState": "complete"
}
```

说明：`script[data-dsh-web-inspect-runtime="1"]` 是文档里第一个 `<script>`；runtime 全局为 `window.__dsh_web_inspect_runtime__`（**只是安装守卫，装完一直为 true，不代表 enabled**，见 §5）。

### 2.3 postMessage 通道

- parent → frame：`["enable"]`（父窗口点击 toggle 后发出的 enable，被 frame 侧 recorder 收到；在 `facts.toggle.postMessageFrameReceived` 中可见）。
- frame → parent：父侧 recorder 在 runtime announce `ready` 之后才安装，因此本轮记录为 `[]`；这是**观测时机**而非没发（iframe 内 runtime 的 `ready` 重发逻辑 + overlay 成功挂载已由 2.2/2.4 证明）。E2E 不把父侧 `ready` 作为门槛断言。
- `select` 消息实测：`origin: "null"`（opaque origin）、payload `519 B`、keys 15 个：

```json
["selector","signature","tag","id","classes","width","height","rect","text","styles","spacing","clues","positionedAncestor","ancestors","html"]
```

`selector: "#doc-title"`, `tag: "h1"`, `rect: {"x":24,"y":18,"width":599,"height":33}`。

### 2.4 hover / click / composer

- hover：iframe 内 `.__dsh_web_inspect_hl` 可见 `599×33`，tooltip 文本 `h1#doc-title 599×33`。
- click：父窗口收到 `select`，父页 composer 出现 1 个 chip `<h1#doc-title>`（14 字符，`ref` 534 字符）；composer 可见文本**不含** Markdown。
- 状态条：`已插入引用块「<h1#doc-title>」：点击查看完整上下文（未发送）`。
- chip popover：246 字符完整上下文（selector + ```html 围栏 + 样式 + 定位祖先），用「关闭」按钮关闭。

### 2.5 Escape 退出

- 路径：`page-target-rawKeyDown -> page-realm-handled`。父页 target 上发真实按键（`Input.dispatchKeyEvent` `rawKeyDown` + `keyUp`，Escape，`windowsVirtualKeyCode:27`）后：
  - 父页 recorder 收到 `key: "Escape"`；
  - toggle `data-on` `"true"` → `"false"`，`.__dsh_web_inspect_bar` 数量 `1` → `0`；
  - iframe 内 overlay/tooltip 已移除、cursor 恢复（`""`）。

### 2.6 真发与折叠

- 拦截 `POST /api/session/prompt`（`Fetch.enable` + `continueRequest`）：wire 305 字符，含 `<!--dsh-web-inspect:v1-->` + `<!--/dsh-web-inspect-->`、可读首行 `> 选中元素：#doc-title（…）`、selector、```html 围栏、`- 样式：`。
- 用户气泡：1 个 `[data-dsh-web-inspect-chip]`（容器 `DIV.Sixlwa_userStack`），气泡文本无 Markdown / 哨兵泄漏；点气泡 chip 仍能打开完整 popover（含「定位祖先」）。
- 会话标题可读：`> 选中元素：#doc-title（h1#doc-tit…`，无 `<!--` 原生哨兵泄漏。
- plain 回归：`plain text check`（16 字符 wire）气泡无 chip。
- 官方 `>` 引用回归：`> 引用回归测试` 仍渲染 quote preview（1 个），不被折叠成 chip。
- legacy 兼容：发送旧哨兵 `<!--dsh-inspect:v1-->…<!--/dsh-inspect-->` 的消息仍折叠成 chip（transcript 2 个 chip，无哨兵 / 围栏 / 样式泄漏）。

## 3. 断言表 — 30/30 PASS（最终命名为 31/31，见顶部说明）

| # | 步骤 | 断言 | 结果 |
| --- | --- | --- | --- |
| 1 | auth | 自签 cookie（HMAC from `~/.dsh/.credentials.yaml`）→ GUI 200 | PASS |
| 2 | chrome | 独立 headless Chrome + CDP | PASS |
| 3 | open-gui | boot rev / 87 entries / composer 挂载 | PASS |
| 4 | plugin-loaded | `style[data-plugin="dsh-web-inspect"]` + boot entry id | PASS |
| 5 | plugin-bundle | 取回 bundle 200，rev 与 boot 一致，含 runtime/postMessage/新旧前缀，**无** allow-same-origin | PASS |
| 6 | select-workspace | 确定性选中 `dsh-inspect-plugin` | PASS |
| 7 | open-files-page | 工作区文件树根 = 项目目录 | PASS |
| 8 | open-preview | `fixtures/inspect-demo.html` 预览 tab | PASS |
| 9 | plugin-frame | sandbox 恰 `allow-scripts`；contentDocument=null；双向 SecurityError；runtime 注入为第一个内联脚本 | PASS |
| 10 | inspect-toggle | toggle on；状态条提示；frame 收到 enable；overlay+tooltip 挂载、cursor crosshair | PASS |
| 11 | hover-highlight | 599×33 高亮 + tooltip `h1#doc-title 599×33`（iframe context 内） | PASS |
| 12 | click-select-insert | composer 1 chip（14 字符），无 Markdown | PASS |
| 13 | status-confirmed | `已插入引用块「<h1#doc-title>」…` | PASS |
| 14 | no-auto-send | transcript 无新用户消息，chip 仍在 composer | PASS |
| 15 | chip-popover | 完整上下文 + 关闭 | PASS |
| 16 | escape-exit | page-target Escape → toggle off、overlay/tooltip 移除、cursor 恢复 | PASS |
| 17 | inspect-reattach | 再次开启后 overlay 重新挂载 | PASS |
| 18 | hover-second-element | `#panel-dark .dup` 256×44 | PASS |
| 19 | second-selection-append | 2 个不同 chip 追加 | PASS |
| 20 | chip-backspace | 退格原子删除最后一个 chip（2→1） | PASS |
| 21 | outgoing-content | 拦截 abort 的 POST 里 305 字符 wire（selector+围栏+样式） | PASS |
| 22 | send-real | 真发 continueRequest；wire 含双哨兵 + 可读首行 + selector + 围栏 + 样式 | PASS |
| 23 | sent-bubble | 气泡 1 chip，无 Markdown/哨兵泄漏 | PASS |
| 24 | bubble-popover | 气泡 chip popover 246 字符（含定位祖先） | PASS |
| 25 | session-title-readable | 标题可读，无 `<!--` 泄漏 | PASS |
| 26 | plain-send | plain wire 16 字符，无哨兵 | PASS |
| 27 | plain-bubble | plain 气泡无 chip | PASS |
| 28 | quote-regression | 官方 `>` 引用仍为 quote preview，不折叠 | PASS |
| 29 | legacy-sentinel-fold | 旧哨兵消息仍折叠成 chip，无泄漏 | PASS |
| 30 | console-clean | 无 console.error / 无 `[dsh-web-inspect]` warning | PASS |

## 4. 关键 DOM / 属性清单（实测）

- iframe：`iframe.__dsh_web_inspect_frame[data-dsh-web-inspect-frame]`，`sandbox="allow-scripts"`，`srcdoc=<注入文档>`，父视口 rect 647×824。
- toggle：`button.__dsh_web_inspect_toggle[data-on]`（文本 `检查元素` / `退出检查`）。
- 状态条：`div.__dsh_web_inspect_bar[data-tone=hint|ok|error]`。
- iframe 内 overlay：`.__dsh_web_inspect_hl[data-pinned]` + `.__dsh_web_inspect_tip`。
- composer chip：`[data-composer-input] [title^="<"]`（官方 ReferenceChip）。
- 气泡 chip（实测 outerHTML）：

```html
<button type="button" class="__dsh_web_inspect_bchip" title="&lt;h1#doc-title&gt;" data-dsh-web-inspect-chip="&lt;h1#doc-title&gt;">
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">…双箭头…</svg>
  <span>&lt;h1#doc-title&gt;</span>
</button>
```

- 气泡容器：`DIV.Sixlwa_userStack > DIV[data-message-bubble] > span.BNl2La_root > span[data-slot="conversation.user.text.node"]`。
- popover：`div.__dsh_web_inspect_pop[data-dsh-web-inspect-popover] > .__dsh_web_inspect_pop_panel`，关闭按钮 `.__dsh_web_inspect_pop_close`（文本 `关闭`）。

## 5. 实现/观测 quirk（复跑/改断言必读）

1. **`__dsh_web_inspect_runtime__` 不是 enabled 标志**：它是 runtime 安装守卫，装完一直 `true`。判断“已关闭”必须看 overlay/tooltip 是否移除、cursor 是否恢复；E2E 曾因把它当 enabled 标志导致 escape-exit 永远 SKIP。
2. **iframe 是 OOPIF**：父页 `Page.getFrameTree` **不会**列出它；父 session 的 `Runtime.executionContextCreated` 也不上报其 context。E2E 的做法：`Target.setAutoAttach {flatten:true, waitForDebuggerOnStart:true}` → 对 attached child session `Page.enable` + `Page.getFrameTree`（找 `about:srcdoc` 子 frame）+ `Runtime.enable`（必要时 `Runtime.runIfWaitingForDebugger`），按 `auxData.frameId` 关联 context。Lead 的相对做法：`GET /json/list` 找 `type:"iframe", url:"about:srcdoc"` 的 `webSocketDebuggerUrl` 直连。
3. **Escape 只有 page-target 的真实按键路径可靠**：往 OOPIF session 发 `Input.dispatchKeyEvent`、或在 iframe 里 dispatch 合成 `KeyboardEvent`，在本轮 build 上都不会把父侧 store 关掉（历史 SKIP 原因）。正确顺序：先 `Page.bringToFront`、`document.body.click()`/聚焦，然后在**父页 target** 发 `rawKeyDown` + `keyUp` Escape，断言 `data-on !== "true"` 且 bar 数量为 0，再轮询 iframe 内 overlay 消失。
4. **父侧 `ready` 可能被漏采**：iframe runtime 的 announce 在父窗口 recorder 安装前就发生（尤其 E2E 在预览打开后才注入 recorder）。所以 `ready` 只作为观测记录，判据用 iframe 内 overlay + cursor + 后续 `select`/状态条。
5. **已失效的 initial about:blank context**：OOPIF 在 srcdoc 导航前有空白上下文。iframe 断言必须轮询到 `runtimeScript && bodyChildren > 0` 再断，否则会读到空文档。组件侧也已修复“先挂 `srcdoc=""` 再 effect 填充导致 Chrome 丢弃导航”的旧 bug（本轮 build 在内容解码后才挂载一次 iframe，以内容签名作 key）。
6. **evaluate 模板里写正则要小心**：在 `tools/e2e.mjs` 的 evaluate 模板字符串里，`\s`/`\/` 会被转义层吞掉（曾出现 `split(/\s+/)` 变成 `/s+/`、正则字面量含 `<!--` 触发 `Invalid regular expression`）。规则：模板里用 `split(' ')` / `String.includes(...)`，不要用正则字面量。
7. **toast 只能隐藏不能删除**：中断发送会留下 React portal toast（`client api: session/prompt failed…`）；对 portal 节点 `remove()` 会让 `conversation.composer.bar` 抛 `NotFoundError`。E2E 用注入 CSS `[data-e2e-hidden-toast]{display:none!important}` 隐藏。
8. **预期内的 console 噪声**：`[log:security] An iframe which has both allow-scripts and allow-same-origin …` 只在旧版同源 iframe 出现；本轮 opaque 模型**没有**该 warning。若复跑仍看到它，说明连到了旧 bundle/target。
9. **行为：真正点击发送需要模型可用**：本轮 4 条真实消息（chip / plain / quote / legacy）在 headless 下均成功发出；被 abort 的那次（outgoing-content）会留下一次 `session/prompt failed` toast，属预期。

## 6. 复现

```bash
cd /Users/care/Projects/dsh-inspect-plugin
node tools/e2e.mjs --no-live-send   # 安全链路快验（不真发，21 checks）
node tools/e2e.mjs                  # 完整 31 checks（真发 5 条消息到一次性会话）
```

- 报告：`tests/screens/e2e-report.json`。关键字段：`facts.app`（boot rev/entries）、`facts.pluginEntry`（bundle url+rev）、`facts.frame`、`facts.frameInFrame`、`facts.toggle`、`facts.hover`、`facts.selectMessage`、`facts.chip1`、`facts.popover`、`facts.escape`/`facts.escapePageDispatch`、`facts.sentWire`、`facts.bubble`、`facts.bubblePopover`、`facts.title`、`facts.plainSend`/`facts.plainBubble`、`facts.quoteSend`/`facts.quoteBubble`、`facts.legacyBubble`、`facts.console`。
- 退出码：`0` 全过；`1` 断言失败；`2` 插件未加载（带安装步骤提示）。
- 每次跑都重新读 `window.__DSH_BOOT__`，不硬编码 rev；截图覆盖写入 `tests/screens/`、`tests/screens/second/`。
