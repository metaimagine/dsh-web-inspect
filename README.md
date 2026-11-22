# dsh-web-inspect

**English** | [中文](./README.zh-CN.md)

<p align="center"><strong>Element inspector for the DSH right-sidebar HTML preview.</strong><br/>
<em>Point at the element you mean — don't transcribe its CSS.</em></p>

<p align="center"><sub>hover-highlight · click-to-select · folded reference chip in the composer · opaque-origin sandbox</sub></p>

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

`dsh-web-inspect` is a [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) web-client plugin.
While you preview an HTML file in the right sidebar, turn on **Inspect element**: hovering outlines the element
under the cursor with a `tag#id.class W×H` tooltip, and clicking it inserts that element's context into the
current session input as a **single folded reference chip** — the same interaction feel as the official
*Quote text* feature. The model still receives the full Markdown context (selector, HTML, computed styles,
text, positioned ancestor) when you send; nothing is auto-sent.

## Why

You are looking at an HTML preview and you want a change made:

> "Round the corners of **this** card, lighten its background, and keep the 12px padding."

Describing it in words means hand-copying selectors and computed styles — slow, and easy to get wrong.
If you have used the DevTools "inspect element" picker in Chrome, this is the same gesture, aimed at your
AI session: with `dsh-web-inspect` you point at the element instead. The agent gets the exact node you meant
(selector, HTML, non-default computed styles, `data-*` hints, size) and you keep typing only the intent.

- **Element-level pointing** inside a rendered page — not just "this file".
- **Composer stays readable**: one chip (`<h1#doc-title>`) instead of a wall of Markdown.
- **Nothing is sent for you**: the chip lands in the input box; you review, add intent, press send.
- **The preview stays sandboxed**: the page is rendered in an opaque-origin `iframe`; inspected HTML can never
  read your DSH session, cookies, localStorage, or the app DOM.

## How it works

```text
┌─────────────── DSH Web app (your session) ───────────────┐
│  right sidebar                                            │
│  ┌─ document preview (this plugin's renderer) ─────────┐  │
│  │  ┌─ iframe sandbox="allow-scripts"  (opaque) ────┐  │  │
│  │  │  your HTML + injected inspect runtime          │  │  │
│  │  │  hover outline · tooltip · click capture       │  │  │
│  │  └─────────────────┬──────────────────────────────┘  │  │
│  │        postMessage │ ready / select / exit           │  │
│  └────────────────────┼─────────────────────────────────┘  │
│   parent: describe → Markdown → reference chip             │
│   composer:  [<h1#doc-title>]  ← you add intent, then send │
└────────────────────────────────────────────────────────────┘
```

1. **Renderer override.** The plugin registers an HTML renderer with `priority: "extension"`, which wins over
   the builtin `.html` / `.htm` previewer. A fresh preview tab renders through it; the tab keeps the
   *Inspect element* toggle in its header.
2. **Opaque-origin preview.** The document is mounted in an iframe whose sandbox is exactly
   `allow-scripts` — no `allow-same-origin`. The inspector runtime is injected into the srcdoc document
   (it handles documents with or without `<head>`, `<base>` tags, and doctype-only pages).
3. **postMessage only.** The runtime paints the overlay inside the iframe and reports the selected element
   as JSON over `postMessage`. The parent never touches `contentDocument` (it is `null`; both directions
   throw `SecurityError`). The parent turns the payload into Markdown, inserts a reference chip, and never
   submits.

## Install

Requires a DSH Web profile (`~/.dsh/profiles/web`). Pick one:

```bash
# 1) npm
dsh plugin --profile web add dsh-web-inspect

# 2) straight from GitHub
dsh plugin --profile web add https://github.com/metaimagine/dsh-web-inspect

# 3) local development (link this checkout)
dsh plugin --profile web add "link:/path/to/dsh-web-inspect"
```

After installation, **refresh the page** — no `dsh web` restart is needed (the profile recomposes live and the
client bundle is fetched with a new revision). If a preview tab was opened before installing, close and reopen
it so the plugin's renderer takes over.

Check it loaded:

```bash
dsh plugin --profile web list   # or: ls ~/.dsh/profiles/web/node_modules | grep dsh-web-inspect
```

## Quickstart

