# chip-bubble-verify — 发送后气泡折叠验证（task-6）

真机 E2E 验证 dsh-web-inspect 的两段行为：**发送前** composer 里是官方 ReferenceChip（task-5 已验证），**发送后** 用户气泡里折叠成 ONE 个 `dsh-web-inspect` chip（本轮新增），点 chip 可弹出完整上下文；同时验证官方 `>` 引用气泡、纯文本消息不被误伤。

- 验证方式：`node tools/e2e.mjs`（raw CDP，无 npm 依赖，headless Chrome，1440×900）
- 结果：**PASS，28 checks，≈42 s，console.error = 0，`[dsh-web-inspect]` warning = 0**（唯一 console 记录是预期的 iframe `allow-scripts allow-same-origin` security warning）
- 被测版本（E2E 每轮从 `window.__DSH_BOOT__` 现读，不硬编码）：app `0.2.2-rc.1`，boot rev `07677f42a1f4`，client entries 87，插件 bundle rev `1a796a341aa2`（`plugins/??dsh-web-inspect/client.js&rev=1a796a341aa2`）
- 报告：`tests/screens/e2e-report.json`（`facts.debugBefore/debugAfter` 含插件调试钩子 dump；`facts.bubble / bubblePopover / title / plainSend / plainBubble / quoteSend / quoteBubble / console`）
- 截图：`tests/screens/second/09-sent-bubble.png`、`10-bubble-expanded.png`、`11-plain-bubble.png`、`12-quote-regression.png`（另 08-chip.png 为发送前 composer chip + popover）

## 1. 线上 wire 格式（发送文本，出站 postData 实证）

真实发送的 `POST /api/session/prompt` 请求体里（`type:"client-request"`，`method:"session/prompt"`，`payload.args.request.content[0].text`），273 字符：

```
> 选中元素：#doc-title（h1#doc-title，599×33）
<!--dsh-web-inspect:v1-->

```html
<h1 id="doc-title">dsh-web-inspect 演示页面</h1>
```

- 文本：「dsh-web-inspect 演示页面」
- 样式：color: rgb(248, 250, 252); font-size: 22px
- 定位祖先：`#page-header`（position: relative）

（在这里补充你要对这块 HTML 做的修改）
<!--/dsh-web-inspect-->
```

E2E 断言（全 PASS）：`> 选中元素：` 在开哨兵**之前**（`readableFirst`）、开/闭哨兵都在、```html 围栏在、`- 样式：` 行在；模型收到的 Markdown 未被修改。

## 2. 气泡折叠主链路（1 chip，无 Markdown/哨兵泄漏）

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| 发送后用户气泡恰好 1 个 `[data-dsh-web-inspect-chip]` | PASS | `facts.bubble.chipCount = 1` |
| chip `title` / 文本 = 元素标签 | PASS | `"<h1#doc-title>"`（14 chars ≤ 24） |
| 气泡容器文本 == 标签（无 Markdown/哨兵/`> 选中元素`/```html/`- 样式：`） | PASS | `facts.bubble.containerText = "<h1#doc-title>"`，`leaked = []` |
| 气泡 DOM 容器 | PASS | `DIV.Sixlwa_userStack`（宿主 `UserContent.userStack`） |

折叠后的气泡 DOM（`facts.bubble.containerOuterHTML`，SVG path 略）：

```html
<div class="Sixlwa_userStack">
  <div data-message-bubble="" data-text-interaction-source="" class="_bubble_1sgyj_1">
    <span class="BNl2La_root">
      <span data-slot="conversation.user.text.node" style="display: contents;">
        <button type="button" class="__dsh_web_inspect_bchip"
                title="&lt;h1#doc-title&gt;"
                data-dsh-web-inspect-chip="&lt;h1#doc-title&gt;">
          <svg viewBox="0 0 16 16" …（两个 chevron path）…></svg>
          <span>&lt;h1#doc-title&gt;</span>
        </button>
      </span>
    </span>
  </div>
</div>
```

即：规则节点 id/key = `dsh-web-inspect`，由 `conversation.user.text.node` 槽的 keyed child 渲染；`data-slot` 包裹层 `display:contents` 只含这一个 chip（没有残留文本节点）。

点气泡 chip → `[data-dsh-web-inspect-popover]` 弹出（`facts.bubblePopover`）：头部 `选中元素上下文 <h1#doc-title> 发送后模型会收到以下完整内容 关闭`，body 230 字符完整 Markdown（selector + ```html + 文本/样式/定位祖先 + 尾部提示）；`关闭` 按钮可关。截图 `10-bubble-expanded.png` 为深色可读面板（Lead 的 CSS 变量修复生效）。

## 3. 根因记录：规则 tie-break 输给 message-quotes（这次真正修的 bug）

新 wire 把**人读的 quote 行放在第一行**后，气泡**完全不折叠**（raw Markdown + 哨兵直接显示在气泡里）。用 Lead 的临时调试钩子 `window.__DSH_INSPECT_DEBUG__` 拿到决定性证据（修复前 rev `024b07d6c181` / boot `9ec55ccf1e16`）：

```
registered: true
calls: 4, samples: [{from:0,len:273},{from:38,len:273},{from:0,len:273},{from:38,len:273}]
lastFrom: 38, lastRanges: [{start:0,end:273,kind:"sentinel"}]
```

- `samples[*].head` 与 postData 完全一致 → host 喂给 rule 的文本没问题，注册也没问题。
- `from` 停在 **38**（恰好是首行 `> 选中元素：…#doc-title（…）` 的长度）→ 前 38 个字符被**别的规则**先消费了。
- 渲染 DOM 也印证：气泡被拆成两个节点——① `_root_bgejw_3 _inline_bgejw_79`（quote 预览，`data-quote-preview`，text `选中元素：#doc-title（h1#doc-title，599×33）`）② `_plainRun_fbulu_6`（剩余 raw 文本）。

