# dsh-web-inspect — chip-insertion verification (task-5)

Real-browser verification of the **atomic reference-chip** insertion in the live
`dsh-web-inspect` bundle: the composer must receive ONE official `ReferenceChip`
(`<h1#doc-title>`) instead of a multiline Markdown block, the full context must
travel inside the chip's `ref`, and the outgoing prompt must still contain the
complete Markdown when the message is submitted.

- Harness: [`tools/e2e.mjs`](../../tools/e2e.mjs) (raw CDP over Node's built-in
  `WebSocket`, no npm installs) — `node tools/e2e.mjs`.
- Run: 2026-11-22 ~17:0x Asia/Shanghai, GUI `http://127.0.0.1:3080`
  (PID 39733, **not** restarted).
- App `0.2.2-rc.1`, boot rev `88d7734a551c`, 87 client entries.
- Plugin bundle rev `f92e67a17dff` (`plugins/??dsh-web-inspect/client.js&rev=f92e67a17dff`).
- Fixture `fixtures/inspect-demo.html`; target `#doc-title` (h1, 599×33) then
  `#panel-dark .dup` (256×44) for the second/append cycle.
- Result: **PASS — 20 checks, 5.6 s, exit code 0, no `console.error`, no `[dsh-web-inspect]` warnings**
  (`tests/screens/e2e-report.json`, screenshots `tests/screens/**`).

## 1. Chip mode observed

Diagnosis: which insertion fallback actually ran? The **first** path did —
`input.insertReference(reference, inputActions.captureInsertion())` — there is
no quote/plain-text fallback in play, and the composer shows an atomic
`ReferenceChip`, not text.

Composer DOM after clicking `#doc-title` in inspect mode (measured):

```html
<span data-composer-chip="inspect" contenteditable="false" data-lexical-decorator="true">
  <span class="q44v1G_reference yAWgPa_chip q44v1G_openable" title="&lt;h1#doc-title&gt;">
    <svg width="14" height="14" class="yAWgPa_icon" viewBox="0 0 16 16" fill="none"
         xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1">
      <path d="M4.9375 5.90295H11.0625" stroke="currentColor"></path>
      <path d="M4.9375 9.02991H8.27841" stroke="currentColor"></path>
      <path d="M12.5 1.32617C13.3039 …z" fill="currentColor"></path>
    </svg>
    <span class="yAWgPa_label">&lt;h1#doc-title&gt;</span>
  </span>
</span>
```

- Chip element selector used by the harness: `[data-composer-input] [title^="<"]`
  (the host classes `q44v1G_*`/`yAWgPa_*` are hashed and must not be relied on;
  `[data-composer-chip]` on the Lexical decorator host plus `title` is stable).
- Label `title`/`textContent` = `<h1#doc-title>` (14 chars, ≤ `CHIP_LABEL_MAX` 24).
- Composer visible text = `<h1#doc-title> ` only — free of `> 选中元素：`,
  ```` ```html ```` and the HTML snippet (asserted).
- Persisted draft (`localStorage["dsh.conversation.<sessionId>"]`):

  ```json
  {"draft":{"text":"<h1#doc-title> ","references":[{"source":"inspect",
   "ref":"dsh-web-inspect:v1:<base64url>","offset":0,"length":14,
   "label":"<h1#doc-title>","clipboardText":"<h1#doc-title>","appearance":"file"}]}}
  ```

  `ref` length = 505 chars for a 231-char Markdown payload (base64url of
  `{"m":<markdown>,"l":<label>}`); decoding it yields the full context block
  (selector line + ```` ```html ```` fence + 文本/样式/定位祖先 + footer).
- Status bar reports chip mode: `已插入引用块「<h1#doc-title>」：点击查看完整上下文（未发送）`
  (the old multiline mode said `已插入当前会话输入框（未发送）`).
- Second, distinct element appends a second chip (`<div.dup>`, 2 refs) instead of
  overwriting; Backspace with the caret after the last chip removes it atomically
  (2 → 1) and leaves the first chip/ref intact.

## 2. Chip click → full-context popover

Clicking the chip calls the plugin's registered `inputTriggers` source
(`openReference`), which opens the parent-document popover:

```
div.__dsh_web_inspect_pop[data-dsh-web-inspect-popover="<h1#doc-title>"]
└ div.__dsh_web_inspect_pop_panel
  ├ div.__dsh_web_inspect_pop_head
  │  ├ span  "选中元素上下文"
  │  ├ code  "<h1#doc-title>"
  │  ├ span  "发送后模型会收到以下完整内容"
  │  └ button.__dsh_web_inspect_pop_close "关闭"
  └ pre.__dsh_web_inspect_pop_body  ← 231-char Markdown (textContent)
```

- Asserted: `data-dsh-web-inspect-popover` attribute, the "发送后模型会收到以下完整内容"
  hint, selector line `> 选中元素：#doc-title`, ```` ```html ```` fence, `- 样式：` line,
  `关闭` button; closing via `关闭` hides the popover and keeps inspect mode on.
- Quirk: `Escape` pressed while keyboard focus is inside the preview iframe is
  consumed by the inspector's iframe-level listener (it exits inspect mode) and
  never reaches the popover's parent-document listener — the popover stays open.
  The deterministic close path is the `关闭` button; the harness closes the
  popover first and only then tests the separate `Escape`-exits-inspect-mode step.

## 3. Outgoing-content proof (nothing was sent)

The send request is a plain `fetch` POST, so it can be intercepted in CDP without
touching the app:

1. `Fetch.enable {patterns:[{urlPattern:"*/api/*"}]}`.
2. Click `button[aria-label="发送消息"]`.
3. `Fetch.requestPaused` fires for `POST http://127.0.0.1:3080/api/session/prompt`
   with JSON body:

   ```json
   {"type":"client-request","rpcId":"…","method":"session/prompt",
    "payload":{"args":{"request":{"requestId":"…","sessionId":"…","mode":"queue",
    "content":[{"type":"text","text":"<the expanded Markdown>"}]}}}}
   ```

4. Read `postData`, assert it contains `> 选中元素：#doc-title`, ```` ```html ````,
   `- 样式：` (231 chars), then `Fetch.failRequest {errorReason:"Aborted"}`.

The text in that body **is** what the model would receive: the chip stays an atom
in the rich-text editor, and the host expands it at submit through our
`codec.serialize` (`inputTriggers.registerSource({trigger:"@", name:"inspect",
codec:{clipboardText, serialize: () => markdown + "\n\n"}})`), producing exactly
the intercepted `content[0].text`. Because the request was aborted, no user
message was appended to the transcript and the chip/reference remained in the
composer (both asserted afterwards).

Observed side effect of the abort: a transient toast
`client api: session/prompt failed: Failed to fetch (gateway/internal)` — expected
for a failed network send, and **no** `console.error`. Screenshot:
`tests/screens/second/10-send-aborted.png`.

## 4. Appearance: value `"file"` is correct

The host reference schema only allows three appearances —
`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:4389-4403`
(`referenceSchema`: `appearance: zod.z.enum(["session","file","folder"]).optional()`).
With `appearance:"file"` the host renders `ReferenceIconRegular kind="file"`
(14×14 document glyph with two text lines, `q44v1G_openable` adds the "openable"
hover/cursor styling) and the chip click reaches our `openReference` handler.

Do **not** invent a custom appearance (e.g. `"inspect"`): the shipped icon set
only knows the three kinds, and — more importantly — the persisted draft is
re-parsed with `parseStoredDraft()` (`same file, ~L4450`) using
`safeParse` + Zod: an unknown `appearance` makes the whole draft snapshot
invalid, the parser returns `undefined`, and the host silently drops the draft on
reload/session switch. So `"file"` is not just cosmetic; it is the only safe
choice for an `openable` reference here.

## 5. Pass/fail table (20 checks)

| # | check | result |
|---|-------|--------|
| 1 | auth (self-signed `dsh-auth-…` cookie) | PASS |
| 2 | Chrome launch (headless, own `--user-data-dir`) | PASS |
| 3 | GUI boot / composer mounted | PASS |
| 4 | `dsh-web-inspect` plugin loaded (style tag + boot entry) | PASS |
| 5 | select workspace `dsh-web-inspect-plugin` | PASS |
| 6 | right-sidebar files page rooted at the project | PASS |
| 7 | `fixtures/inspect-demo.html` preview tab opened | PASS |
| 8 | preview frame is our same-origin srcdoc iframe | PASS |
| 9 | 「检查元素」 toggle turns on | PASS |
| 10 | hover highlight + tooltip (`h1#doc-title 599×33`) | PASS |
| 11 | click → exactly 1 chip `<h1#doc-title>`, no Markdown text | PASS |
| 12 | status bar reports chip mode | PASS |
| 13 | no auto-send (transcript unchanged, chip/ref still in composer) | PASS |
| 14 | chip popover: head + selector + fence + 样式, closes via 关闭 | PASS |
| 15 | Escape exits inspect mode | PASS |
| 16 | 「检查元素」 re-attaches and overlay remounts | PASS |
| 17 | second element hover (`div.dup 256×44`) | PASS |
| 18 | second chip `<div.dup>` appended (2 distinct chips, 2 refs) | PASS |
| 19 | Backspace deletes last chip atomically (2 → 1) | PASS |
| 20 | outgoing prompt (CDP-intercepted, aborted) carries selector + fence + styles | PASS |