1. Open an HTML file in the right sidebar (the workspace file tree → click the file).
2. Click **Inspect element** in the preview tab header.
3. Hover the page: the element under the cursor is outlined, with a `tag#id.class 618×48` tooltip
   (the size is the element's current rendered box, so it changes with the viewport width).
4. Click: a chip like `<div.topbar>` appears in the message input (not sent).
5. Click the chip to review the full context; press `Esc` to leave inspect mode.
6. Add your intent in plain language and send. The message bubble keeps the folded chip, and the model
   receives the full context.

<p align="center">
<img src="assets/howto.png?v=20261123" alt="Annotated walkthrough: 1 Inspect element in the preview header, 2 a hovered div.topbar outlined with a div.topbar 618x48 tooltip, 3 the folded div.topbar chip sitting in the composer" width="1100">
</p>

<p align="center"><sub>① Turn on <b>Inspect element</b> in the preview header · ② hover to locate: the element is outlined and the tooltip reads <code>tag#id.class W×H</code> (the box is measured live, so it changes with the viewport width) · ③ click once and a single folded chip lands in the composer. The model still receives the full context.</sub></p>

## When to use this

Use this plugin when **all** of these hold:

- the user is pointing at a **specific element inside an HTML page already previewed** in the DSH right
  sidebar ("this button", "that card", "the dark div");
- the next step needs the element's **identity or presentation**: CSS selector, HTML snippet, rendered
  box, computed styles, `data-*` hints;
- the goal is to **describe or change that element** (resize, recolor, move, restyle), not the whole page.

Typical agent loop:

1. User, while the HTML preview is open: "make this button bigger and rounder".
2. Agent decides it needs the element's selector and styles — not a prose description.
3. Agent enables **Inspect element** and clicks the element; the selection becomes a folded reference
   chip in the composer, which the user reviews and sends.
4. The model receives selector + HTML + non-default styles, so it can edit the file precisely.

### What people (and agents) call it

| Human says (EN) | 中文说法 | What this plugin does |
| --- | --- | --- |
| inspect element, element picker, DOM inspector, devtools picker | 检查元素、元素选择器、拾取元素、拾取页面元素 | Enter element-pick mode over the HTML preview |
| pick element, select element, point at element | 定位元素、选元素、选中页面元素 | Hover-highlight, then click to select |
| CSS selector, element context, extract styles, computed styles | 拿到选择器、提取样式、元素上下文、计算样式 | Insert selector + HTML + non-default styles into the session |
| restyle this div, change this card, tweak this button | 改某个 div、改这个卡片、改这个按钮 | Give the agent the exact node instead of a description |
| in-app devtools, preview inspector | 内置开发者工具、预览调试 | Same gesture as Chrome DevTools' inspect-element picker |

## When NOT to use this

- **Whole-page work** ("make the page responsive", "redesign the header") — reference the file with `@`
  instead; element context adds noise.
- **Running tests, builds, or the app** — use terminal/work tools, not this plugin.
- **Non-HTML previews** (Markdown, PDF, images, code viewers) — this plugin only takes over `.html` /
  `.htm` previews.
- **Quoting a passage of text** from a conversation — the official *Quote text* feature is the right tool.
- **JavaScript runtime debugging** (console, network, performance) — this plugin reports DOM/CSS only,
  not execution state.

## Machine-readable docs (for agents)

Agents can fetch these directly instead of parsing this page:

| File | What it gives an agent |
| --- | --- |
| [llms.txt](https://raw.githubusercontent.com/metaimagine/dsh-web-inspect/main/llms.txt) | one-page plain-text capability + usage summary |
| [docs/capabilities.json](https://raw.githubusercontent.com/metaimagine/dsh-web-inspect/main/docs/capabilities.json) | structured capability card: triggers, inputs/outputs, install, requirements |
| `npm view dsh-web-inspect description keywords` | package metadata |

The **When to use** / **When NOT to use** lists above are written to be copied into an agent's
tool-selection prompt.

## Examples

### 1. "Change this toggle in the design mock"

The demo page is `fixtures/apple-square.html`, a small shape/rounding study. Hover the 圆角 toggle →
tooltip `button#shape-round 44×30`; click it. One folded chip appears in the composer; click the chip to
review exactly what the model will receive:

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

The block is always English — the reader is the agent, not the human who clicked — and the element's own text
(`圆角`) is left exactly as authored. `- Source:` pins the element to the absolute path of the previewed file
(`- URL:` instead when the preview is an http(s) page), so the agent can reopen the document instead of guessing.

### 2. "Why does this button look like this?"

The tooltip already gives the tag, id and rendered size (`44×30`). The inserted context also carries the
computed `padding`, `font-size`, `font-weight`, `background-color` and the `aria-pressed` clue — enough to
restyle that exact button without re-reading the whole page.

### 3. Send once, keep the transcript readable

After sending, the transcript keeps a single folded chip instead of a wall of Markdown, and the session
title stays human-readable (`> Selected element: #shape-round (…`). The model still receives the full
selector, HTML, box, styles and source path.

## How it differs

| Need | Use |
| --- | --- |
| Point at a rendered **element** inside an HTML preview | **dsh-web-inspect** |
| Quote a passage of text from a conversation message | official *Quote text* |
| Reference a **file** by path | official `@` file reference |

These coexist: the official quote preview and `@` references are untouched, and folded inspector chips can
live in the same message as both.

## FAQ

**Do I need to restart `dsh web` after installing or updating?**
No. The profile recomposes automatically; refresh the page to load the new client bundle. A full restart is
only needed for host-side plugins — this plugin's host half is an empty `apply()`.

**I installed it, but my preview still looks like the old one.**
Preview tabs that were already open before installation keep the renderer they were pinned to. Close and
reopen the tab (or open the file again). A hard page refresh also helps if the profile was recomposed while
the page was open.

**What happens with pages that set a strict CSP?**
The inspector script is injected inline into the preview document. If the page's CSP forbids inline scripts
(`script-src` without `'unsafe-inline'`), the runtime cannot start; the status bar tells you inspection is
unavailable for that file. The preview itself still renders. This is a browser-level limitation.

**Can the inspected HTML read my session, cookies, or clipboard?**
No. The iframe is opaque-origin (`sandbox="allow-scripts"`, no `allow-same-origin`), so page scripts have no
access to the DSH app's DOM, cookies, localStorage, or the session API. The parent cannot read the iframe's
DOM either — communication is one-way JSON via `postMessage`.

**Does it send anything automatically?**
No. Selecting an element only inserts a reference chip into the composer. The message is sent only when you
press the send button.

**Can I inspect Markdown, images, or other previews?**
No — the renderer only takes over `.html` / `.htm` document previews. Other preview types are untouched.

**Which DSH versions are supported?**
Tested with DSH Web `0.2.2-rc.1` and Chrome 157 (headless E2E, 31 checks). The plugin uses public client
extension points (`documentPreviews`, slots, `inputTriggers`, `uiConversation`); other versions may work but
are not verified.

**Does it work with relative `<script src>` / `<link>` assets?**
The preview renders an isolated srcdoc document, so relative files are not fetched from the workspace.
Self-contained HTML (inline scripts/styles, `data:` URIs) renders fully; external URLs load if the page
allows them. The builtin DSH previewer packs some relative assets into its blob — this plugin does not.

## Limitations

- **Client-side feature**: the chip/quote behaviour requires this plugin in the DSH Web client. The raw message
  still contains a small sentinel comment (`<!--dsh-web-inspect:v1-->` … `<!--/dsh-web-inspect-->`); other
  clients render it as an invisible comment, and the Markdown stays readable.
- **Opaque origin**: inspecting depends on a same-document runtime; pages that block inline scripts (see FAQ)
  can't be inspected.
- **Relative assets** are not resolved (self-contained HTML works best).
- **Frames and shadow DOM**: nested cross-origin iframes and shadow roots are not traversed; you select the
  top-level frame/host element.
- **Selector is DOM-derived** (`#id` or `tag:nth-of-type` path with a uniqueness check): the context describes
  the element *as currently rendered*; dynamically re-ordered pages may produce a different path later.
- **Chip label is capped at 24 chars** (e.g. `<h1#doc-title>`); very long ids/classes are truncated with `…`.
- **Disabled plugin**: a draft that already contains an inspector chip cannot be sent while the plugin is
  disabled (the host refuses to serialize an unknown reference). Re-enable or remove the chip.
- **Backward compatibility**: messages sent by earlier versions of this plugin (older sentinel names/prefixes)
  keep folding into chips.

## Development

```bash
# engine self-test (pure DOM helpers + fixtures)
node tests/run-engine-selftest.mjs

# full live E2E: self-signed auth cookie, throwaway headless Chrome, raw CDP
# (31 checks: opaque-origin contract, postMessage channel, hover/select, chip insert,
#  real send, bubble fold, legacy compatibility, plain/quote regressions, console clean)
node tools/e2e.mjs

# fast security-path check without sending a real message
node tools/e2e.mjs --no-live-send

# regenerate the two README close-ups from fixtures/apple-square.html
# (own driver, not the E2E harness: right-panel close-up + composer/bubble pair,
#  left sidebar never enters the frame, breadcrumb path redacted at capture time)
node tools/shots.mjs
```

Screenshot checklist and redaction details: [`docs/notes/screenshot-redaction.md`](./docs/notes/screenshot-redaction.md).

No bundler and no JSX: the browser half is a single self-contained `lib/client.js` loaded through
`window.__ModuleLoader__.load`; the host half is an empty `apply()`.

Repo layout:

```text
lib/client.js         browser half: renderer override, injected runtime, slots, chips, bubble folding
lib/index.js          host half (empty apply)
llms.txt              one-page plain-text capability summary for AI agents
docs/capabilities.json structured capability card: triggers, outputs, requirements
docs/PLAN.md          design notes (Chinese)
docs/notes/*.md       verification records: install/auth, sandbox contract, chip/bubble, API research
tools/e2e.mjs         end-to-end harness (raw CDP, zero npm deps)
fixtures/             demo HTML (apple-square.html for screenshots/E2E; inspect-demo.html for legacy assertions)
```

The plugin exposes no host routes and stores no durable state. Install-time notes, auth details for the test
harness, and the security model measurements live in [`docs/notes/`](./docs/notes/) (Chinese).

## License

MIT © 2026 [metaimagine](https://github.com/metaimagine)

If this plugin is useful, a ⭐ on [GitHub](https://github.com/metaimagine/dsh-web-inspect) helps others find it.
