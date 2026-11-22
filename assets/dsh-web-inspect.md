# dsh-web-inspect — element inspector for HTML previews

Turns "that button in the page" into an exact, model-readable element context:
CSS selector, HTML snippet, text, size, key computed styles, positioned ancestor.

## When to use

- The user points at a specific element in an `.html` file previewed in the DSH
  right sidebar ("this button", "这个 div") and wants it changed.
- You need its CSS selector, box size, computed styles or DOM structure before
  editing HTML/CSS/JS.
- The user asks why one widget looks the way it does and needs its real styles.

## When NOT to use

- Whole-page layout rewrites where one selector is not the bottleneck.
- Markdown, image, PDF or any non-HTML preview.
- Reading rendered output text — use the file preview or an `@` file reference.
- Running tests, builds or browser automation; this is a manual picking aid.
- Quoting an entire file or text selection — use the official quote feature.

## How to use

1. Open an `.html` file in the right-sidebar document preview tab.
2. Click 「检查元素」 (Inspect element) in the document tab header.
3. Hover highlights and shows tag/size; click selects the element.
4. The context lands in the composer as a folded chip (`<tag>` / `<tag.class>`);
   `Esc` exits inspect mode, `Backspace` removes a chip.
5. Add one sentence of intent, then send.

## What you receive

A Markdown quote block (folded behind a reference chip): `> Selected element: <css path> (W×H)`,
a fenced HTML snippet, text ≤80 chars, only non-default computed styles
(display, position, color, background-color, font-size, …), `data-*`/aria/inline-style
hints, the nearest positioned ancestor, and a `- Source:` line with the previewed
document's absolute path (or `- URL:` for http(s) pages).
Inserted only — never auto-sent; the user reviews first.