No page exceptions, no `console.error`; only console entry is the expected
`[log:security] An iframe which has both allow-scripts and allow-same-origin for
its sandbox attribute can escape its sandboxing.` warning (our inspector frame is
intentionally same-origin). No `[dsh-web-inspect]` warnings.

## 6. Bug found: plugin chrome is illegible in the app's dark theme

The web GUI renders with the dark theme (`html[data-ds-theme-source="dark"]`,
`color-scheme: dark`). The plugin CSS uses `var(--dsw-alias-*, <light fallback>)`
design tokens. Two token names used by the plugin **do not exist** in this app
build, so their hard-coded *light* fallbacks win while the text/border tokens
resolve to dark-theme *light* colours → light-on-light.

Measured (computed styles, dark theme):

| element | color | background | contrast |
|---|---|---|---|
| `.__dsh_web_inspect_pop_panel` | `rgb(249,250,251)` | `rgb(255,255,255)` | **1.05 : 1** |
| `.__dsh_web_inspect_pop_body` | `rgb(249,250,251)` | `rgb(249,250,251)` | **1.00 : 1** (invisible) |
| `.__dsh_web_inspect_bar` | `rgb(207,211,214)` | `rgb(249,250,251)` | **1.44 : 1** |
| `.__dsh_web_inspect_toggle[data-on="true"]` | `rgb(255,255,255)` | `rgb(249,250,251)` | **1.05 : 1** |
| composer chip label (minor) | `rgb(29,78,216)` | `rgba(37,99,235,.10)` over `#151517` | 2.51 : 1 |

Root cause: `--dsw-alias-bg-elevated` and `--dsw-alias-bg-sunken` are **empty**
(undefined) in the dark theme; the rest do resolve — 413 `--dsw-alias-*`
properties are declared on `<body>`, e.g. `--dsw-alias-bg-base:#151517`,
`--dsw-alias-bg-layer-1:#232324`, `--dsw-alias-bg-layer-2:#2c2c2e`,
`--dsw-alias-bg-layer-3:#353638`, `--dsw-alias-label-primary:#f9fafb`,
`--dsw-alias-label-secondary:#cfd3d6`, `--dsw-alias-border-l2:#ffffff1f`.
The popover is appended to `document.body`, so it does inherit these tokens.

Visual evidence: `tests/screens/second/08-chip.png` (popover body looks blank —
the text is rendered, just white-on-white), `09-two-chips.png` /
`10-send-aborted.png` (the inspect status bar is a light strip with light text).

### Proposed patch (Lead applies `lib/client.js`; CSS lives at lines 60–77)