元凶：`@deepseek-ai/dsh-message-quotes/lib/client.js:96` 注册的 `quoteRule` 用 `order: -10`（`:169` `ctx.uiConversation.userText.register(quoteRule)`）；我们的 `inspectUserTextRule` 是 `order: 20`。host `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 的 `reconcile` 选**最小 start** 候选，start 相同（这里的 quote 行与我们的折叠块都从 0 开始）时**保持规则遍历顺序**（按 order 升序，再按 id），所以 order 20 的我们输给 order -10 的 quoteRule，`0..38` 被 quote 节点吃掉后我们的 `match(text, 38)` 已无法再返回 `[0,273)`。

修复（Lead 已应用）：`inspectUserTextRule.order: 20 → -20`（-20 早于 quoteRule 的 -10，也早于 sessionReferenceRule 的 10）。修复后 dump：`calls:4, samples from 0/273/0/273, lastFrom: 273` → 整块被我们 win；普通 `>` 引用不受影响（见 §5）。

## 4. 会话标题可读性（新 wire 的目的）

`facts.title`：对话 header 标题实际文本 `> 选中元素：#doc-title（h1#doc-tit`（UI 截断省略号），`leaked=false`（header 区域无 `<!--dsh-web-inspect` / `dsh-web-inspect:v1`）；左侧会话列表行同样显示 `> 选中元素：#doc-title（h1#…`。E2E 断言：header 可见文本含 `选中元素` 且**不**含裸哨兵。

## 5. 回归：官方 `>` 引用气泡 & 纯文本

| 场景 | 断言 | 结果 |
| --- | --- | --- |
| 同 composer 发纯文本 `plain text check`（16-char wire，无哨兵） | 气泡无 chip、文本就是 `plain text check`；会话里我们折叠的 chip 仍为 1 | PASS |
| 官方引用 `> 引用回归测试` | 仍渲染 `[data-quote-preview]`（quoteRule 生效，1 个 preview），气泡**没有**我们的 chip，全局 chip 数仍为 1 | PASS |

→ `order: -20` 只在文本含哨兵/旧格式块时 match，不会抢普通 `>` 引用的渲染。截图 `11-plain-bubble.png`、`12-quote-regression.png`。

## 6. 出站证据（不真正“发出去”的旧版本仍保留）

`outgoing-content` 步骤仍用 CDP Fetch **abort** 掉第一次 `POST /api/session/prompt` 做模型侧证明（273-char 文本 + 全标记），随后 `send-real` 用 **continueRequest** 真正发送一次；两次都记录 `facts.sentWire`。发送后只等待用户气泡与约定截图，不等 assistant 完整回复。

## 7. pass/fail 表（本轮 28 checks，全 PASS）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1–20 | 既有 20 checks：auth/chrome/open-gui/plugin-loaded/select-workspace/open-files-page/open-preview/plugin-frame/inspect-toggle/hover-highlight/click-select-insert/status-confirmed/no-auto-send/chip-popover/escape-exit/inspect-reattach/hover-second-element/second-selection-append/chip-backspace/outgoing-content | PASS |
| 21 | send-real（continueRequest 真发，wire 标记全含） | PASS |
| 22 | sent-bubble（1 chip + 无 Markdown/哨兵泄漏） | PASS |
| 23 | bubble-popover（selector + fence + 样式 + 定位祖先 + 关闭） | PASS |
| 24 | session-title-readable（无裸哨兵） | PASS |
| 25 | plain-send（16-char wire，无哨兵） | PASS |
| 26 | plain-bubble（无 chip，纯文本） | PASS |
| 27 | quote-regression（官方 `>` 引用仍渲染 quote preview，不被折叠） | PASS |
| 28 | console-clean（0 console.error / 0 `[dsh-web-inspect]` warning） | PASS |

## 8. 工具侧 quirk（`tools/e2e.mjs` 已处理，供后续复用）

1. **assistant 流式期间主按钮是“停止”而非“发送”**：`captureSend` 在点击前先等待 `button[aria-label^=发送消息]` 可用且页面无“停止/取消”按钮（最长 150 s），否则二次 send 会报 “send button not found or disabled”。
2. **abort 产生的 transient toast**（`client api: session/prompt failed: …`）是 React portal 管理的节点，**不能** `node.remove()`（后面 React 卸载会抛 `NotFoundError: removeChild` 并计入 console.error）；`dismissErrorToasts` 改为注入 `[data-e2e-hidden-toast]{display:none!important}` + 打标记，只隐藏不删节点。
3. 会话标题在 assistant 回合结束后会被自动改名（例如变成“检查并修改文档标题”），所以**标题可读性断言必须在 send 后、下一轮生成前**读取；E2E 的顺序已保证（`session-title-readable` 紧跟 `bubble-popover`）。
4. 每轮 E2E 会真发 2–3 条无可避免的消息（chip 上下文、plain、quote）到一次性 headless 会话；跑完即关 Chrome，不影响用户浏览器。
5. 预期噪声：iframe `sandbox="allow-scripts allow-same-origin …"` 的 security warning（插件故意用 same-origin 以便检查元素）；不计入 console-clean 的 error。

## 9. 复现

```bash
cd /Users/care/Projects/dsh-web-inspect-plugin
node tools/e2e.mjs            # 28 checks; 退出码 0=PASS, 1=FAIL, 2=plugin missing
node tools/e2e.mjs --no-live-send   # 只跑前 20 项（不真发消息）
```

产物：`tests/screens/e2e-report.json`、`tests/screens/second/09-sent-bubble.png`、`10-bubble-expanded.png`、`11-plain-bubble.png`、`12-quote-regression.png`。