```diff
-.__dsh_web_inspect_toggle{…border:1px solid var(--dsw-alias-border-l2,#d0d5dd);…color:var(--dsw-alias-label-secondary,#475467);…}
+.__dsh_web_inspect_toggle{…border:1px solid var(--dsw-alias-border-l2,#ffffff1f);…color:var(--dsw-alias-label-secondary,#cfd3d6);…}
-.__dsh_web_inspect_toggle[data-on="true"]{background:var(--dsw-alias-button-primary-fill,#1d4ed8);border-color:transparent;color:var(--dsw-alias-label-on-primary,#fff)}
+.__dsh_web_inspect_toggle[data-on="true"]{background:var(--dsw-alias-bg-layer-3,#353638);border-color:var(--dsw-alias-border-l2,#ffffff1f);color:var(--dsw-alias-label-primary,#f9fafb)}
-.__dsh_web_inspect_bar{…border-bottom:1px solid var(--dsw-alias-border-l2,#e4e7ec);background:var(--dsw-alias-bg-elevated,#f9fafb);color:var(--dsw-alias-label-secondary,#475467);…}
+.__dsh_web_inspect_bar{…border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff1f);background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-secondary,#cfd3d6);…}
-.__dsh_web_inspect_pop_panel{…border:1px solid var(--dsw-alias-border-l2,#d0d5dd);…background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#101828);…}
+.__dsh_web_inspect_pop_panel{…border:1px solid var(--dsw-alias-border-l2,#ffffff1f);…background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#f9fafb);…}
-.__dsh_web_inspect_pop_head{…border-bottom:1px solid var(--dsw-alias-border-l2,#e4e7ec);…}
+.__dsh_web_inspect_pop_head{…border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff1f);…}
-.__dsh_web_inspect_pop_head code{…color:#2563eb}
+.__dsh_web_inspect_pop_head code{…color:var(--dsw-alias-label-primary-bluish,#93c5fd)}
-.__dsh_web_inspect_pop_close{…border:1px solid var(--dsw-alias-border-l2,#d0d5dd);…}
+.__dsh_web_inspect_pop_close{…border:1px solid var(--dsw-alias-border-l2,#ffffff1f);…}
-.__dsh_web_inspect_pop_body{…background:var(--dsw-alias-bg-sunken,#f9fafb)}
+.__dsh_web_inspect_pop_body{…background:var(--dsw-alias-bg-layer-1,#232324);color:var(--dsw-alias-label-secondary,#cfd3d6)}
```

Optional (chip polish only): replace
`[data-composer-input] [title^="<"]{border-color:rgba(37,99,235,.55);background:rgba(37,99,235,.10);color:#1d4ed8}`
with `{border-color:rgba(96,165,250,.55);background:rgba(96,165,250,.14);color:var(--dsw-alias-label-primary,#f9fafb)}`
and its `svg{color:#93c5fd}`. Functionality is unaffected either way — the chip
was clickable and the popover opened; only contrast suffers.

Keep the `var(--token, dark-fallback)` shape: in a light theme the real tokens
(if defined there) still win, and the dark fallbacks are only the safety net.

## 7. Reproduce

```bash
cd /Users/care/Projects/dsh-web-inspect-plugin
node tools/e2e.mjs                 # 20 checks, exit 0
node tools/e2e.mjs --headed        # same, in a visible Chrome window
```

Artifacts: `tests/screens/e2e-report.json` (all 20 steps + `facts.chip1`,
`facts.popover.computed`, `facts.chip2`, `facts.chip3`, `facts.outgoing`,
`facts.console`), screenshots `tests/screens/05-selected-draft.png`,
`tests/screens/second/08-chip.png`, `09-two-chips.png`, `10-send-aborted.png`
(plus the earlier navigation/hover/screenshot set `03`–`07`).

Notes / host quirks worth remembering:

- `dsh.conversation.<sessionId>` draft text keeps the chip as its label plus a
  trailing space (`"<h1#doc-title> "`), while `references[]` carries the payload;
  the DOM chip remains a single atomic `data-composer-chip` decorator.
- A chip label is capped by the plugin at 24 chars; long ids fall back to
  `<tag.class>` or plain `<tag>`.
- `plugin-loaded` asserts on the injected `<style data-plugin="dsh-web-inspect">`
  and/or the `dsh-web-inspect` entry of `window.__DSH_BOOT__` — never on a hardcoded
  bundle rev (the rev changes on every plugin reload).
