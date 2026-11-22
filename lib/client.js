/**
 * dsh-web-inspect — browser half (no-build Cordis client plugin).
 *
 * What it does
 * ------------
 * 1. Overrides the builtin `.html/.htm` document-preview renderer with an
 *    `extension`-priority implementation. The builtin iframes are opaque-origin
 *    (`sandbox=""` / `sandbox="allow-scripts"`), so their `contentDocument` is
 *    null and nothing outside can inspect them. Our replacement renders the
 *    same file bytes with `srcdoc` into an iframe sandboxed as
 *    `sandbox="allow-scripts"` (opaque origin: previewed pages cannot reach the
 *    app, its credentials or its APIs).
 * 2. Adds the 「检查元素」 toggle to `sidebar.right.tab.document.actions`
 *    (session-scoped list slot, owner prop `absolutePath`).
 * 3. The inspector runtime is injected into the document itself (first inline
 *    script of the srcdoc). It owns the overlay and the DOM reads, and reports
 *    selections to the parent only through `postMessage`. The parent never
 *    touches `contentDocument`; unlike the builtin renderer, the page's own
 *    scripts still run while staying origin-isolated.
 * 4. The context enters the composer as ONE atomic reference chip (the label is
 *    the tag name, e.g. `<div>`). The chip renders through the host's own
 *    ReferenceChip node; the full Markdown rides inside the chip's `ref` and is
 *    expanded by our registered `inputTriggers` codec at send time, so the
 *    composer never shows the multi-line block. Clicking the chip opens a
 *    popover with the full context. Fallbacks: official quote chip
 *    (`inputActions.insertQuote`) → plain text (`inputActions.insertText`) →
 *    host draft initialization. It never calls `submit()`, so nothing is sent.
 * 5. The sent user bubble also folds the block: the wire text carries
 *    machine-readable sentinels around the full Markdown, and a UserText rule
 *    renders it as the same kind of chip (click to expand). Legacy plain
 *    Markdown messages fold too; the model still receives the full context.
 *
 * Loaded by the web shell as `window.__ModuleLoader__.load({ id, factory })`,
 * exactly like the published plugins: no bundler, no JSX, plain ESM.
 */
window.__ModuleLoader__.load({
	id: "dsh-web-inspect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		let jsx = jsxRuntime.jsx;
		let jsxs = jsxRuntime.jsxs;

		//#region constants + parent-document styles
		/** Locale namespace owned by this plugin. */
		const NS = "dsh-web-inspect";
		/** Document-preview renderer identity shared by metadata and the keyed body. */
		const RENDERER_ID = "dsh-web-inspect/html";
		/** Sandboxed iframe: scripts run, the document keeps an opaque origin (cannot reach the app). */
		const FRAME_SANDBOX = "allow-scripts";
		/** File address prefix emitted by the sidebar document preview. */
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/session/";
		/** Input-trigger source name owning our inline reference chips. */
		const TRIGGER_SOURCE = "inspect";
		/** Trigger character the source registers under (chips are inserted directly, not typed). */
		const TRIGGER_CHAR = "@";
		/** Prefix of the self-contained reference payload stored inside a chip. */
		const CHIP_REF_PREFIX = "dsh-web-inspect:v1:";
		/** Reference prefix written by the pre-rename versions; decoded for existing drafts. */
		const CHIP_REF_PREFIX_LEGACY = "dsh-inspect:v1:";
		/** Reference prefix written by the intermediate (element) release. */
		const CHIP_REF_PREFIX_LEGACY_ELEMENT = "dsh-element-inspect:v1:";
		/** Maximum chip label length (e.g. `<a.btn>`). */
		const CHIP_LABEL_MAX = 24;
		/** UserText rule identity: folds sent context blocks in the user bubble. */
		const USER_TEXT_RULE_ID = "dsh-web-inspect";
		/**
		 * Machine-readable boundaries written around the full context at send time.
		 * The opening sentinel sits on its own line directly after the human-readable
		 * `> Selected element: …` quote line (so chat titles stay readable), the closing
		 * one last.
		 */
		const WIRE_OPEN = "<!--dsh-web-inspect:v1-->";
		const WIRE_CLOSE = "<!--/dsh-web-inspect-->";
		/** Sentinels written by the pre-rename versions; old messages keep folding. */
		const WIRE_OPEN_LEGACY = "<!--dsh-inspect:v1-->";
		const WIRE_CLOSE_LEGACY = "<!--/dsh-inspect-->";
		/** Sentinels written by the intermediate (element) release. */
		const WIRE_OPEN_LEGACY_ELEMENT = "<!--dsh-element-inspect:v1-->";
		const WIRE_CLOSE_LEGACY_ELEMENT = "<!--/dsh-element-inspect-->";
		/** postMessage source tag shared by the parent and the injected runtime. */
		const MESSAGE_SOURCE = "dsh-web-inspect";
		/**
		 * First line of a context block: a blockquote so chat titles and previews stay
		 * human-readable. The Chinese prefix is the legacy form (0.2.0 and earlier);
		 * messages already sent with it must keep folding, so both are recognised.
		 */
		const CONTEXT_START = /^ {0,3}> (?:Selected element:|选中元素：)/u;
		const CONTEXT_START_GLOBAL = /^ {0,3}> (?:Selected element:|选中元素：)/gmu;
		/** Closing hint line of a plain (sentinel-free) block: current English, then legacy. */
		const CONTEXT_FOOTERS = [
			"(Add what you want changed about this element here)",
			"（在这里补充你要对这块 HTML 做的修改）"
		];
		/** Parent-realm CSS (composer-independent; only our own class names). */
		const CSS = `
.__dsh_web_inspect_toggle{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#34363a);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-secondary,#cfd3d6);font:var(--dsw-font-xs-13,12px/16px system-ui);cursor:pointer;white-space:nowrap}
.__dsh_web_inspect_toggle:hover{background:var(--dsw-alias-bg-layer-3,#353638);color:var(--dsw-alias-label-primary,#f9fafb)}
.__dsh_web_inspect_toggle[data-on="true"]{background:var(--dsw-alias-bg-layer-3,#353638);border-color:rgba(147,197,253,.65);color:var(--dsw-alias-label-primary,#f9fafb)}
.__dsh_web_inspect_toggle[data-on="true"] svg{color:#93c5fd}
.__dsh_web_inspect_toggle svg{width:14px;height:14px;flex:none}
.__dsh_web_inspect_frame_wrap{position:relative;display:flex;flex-direction:column;flex:1 1 auto;width:100%;height:100%;min-height:0;min-width:0;background:var(--dsw-alias-bg-base,#151517)}
.__dsh_web_inspect_frame{flex:1 1 auto;width:100%;min-height:0;border:0;display:block;background:#fff}
.__dsh_web_inspect_bar{flex:none;display:flex;align-items:center;gap:8px;padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#34363a);background:var(--dsw-alias-bg-layer-1,#232324);color:var(--dsw-alias-label-secondary,#cfd3d6);font:var(--dsw-font-xs-13,12px/16px system-ui)}
.__dsh_web_inspect_bar[data-tone="error"]{color:#fca5a5}
.__dsh_web_inspect_bar b{font-weight:600;color:var(--dsw-alias-label-primary,#f9fafb)}
/* Folded context chip rendered inside a sent user message bubble. */
.__dsh_web_inspect_bchip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;margin:0 1px;border:1px solid rgba(96,165,250,.55);border-radius:6px;background:rgba(96,165,250,.14);color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;line-height:1;cursor:pointer;vertical-align:baseline;white-space:nowrap}
.__dsh_web_inspect_bchip:hover{background:rgba(96,165,250,.24)}
.__dsh_web_inspect_bchip svg{width:12px;height:12px;flex:none;color:#93c5fd}
/* Composer chips created by this plugin: official ReferenceChip with title="<tag>". */
[data-composer-input] [title^="<"]{border-color:rgba(96,165,250,.55);background:rgba(96,165,250,.14);color:var(--dsw-alias-label-primary,#f9fafb)}
[data-composer-input] [title^="<"] svg{color:#93c5fd}
.__dsh_web_inspect_pop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.55)}
.__dsh_web_inspect_pop_panel{display:flex;flex-direction:column;min-width:min(440px,calc(100vw - 48px));max-width:min(820px,calc(100vw - 48px));max-height:min(72vh,660px);border:1px solid var(--dsw-alias-border-l2,#34363a);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#232324);color:var(--dsw-alias-label-primary,#f9fafb);box-shadow:0 24px 64px rgba(0,0,0,.6);overflow:hidden}
.__dsh_web_inspect_pop_head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#34363a);background:var(--dsw-alias-bg-layer-2,#2c2c2e);color:var(--dsw-alias-label-primary,#f9fafb);font:600 13px/18px system-ui}
.__dsh_web_inspect_pop_head code{font:12px/16px ui-monospace,SFMono-Regular,Menlo,monospace;color:#93c5fd}
.__dsh_web_inspect_pop_head .__dsh_web_inspect_pop_hint{font-weight:400;color:var(--dsw-alias-label-secondary,#cfd3d6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.__dsh_web_inspect_pop_close{margin-left:auto;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#4a4a4f);border-radius:6px;background:var(--dsw-alias-bg-layer-3,#353638);color:var(--dsw-alias-label-primary,#f9fafb);cursor:pointer;font:12px/16px system-ui;flex:none}
.__dsh_web_inspect_pop_body{margin:0;padding:12px 14px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#f9fafb)}
`;
		/** Inject one stylesheet tag into the parent document (once per tag id). */
		function injectParentStyles() {
			const tagId = "dsh-web-inspect/styles";
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-web-inspect";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		injectParentStyles();
		//#endregion

		//#region locales
		const zh = {
			toggle: "检查元素",
			toggleOn: "退出检查",
			title: "HTML（可检查元素）",
			frame: "HTML 文档预览（检查器）",
			hint: "检查元素：悬停高亮，单击选中并插入上下文，Esc 退出",
			inserted: "已插入当前会话输入框（未发送）",
			insertFailed: "插入失败：已复制到剪贴板",
			noSession: "找不到会话，已复制到剪贴板",
			escape: "Esc 退出",
			selected: "已选中",
			chipInserted: "已插入引用块「{tag}」：点击查看完整上下文（未发送）",
			popoverTitle: "选中元素上下文",
			popoverClose: "关闭",
			popoverHint: "发送后模型会收到以下完整内容",
			runtimeBlocked: "该页面的 CSP 或脚本策略阻止了检查脚本，无法检查此元素"
		};
		const en = {
			toggle: "Inspect element",
			toggleOn: "Stop inspecting",
			title: "HTML (inspectable)",
			frame: "HTML preview (inspector)",
			hint: "Inspect: hover to highlight, click to insert context, Esc to exit",
			inserted: "Inserted into the current session input (not sent)",
			insertFailed: "Insert failed: copied to clipboard",
			noSession: "No session found: copied to clipboard",
			escape: "Esc to exit",
			selected: "Selected",
			chipInserted: "Inserted reference chip「{tag}」: click to view full context (not sent)",
			popoverTitle: "Selected element context",
			popoverClose: "Close",
			popoverHint: "The model receives the full content below after sending",
			runtimeBlocked: "This page's CSP or script policy blocked the inspector script"
		};
		//#endregion

		//#region shared toggle store (module scope: header button + every body share it)
		const toggleListeners = new Set();
		let inspectEnabled = false;
		const inspectStore = {
			get() {
				return inspectEnabled;
			},
			set(value) {
				const next = value === true;
				if (inspectEnabled === next) return;
				inspectEnabled = next;
				for (const listener of [...toggleListeners]) {
					try {
						listener();
					} catch (error) {
						console.error("[dsh-web-inspect] listener failed", error);
					}
				}
			},
			subscribe(listener) {
				toggleListeners.add(listener);
				return () => {
					toggleListeners.delete(listener);
				};
			}
		};
		/** Subscribe one component to the shared inspect-mode flag. */
		function useInspectEnabled() {
			const [value, setValue] = react.useState(inspectStore.get());
			react.useEffect(() => inspectStore.subscribe(() => setValue(inspectStore.get())), []);
			return value;
		}
		//#endregion

		//#region engine: element → context
		/**
		 * Build the Markdown context block inserted into the composer. The payload
		 * is produced inside the sandboxed preview iframe (opaque origin), so the
		 * parent only formats and inserts it.
		 *
		 * The block is always English: the agent reading it is not the human who
		 * selected the element, and a mixed-language prompt costs tokens without
		 * adding meaning. Element text is page copy and stays verbatim.
		 * @param info - describe payload received over postMessage, plus optional
		 * provenance fields (`source`/`url`/`previewUrl`) resolved by the parent.
		 * @returns Markdown context block.
		 */
		function formatContextMarkdown(info) {
			if (info === null || info === undefined) return "";
			const lines = [];
			lines.push("> Selected element: " + info.selector + " (" + info.signature + ", " + info.width + "×" + info.height + ")");
			lines.push("");
			lines.push("```html");
			lines.push(info.html === "" ? "<!-- element has no content -->" : info.html);
			lines.push("```");
			lines.push("");
			if (info.text !== "") lines.push("- Text: 「" + info.text + "」");
			const styleEntries = [...info.styles, ...info.spacing];
			if (styleEntries.length > 0) lines.push("- Styles: " + styleEntries.join("; "));
			if (info.clues.length > 0) lines.push("- Clues: " + info.clues.map((clue) => "`" + clue + "`").join(" · "));
			if (info.positionedAncestor !== null && info.positionedAncestor !== undefined) lines.push("- Positioned ancestor: `" + info.positionedAncestor.selector + "` (position: " + info.positionedAncestor.position + ")");
			// Provenance: without it the agent cannot tell which page the HTML came
			// from, so this is the one line the format always tries to emit.
			if (typeof info.source === "string" && info.source !== "") lines.push("- Source: " + info.source);
			if (typeof info.url === "string" && info.url !== "") lines.push("- URL: " + info.url);
			lines.push("");
			lines.push("(Add what you want changed about this element here)");
			return lines.join("\n");
		}

		/**
		 * Self-contained inspector runtime embedded into the preview document.
		 * It runs inside the sandboxed (opaque-origin) iframe: it owns the hover
		 * overlay and tooltip, reads the DOM itself, computes the whole element
		 * context and talks to the parent only through postMessage. The parent
		 * never touches `contentDocument`. Serialized with Function#toString(),
		 * so it must not reference anything from this factory scope.
		 */
		function inspectRuntime() {
			var SOURCE = "dsh-web-inspect";
			var win = window;
			var doc = document;
			if (win.__dsh_web_inspect_runtime__ === true) return;
			win.__dsh_web_inspect_runtime__ = true;
			var STYLE_WHITELIST = ["display", "position", "color", "background-color", "font-size", "font-weight", "z-index", "overflow", "overflow-x", "overflow-y", "border-radius", "opacity", "transform", "flex-direction", "justify-content", "align-items", "gap", "float"];
			var MAX_HTML_LINES = 40;
			var MAX_HTML_CHARS = 4000;
			var TEXT_LIMIT = 80;
			var OVERLAY_CSS = `
.__dsh_web_inspect_hl{position:fixed;z-index:2147483646;pointer-events:none;box-sizing:border-box;border:1px solid #2563eb;background:rgba(37,99,235,.10);border-radius:2px;display:none}
.__dsh_web_inspect_hl[data-pinned="true"]{border:1px solid #f97316;background:rgba(249,115,22,.14)}
.__dsh_web_inspect_tip{position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:320px;padding:3px 6px;border-radius:4px;background:#111827;color:#fff;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.35)}
`;
			var hl = null;
			var tip = null;
			var styleEl = null;
			var current = null;
			var pinned = false;
			var enabled = false;
			var attached = false;
			var originalCursor = "";
			var readyTimer = null;
			var announceTries = 0;

			function post(type, payload) {
				try {
					win.parent.postMessage({ source: SOURCE, type: type, payload: payload === undefined ? null : payload }, "*");
				} catch (error) {
					/* parent channel is best effort */
				}
			}

			function announce() {
				post("ready");
			}

			function escapeIdent(value) {
				if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
				return String(value).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
					return "\\" + ch;
				});
			}

			function isUniqueSelector(selector) {
				try {
					return doc.querySelectorAll(selector).length === 1;
				} catch (error) {
					return false;
				}
			}

			function cssPath(element) {
				if (element === null || typeof element !== "object" || element.nodeType !== 1) return "";
				var parts = [];
				var node = element;
				var guard = 0;
				while (node !== null && node.nodeType === 1 && guard < 200) {
					guard += 1;
					var tag = String(node.tagName || "").toLowerCase();
					if (tag === "html" || tag === "body") {
						parts.unshift(tag);
						break;
					}
					if (node.id !== undefined && node.id !== "") {
						var idSegment = "#" + escapeIdent(node.id);
						var candidate = parts.length === 0 ? idSegment : idSegment + " > " + parts.join(" > ");
						if (isUniqueSelector(candidate)) return candidate;
						parts.unshift(idSegment);
						node = node.parentElement;
						continue;
					}
					var index = 1;
					var sibling = node.previousElementSibling;
					while (sibling !== null) {
						if (sibling.tagName === node.tagName) index += 1;
						sibling = sibling.previousElementSibling;
					}
					parts.unshift(tag + ":nth-of-type(" + index + ")");
					node = node.parentElement;
				}
				var path = parts.join(" > ");
				return path === "" ? String(element.tagName || "").toLowerCase() : path;
			}

			function signatureOf(element) {
				var tag = String(element.tagName || "").toLowerCase();
				var id = element.id === undefined || element.id === "" ? "" : "#" + escapeIdent(element.id);
				var classes = element.classList === undefined ? [] : Array.prototype.slice.call(element.classList);
				return tag + id + (classes.length === 0 ? "" : "." + classes.map(escapeIdent).join("."));
			}

			function textSnippetOf(element) {
				var source = typeof element.innerText === "string" && element.innerText.trim() !== "" ? element.innerText : element.textContent !== null && element.textContent !== undefined ? element.textContent : "";
				var normalized = String(source).replace(/\s+/g, " ").trim();
				if (normalized === "") return "";
				return normalized.length > TEXT_LIMIT ? normalized.slice(0, TEXT_LIMIT) + "…" : normalized;
			}

			function nonDefaultStylesOf(element) {
				var computed = win.getComputedStyle(element);
				var probe = null;
				var baseline = null;
				try {
					probe = doc.createElement(element.tagName);
					probe.setAttribute("data-dsh-web-inspect-probe", "");
					probe.style.cssText = "visibility:hidden;pointer-events:none";
					(doc.body === null ? doc.documentElement : doc.body).appendChild(probe);
					baseline = win.getComputedStyle(probe);
				} catch (error) {
					baseline = null;
				}
				var entries = [];
				for (var index = 0; index < STYLE_WHITELIST.length; index += 1) {
					var property = STYLE_WHITELIST[index];
					var value = computed.getPropertyValue(property);
					if (value === "") continue;
					if (baseline !== null && value === baseline.getPropertyValue(property)) continue;
					if (value === "none" || value === "normal" || value === "auto") continue;
					if (property === "opacity" && value === "1") continue;
					entries.push(property + ": " + value);
				}
				if (probe !== null && probe.parentNode !== null) probe.remove();
				return entries;
			}

			function spacingOf(computed) {
				var entries = [];
				var padding = ["padding-top", "padding-right", "padding-bottom", "padding-left"].map(function (key) {
					return computed.getPropertyValue(key);
				});
				if (padding.some(function (value) { return value !== "" && value !== "0px"; })) entries.push("padding: " + padding.join(" "));
				var margin = ["margin-top", "margin-right", "margin-bottom", "margin-left"].map(function (key) {
					return computed.getPropertyValue(key);
				});
				if (margin.some(function (value) { return value !== "" && value !== "0px"; })) entries.push("margin: " + margin.join(" "));
				return entries;
			}

			function cluesOf(element) {
				var clues = [];
				var attributes = Array.prototype.slice.call(element.attributes === undefined ? [] : element.attributes);
				for (var index = 0; index < attributes.length; index += 1) {
					var attribute = attributes[index];
					var name = attribute.name;
					if (name.indexOf("data-") !== 0 && name.indexOf("aria-") !== 0 && name !== "style" && name !== "src" && name !== "href" && name !== "alt" && name !== "title" && name !== "type" && name !== "role" && name !== "name" && name !== "placeholder") continue;
					var value = attribute.value;
					if (value.length > 120) value = value.slice(0, 120) + "…";
					clues.push(name + '="' + value.replace(/\s+/g, " ").trim() + '"');
				}
				return clues;
			}

			function positionedAncestorOf(element) {
				var node = element.parentElement;
				var guard = 0;
				while (node !== null && guard < 30) {
					guard += 1;
					var tag = String(node.tagName || "").toLowerCase();
					if (tag === "body" || tag === "html") return null;
					var position = win.getComputedStyle(node).getPropertyValue("position");
					if (position !== "static" && position !== "") return { selector: cssPath(node), position: position };
					node = node.parentElement;
				}
				return null;
			}

			function ancestryOf(element) {
				var ancestors = [];
				var node = element.parentElement;
				var guard = 0;
				while (node !== null && guard < 8) {
					guard += 1;
					var tag = String(node.tagName || "").toLowerCase();
					if (tag === "html") break;
					if (tag !== "body") {
						ancestors.push({
							selector: cssPath(node),
							signature: signatureOf(node),
							position: win.getComputedStyle(node).getPropertyValue("position")
						});
					}
					node = node.parentElement;
				}
				return ancestors;
			}

			function snippetOf(element) {
				var html = element.outerHTML === undefined ? "" : element.outerHTML;
				if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS) + "…";
				var lines = html.split("\n");
				if (lines.length <= MAX_HTML_LINES) return html;
				return lines.slice(0, MAX_HTML_LINES).join("\n") + "\n<!-- …truncated: " + lines.length + " lines in total -->";
			}

			function describeElement(element) {
				if (element === null || typeof element !== "object" || element.nodeType !== 1) return null;
				var rect = element.getBoundingClientRect();
				var computed = win.getComputedStyle(element);
				return {
					selector: cssPath(element),
					signature: signatureOf(element),
					tag: String(element.tagName || "").toLowerCase(),
					id: element.id === undefined ? "" : String(element.id),
					classes: element.classList === undefined ? [] : Array.prototype.slice.call(element.classList),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
					text: textSnippetOf(element),
					styles: nonDefaultStylesOf(element),
					spacing: spacingOf(computed),
					clues: cluesOf(element),
					positionedAncestor: positionedAncestorOf(element),
					ancestors: ancestryOf(element),
					html: snippetOf(element)
				};
			}

			function paint(element) {
				if (hl === null || tip === null) return;
				var rect = element.getBoundingClientRect();
				hl.style.display = "block";
				hl.style.left = rect.left + "px";
				hl.style.top = rect.top + "px";
				hl.style.width = Math.max(0, rect.width) + "px";
				hl.style.height = Math.max(0, rect.height) + "px";
				hl.dataset.pinned = pinned ? "true" : "false";
				var label = signatureOf(element) + "  " + Math.round(rect.width) + "×" + Math.round(rect.height);
				tip.textContent = label;
				tip.style.display = "block";
				var margin = 6;
				var top = rect.top - 20;
				if (top < margin) top = rect.bottom + 4;
				tip.style.left = Math.max(margin, Math.min(rect.left, win.innerWidth - 330)) + "px";
				tip.style.top = Math.max(margin, Math.min(top, win.innerHeight - 24)) + "px";
			}

			function targetOf(event) {
				var target = event.target;
				if (target === null || target === undefined || target.nodeType !== 1) return null;
				if (target === hl || target === tip) return null;
				return target;
			}

			function onMove(event) {
				if (pinned) return;
				var target = targetOf(event);
				if (target === null || target === current) return;
				current = target;
				paint(target);
			}

			function onClick(event) {
				var target = targetOf(event);
				if (target === null) return;
				event.preventDefault();
				event.stopPropagation();
				pinned = true;
				current = target;
				paint(target);
				var payload = null;
				try {
					payload = describeElement(target);
				} catch (error) {
					post("error", String(error && error.message ? error.message : error));
				}
				if (payload !== null) post("select", payload);
			}

			function onKeyDown(event) {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				post("exit");
			}

			function onScroll() {
				if (current !== null && current.isConnected === true) paint(current);
				else if (current !== null) {
					current = null;
					if (hl !== null) hl.style.display = "none";
					if (tip !== null) tip.style.display = "none";
				}
			}

			function attach() {
				if (attached || doc.body === null) return;
				styleEl = doc.createElement("style");
				styleEl.setAttribute("data-dsh-web-inspect", "");
				styleEl.textContent = OVERLAY_CSS;
				(doc.head === null ? doc.documentElement : doc.head).appendChild(styleEl);
				hl = doc.createElement("div");
				hl.className = "__dsh_web_inspect_hl";
				tip = doc.createElement("div");
				tip.className = "__dsh_web_inspect_tip";
				doc.body.appendChild(hl);
				doc.body.appendChild(tip);
				originalCursor = doc.documentElement.style.cursor;
				doc.documentElement.style.cursor = "crosshair";
				doc.addEventListener("mousemove", onMove, true);
				doc.addEventListener("click", onClick, true);
				doc.addEventListener("keydown", onKeyDown, true);
				win.addEventListener("scroll", onScroll, true);
				win.addEventListener("resize", onScroll, true);
				attached = true;
			}

			function detach() {
				if (!attached) return;
				doc.removeEventListener("mousemove", onMove, true);
				doc.removeEventListener("click", onClick, true);
				doc.removeEventListener("keydown", onKeyDown, true);
				win.removeEventListener("scroll", onScroll, true);
				win.removeEventListener("resize", onScroll, true);
				doc.documentElement.style.cursor = originalCursor;
				if (hl !== null && hl.parentNode !== null) hl.remove();
				if (tip !== null && tip.parentNode !== null) tip.remove();
				if (styleEl !== null && styleEl.parentNode !== null) styleEl.remove();
				hl = null;
				tip = null;
				styleEl = null;
				current = null;
				pinned = false;
				attached = false;
			}

			function receiveMode(nextEnabled) {
				if (readyTimer !== null) {
					clearInterval(readyTimer);
					readyTimer = null;
				}
				enabled = nextEnabled === true;
				if (!enabled) {
					detach();
					return;
				}
				if (doc.readyState === "loading") {
					doc.addEventListener("DOMContentLoaded", function onReady() {
						doc.removeEventListener("DOMContentLoaded", onReady);
						if (enabled) attach();
					});
					return;
				}
				attach();
			}

			function onMessage(event) {
				var data = event.data;
				if (data === null || typeof data !== "object" || data.source !== SOURCE) return;
				if (data.type === "enable") receiveMode(true);
				else if (data.type === "disable") receiveMode(false);
			}

			win.addEventListener("message", onMessage);
			announce();
			readyTimer = setInterval(function () {
				if (announceTries > 10) {
					clearInterval(readyTimer);
					readyTimer = null;
					return;
				}
				announceTries += 1;
				announce();
			}, 350);
			doc.addEventListener("DOMContentLoaded", function () {
				announce();
				if (enabled) attach();
			});
			win.addEventListener("load", function () {
				announce();
				if (enabled) attach();
			});
		}
		/** Serialized runtime injected at the top of the preview document. */
		const INSPECT_RUNTIME_SOURCE = "(" + inspectRuntime.toString() + ")();";
		/** Script tag written into the preview srcdoc; runs before any page script. */
		const INSPECT_RUNTIME_TAG = "<script data-dsh-web-inspect-runtime=\"1\">" + INSPECT_RUNTIME_SOURCE + "</scr" + "ipt>";
		/**
		 * Insert the inspector runtime at the earliest safe point of a document.
		 * Handles a real <head>, a bare <html>, and documents that start with a
		 * doctype. A page CSP that blocks inline scripts is reported by the parent
		 * after the ready timeout instead of failing silently.
		 * @param html - decoded HTML source.
		 * @returns srcdoc with the runtime first.
		 */
		function buildInspectSrcdoc(html) {
			const source = String(html);
			const headMatch = /<head(\s[^>]*)?>/i.exec(source);
			if (headMatch !== null) {
				const at = headMatch.index + headMatch[0].length;
				return source.slice(0, at) + INSPECT_RUNTIME_TAG + source.slice(at);
			}
			const htmlMatch = /<html(\s[^>]*)?>/i.exec(source);
			if (htmlMatch !== null) {
				const at = htmlMatch.index + htmlMatch[0].length;
				return source.slice(0, at) + INSPECT_RUNTIME_TAG + source.slice(at);
			}
			const doctypeMatch = /^\s*<!doctype[^>]*>/i.exec(source);
			if (doctypeMatch !== null) {
				const at = doctypeMatch.index + doctypeMatch[0].length;
				return source.slice(0, at) + INSPECT_RUNTIME_TAG + source.slice(at);
			}
			return INSPECT_RUNTIME_TAG + source;
		}
		/**
		 * Cheap identity for one decoded source, used as the iframe key so a new
		 * document is mounted (rather than mutated) whenever the file changes.
		 * @param text - decoded HTML source.
		 * @returns stable length + rolling-hash signature.
		 */
		function contentSignatureOf(text) {
			let hash = 0;
			for (let index = 0; index < text.length; index += 1) {
				hash = (hash * 31 + text.charCodeAt(index)) | 0;
			}
			return text.length + ":" + hash;
		}
		//#endregion

		//#region composer insertion (session-scoped; never submits)
		/** Session id encoded in one `dsh-resource://file/session/<id>/<path>` address. */
		function sessionIdOfAddress(address) {
			if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
			const rest = address.slice(FILE_ADDRESS_PREFIX.length);
			const slash = rest.indexOf("/");
			const segment = slash === -1 ? rest : rest.slice(0, slash);
			if (segment === "") return undefined;
			try {
				return decodeURIComponent(segment);
			} catch (error) {
				return segment;
			}
		}
		/**
		 * Absolute paths of previewed documents, remembered from the preview header.
		 *
		 * The path is the one thing no other channel carries: the runtime lives in a
		 * sandboxed `srcdoc` frame (opaque origin, no URL), and the renderer body slot
		 * only receives the resource address. The header actions slot does get the real
		 * `absolutePath`, but only for the selected tab, so we cache the newest few
		 * and resolve a workspace-relative address against them by path suffix.
		 */
		const documentPaths = [];
		const DOCUMENT_PATHS_MAX = 32;
		/** Trailing segment of a `/` or `\\` separated path. */
		function basenameOf(path) {
			const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return slash === -1 ? path : path.slice(slash + 1);
		}
		/**
		 * Cache one absolute document path seen in the preview header.
		 * @param absolutePath - path handed to `sidebar.right.tab.document.actions`.
		 */
		function rememberDocumentPath(absolutePath) {
			if (typeof absolutePath !== "string" || absolutePath === "" || basenameOf(absolutePath) === "") return;
			const seen = documentPaths.indexOf(absolutePath);
			if (seen !== -1) documentPaths.splice(seen, 1);
			documentPaths.push(absolutePath);
			if (documentPaths.length > DOCUMENT_PATHS_MAX) documentPaths.shift();
		}
		/**
		 * Absolute path for a workspace-relative address path, newest first.
		 * A path-suffix match wins over a bare basename match, so `docs/a/index.html`
		 * and `docs/b/index.html` cannot shadow each other.
		 * @param path - relative path from the resource address.
		 * @returns absolute path when one was seen in the header, else undefined.
		 */
		function absoluteDocumentPathOf(path) {
			const suffix = "/" + path;
			for (let index = documentPaths.length - 1; index >= 0; index -= 1) {
				if (documentPaths[index].endsWith(suffix)) return documentPaths[index];
			}
			const basename = basenameOf(path);
			for (let index = documentPaths.length - 1; index >= 0; index -= 1) {
				if (basenameOf(documentPaths[index]) === basename) return documentPaths[index];
			}
			return undefined;
		}
		/** `true` for POSIX (`/…`) and Windows (`C:\\…`) absolute paths. */
		function isAbsolutePath(value) {
			return value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value);
		}
		/** Decoded `<path>` part of `dsh-resource://file/session/<sessionId>/<path>`. */
		function addressPathOf(address) {
			if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
			const rest = address.slice(FILE_ADDRESS_PREFIX.length);
			const slash = rest.indexOf("/");
			if (slash === -1 || slash === rest.length - 1) return undefined;
			try {
				return decodeURIComponent(rest.slice(slash + 1));
			} catch (error) {
				return rest.slice(slash + 1);
			}
		}
		/**
		 * Where the selected element came from, as provenance fields for the context
		 * block. Absolute addresses are used directly; workspace-relative ones are
		 * resolved against the path the preview header reported for that file.
		 * @param address - resource address of the previewed document.
		 * @returns `{source}` for files, `{url}` for http(s) documents, else `{}`.
		 */
		function provenanceOf(address) {
			const path = addressPathOf(address);
			if (path === undefined || path === "") return {};
			if (/^https?:\/\//iu.test(path)) return { url: path };
			if (isAbsolutePath(path)) return { source: path };
			const known = absoluteDocumentPathOf(path);
			return known === undefined ? {} : { source: known };
		}
		/**
		 * Current plain draft of a session's composer (undefined when unavailable).
		 * @param ctx - plugin context.
		 * @param sessionId - target session.
		 * @returns draft text or undefined.
		 */
		function sessionDraftTextOf(ctx, sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return undefined;
			try {
				const scope = ctx.sessions.scope(sessionId);
				const conversation = scope === undefined || scope === null ? undefined : scope.get("conversation");
				const input = conversation === undefined || conversation === null ? undefined : conversation.input.for(scope);
				const snapshot = typeof input?.state?.getSnapshot === "function" ? input.state.getSnapshot() : undefined;
				return typeof snapshot?.draft === "string" ? snapshot.draft : undefined;
			} catch (error) {
				return undefined;
			}
		}
		/**
		 * Append one Markdown block to a session's composer without sending it.
		 * Uses the contract method `requestDraftInitialization(binding, {prompt, whenDraftExists:"append"})`
		 * (SessionInputShell has no `appendDraft`; `setDraft` is destructive and only a last resort).
		 * @param ctx - plugin context (root; the session binding is resolved here).
		 * @param sessionId - target session.
		 * @param markdown - plain Markdown text.
		 * @returns whether the draft accepted the text.
		 */
		function insertMarkdownIntoSession(ctx, sessionId, markdown) {
			if (typeof sessionId !== "string" || sessionId === "") return false;
			try {
				const binding = ctx.sessions.binding(sessionId);
				const conversation = binding === undefined || binding === null ? undefined : ctx.get("conversation");
				if (binding !== undefined && binding !== null && conversation !== undefined && conversation !== null) {
					const result = conversation.input.requestDraftInitialization(binding, {
						prompt: markdown,
						whenDraftExists: "append"
					});
					if (result === "applied" || result === "preserved") return true;
					if (result === "blocked") return false;
				}
			} catch (error) {
				console.warn("[dsh-web-inspect] requestDraftInitialization failed", error);
			}
			// Last resort: overwrite only when the composer holds no text/reference chips.
			try {
				const scope = ctx.sessions.scope(sessionId);
				const conversation = scope === undefined || scope === null ? undefined : scope.get("conversation");
				const input = conversation === undefined || conversation === null ? undefined : conversation.input.for(scope);
				if (input === undefined || input === null) return false;
				const snapshot = typeof input.state?.getSnapshot === "function" ? input.state.getSnapshot() : undefined;
				const existing = typeof snapshot?.draft === "string" ? snapshot.draft : "";
				if (existing.trim() !== "" || (Array.isArray(snapshot?.occurrences) && snapshot.occurrences.length > 0)) return false;
				if (typeof input.setDraft !== "function") return false;
				input.setDraft(markdown);
				return true;
			} catch (error) {
				console.warn("[dsh-web-inspect] draft write fallback failed", error);
				return false;
			}
		}
		//#endregion

		//#region reference chips (atomic composer node + full context on the wire)
		/** Base64url-encode one UTF-8 string (browser realm only). */
		function b64urlEncodeUtf8(text) {
			const bytes = new TextEncoder().encode(text);
			let binary = "";
			const chunk = 0x8000;
			for (let index = 0; index < bytes.length; index += chunk) {
				binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
			}
			return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		}
		/** Decode one base64url UTF-8 string; throws on malformed input. */
		function b64urlDecodeUtf8(value) {
			const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
			const padded = normalized + "===".slice((normalized.length + 3) % 4);
			const binary = atob(padded);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
			return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		}
		/** Self-contained chip reference: the composer keeps it across persistence, so the full Markdown rides inside. */
		function encodeChipRef(markdown, label) {
			return CHIP_REF_PREFIX + b64urlEncodeUtf8(JSON.stringify({ m: markdown, l: label }));
		}
		/** Decode a chip reference produced by encodeChipRef (undefined when foreign/corrupt). */
		function decodeChipRef(ref) {
			if (typeof ref !== "string") return undefined;
			let body = null;
			for (const prefix of [CHIP_REF_PREFIX, CHIP_REF_PREFIX_LEGACY, CHIP_REF_PREFIX_LEGACY_ELEMENT]) {
				if (ref.startsWith(prefix)) {
					body = ref.slice(prefix.length);
					break;
				}
			}
			if (body === null) return undefined;
			try {
				const parsed = JSON.parse(b64urlDecodeUtf8(body));
				if (parsed === null || typeof parsed !== "object") return undefined;
				if (typeof parsed.m !== "string" || typeof parsed.l !== "string") return undefined;
				return { markdown: parsed.m, label: parsed.l };
			} catch (error) {
				return undefined;
			}
		}
		/** Chip label for one described element: `<tag>`, `<tag#id>` or `<tag.class>`, max 24 chars. */
		function chipLabelOf(info) {
			if (info === null || info === undefined) return "<element>";
			const tag = typeof info.tag === "string" && info.tag !== "" ? info.tag : "element";
			let inner = tag;
			if (typeof info.signature === "string" && info.signature !== "") {
				const name = info.signature.slice(tag.length);
				if (name.startsWith("#") || name.startsWith(".")) inner += name;
			}
			const room = CHIP_LABEL_MAX - 2;
			if (inner.length > room) inner = inner.slice(0, room - 1) + "…";
			return "<" + inner + ">";
		}
		/** Parent-document popover showing the full context behind one chip. */
		let contextPopover = null;
		function closeContextPopover() {
			if (contextPopover === null) return;
			contextPopover.remove();
			contextPopover = null;
			document.removeEventListener("keydown", onContextPopoverKey, true);
		}
		function onContextPopoverKey(event) {
			if (event.key !== "Escape" || contextPopover === null) return;
			event.stopPropagation();
			event.preventDefault();
			closeContextPopover();
		}
		function openContextPopover(markdown, label, t) {
			if (typeof document === "undefined") return;
			closeContextPopover();
			const root = document.createElement("div");
			root.className = "__dsh_web_inspect_pop";
			root.setAttribute("data-dsh-web-inspect-popover", label);
			const panel = document.createElement("div");
			panel.className = "__dsh_web_inspect_pop_panel";
			const head = document.createElement("div");
			head.className = "__dsh_web_inspect_pop_head";
			const title = document.createElement("span");
			title.textContent = t("popoverTitle");
			const tag = document.createElement("code");
			tag.textContent = label;
			const close = document.createElement("button");
			close.type = "button";
			close.className = "__dsh_web_inspect_pop_close";
			close.textContent = t("popoverClose");
			close.addEventListener("click", () => closeContextPopover());
			const hint = document.createElement("span");
			hint.className = "__dsh_web_inspect_pop_hint";
			hint.textContent = t("popoverHint");
			head.append(title, tag, hint, close);
			const body = document.createElement("pre");
			body.className = "__dsh_web_inspect_pop_body";
			body.textContent = markdown;
			panel.append(head, body);
			root.append(panel);
			root.addEventListener("pointerdown", (event) => {
				if (event.target === root) closeContextPopover();
			});
			document.body.appendChild(root);
			contextPopover = root;
			document.addEventListener("keydown", onContextPopoverKey, true);
		}
		/**
		 * Insert one atomic reference chip into a session's composer.
		 * The chip label is the short tag text; the full Markdown travels inside `ref`
		 * and is expanded by our registered `codec.serialize` at submit time.
		 * @param ctx - plugin context.
		 * @param sessionId - target session.
		 * @param actions - the slot's InputActions (used only for captureInsertion()).
		 * @param markdown - full context block.
		 * @param label - short chip label, e.g. `<div>`.
		 * @returns whether the chip was inserted.
		 */
		function insertReferenceChip(ctx, sessionId, actions, markdown, label) {
			if (typeof sessionId !== "string" || sessionId === "") return false;
			if (typeof markdown !== "string" || markdown === "") return false;
			const chipLabel = typeof label === "string" && label !== "" ? label : "<element>";
			try {
				const scope = ctx.sessions.scope(sessionId);
				const conversation = scope === undefined || scope === null ? undefined : scope.get("conversation");
				const input = conversation === undefined || conversation === null ? undefined : conversation.input.for(scope);
				if (input === undefined || input === null || typeof input.insertReference !== "function") return false;
				if (actions === undefined || actions === null || typeof actions.captureInsertion !== "function") return false;
				const reference = {
					source: TRIGGER_SOURCE,
					ref: encodeChipRef(markdown, chipLabel),
					label: chipLabel,
					appearance: "file",
					clipboardText: chipLabel
				};
				const first = actions.captureInsertion();
				if (first !== undefined && first !== null && input.insertReference(reference, first) === true) return true;
				const retry = actions.captureInsertion();
				return retry !== undefined && retry !== null && input.insertReference(reference, retry) === true;
			} catch (error) {
				console.warn("[dsh-web-inspect] insertReference failed", error);
				return false;
			}
		}
		/**
		 * Register our InputTriggerSource: makes chips openable (popover) and serializable
		 * (full Markdown at send time). Without a codec the host refuses to send chips.
		 * @param ctx - plugin context.
		 * @returns disposer from the trigger service.
		 */
		function registerInspectTriggerSource(ctx) {
			const t = ctx.locale.bind(NS);
			const source = {
				trigger: TRIGGER_CHAR,
				name: TRIGGER_SOURCE,
				order: 500,
				showGroupTitle: false,
				candidates: async () => [],
				onPick: () => "handled",
				openReference: (_session, reference) => {
					const decoded = decodeChipRef(reference === null || reference === undefined ? undefined : reference.ref);
					if (decoded === undefined) return false;
					openContextPopover(decoded.markdown, decoded.label, t);
					return true;
				},
				codec: {
					clipboardText: (ref) => {
						const decoded = decodeChipRef(ref);
						return decoded === undefined ? "" : decoded.label;
					},
					serialize: async (ref) => {
						const decoded = decodeChipRef(ref);
						if (decoded === undefined) throw new Error("dsh-web-inspect: unknown chip reference");
						return "\n\n" + wrapContextForWire(decoded.markdown) + "\n\n";
					}
				}
			};
			return ctx.inputTriggers.registerSource(source);
		}
		//#endregion

		//#region sent-bubble folding (UserText rule + node component)
		/**
		 * Wrap the full context in machine-readable boundaries for the wire.
		 * The human-readable quote line stays first (so chat titles / previews read
		 * well); the opening sentinel moves to its own line right after it and the
		 * closing sentinel goes last. The model still receives the untouched
		 * Markdown between the comments.
		 * @param markdown - full context block.
		 * @returns text that is written into the sent message.
		 */
		function wrapContextForWire(markdown) {
			const newline = markdown.indexOf("\n");
			const head = newline === -1 ? markdown : markdown.slice(0, newline);
			const rest = newline === -1 ? "" : markdown.slice(newline + 1);
			const body = rest === "" ? "" : rest + "\n";
			return head + "\n" + WIRE_OPEN + "\n" + body + WIRE_CLOSE;
		}
		/**
		 * Derive the bubble chip label (`<h1#doc-title>`) from the context Markdown.
		 * @param markdown - full context block (new or legacy format).
		 * @returns short label, at most CHIP_LABEL_MAX chars.
		 */
		function chipLabelFromMarkdown(markdown) {
			let signature = "";
			try {
				// Current format: `(<signature>, <w>×<h>)` — the last parenthesised group.
				// Legacy (Chinese) format: `（<signature>，…）`.
				const match = /\(([^()\r\n]+?),\s*\d+×\d+\)/u.exec(markdown) ?? /（([^，()\r\n]+)[，)]/u.exec(markdown);
				if (match !== null) signature = match[1].trim();
			} catch (error) {
				signature = "";
			}
			const tag = signature === "" ? "element" : signature;
			const room = CHIP_LABEL_MAX - 2;
			const inner = tag.length > room ? tag.slice(0, room - 1) + "…" : tag;
			return "<" + inner + ">";
		}
		/**
		 * Earliest closing hint line at or after `from` — the block end for plain
		 * (sentinel-free) contexts. Both the current English line and the legacy
		 * Chinese one are accepted so old messages keep folding.
		 * @param text - complete original user text.
		 * @param from - offset the block starts at.
		 * @returns position and length of the footer, or undefined.
		 */
		function footerOf(text, from) {
			let best;
			for (const footer of CONTEXT_FOOTERS) {
				const index = text.indexOf(footer, from);
				if (index === -1) continue;
				if (best === undefined || index < best.index) best = { index, length: footer.length };
			}
			return best;
		}
		/**
		 * Find context blocks in original message text (half-open UTF-16 offsets).
		 * Understands both the sentinel format and the legacy plain-Markdown format.
		 * @param text - complete original user text.
		 * @returns ordered nonempty ranges with decoded Markdown and label.
		 */
		function inspectRangesOf(text) {
			const ranges = [];
			const used = [];
			const sentinels = [
				{ open: WIRE_OPEN, close: WIRE_CLOSE },
				{ open: WIRE_OPEN_LEGACY, close: WIRE_CLOSE_LEGACY },
				{ open: WIRE_OPEN_LEGACY_ELEMENT, close: WIRE_CLOSE_LEGACY_ELEMENT }
			];
			for (const sentinel of sentinels) {
				let from = 0;
				for (;;) {
					const open = text.indexOf(sentinel.open, from);
					if (open === -1) break;
					const close = text.indexOf(sentinel.close, open + sentinel.open.length);
					if (close === -1) break;
					const end = close + sentinel.close.length;
					const inner = text.slice(open + sentinel.open.length, close).replace(/^\r?\n/u, "").replace(/\r?\n$/u, "").trim();
					// The wire starts with a human-readable quote line, then the open
					// sentinel on its own line; pull that line into the folded node.
					const openLineStart = text.lastIndexOf("\n", open - 1) + 1;
					const prevLineStart = openLineStart === 0 ? 0 : text.lastIndexOf("\n", openLineStart - 2) + 1;
					const prevLine = openLineStart === 0 ? "" : text.slice(prevLineStart, openLineStart - 1);
					const readable = CONTEXT_START.test(prevLine);
					const start = readable ? prevLineStart : open;
					const markdown = inner === "" ? prevLine : readable ? prevLine + "\n" + inner : inner;
					const prevEnd = ranges.length === 0 ? -1 : ranges[ranges.length - 1].end;
					if (start > prevEnd) {
						ranges.push({ start, end, markdown, label: chipLabelFromMarkdown(markdown), kind: "sentinel" });
						used.push([start, end]);
					}
					from = end;
				}
			}
			for (const match of text.matchAll(CONTEXT_START_GLOBAL)) {
				const start = match.index;
				if (used.some(([low, high]) => start >= low && start < high)) continue;
				const footer = footerOf(text, start);
				if (footer === undefined) continue;
				const end = footer.index + footer.length;
				if (used.some(([low, high]) => start < high && end > low)) continue;
				const markdown = text.slice(start, end);
				ranges.push({ start, end, markdown, label: chipLabelFromMarkdown(markdown), kind: "legacy" });
			}
			ranges.sort((left, right) => left.start - right.start);
			// A mixed-format edit can leave overlapping candidates; keep the leftmost.
			const merged = [];
			for (const range of ranges) {
				if (merged.length > 0 && range.start < merged[merged.length - 1].end) continue;
				merged.push(range);
			}
			return merged;
		}
		/** Fold context blocks in sent user text; surrounding blank lines collapse to one space. */
		const inspectUserTextRule = {
			id: USER_TEXT_RULE_ID,
			// Must outrank @deepseek-ai/dsh-message-quotes quoteRule (order -10): on
			// the readable wire line both candidates can start at 0, and the host
			// runs rules in ascending order so the first traversal wins the tie.
			order: -20,
			match(text, from) {
				const ranges = inspectRangesOf(text);
				for (const range of ranges) {
					for (const start of [range.start - 2, range.start, range.end]) {
						if (start < from) continue;
						if (start === range.start) {
							return {
								id: USER_TEXT_RULE_ID,
								start,
								end: range.end,
								data: { label: range.label, markdown: range.markdown, kind: range.kind }
							};
						}
						if (text.slice(start, start + 2) === "\n\n") return { id: "text", start, end: start + 2, data: { text: "\n\n", display: " " } };
					}
				}
				return undefined;
			}
		};
		/** Small tag glyph for a folded sent-bubble chip. */
		function ChipGlyph() {
			return jsxs("svg", {
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [
					jsx("path", { d: "M6.2 4 2.4 8l3.8 4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" }),
					jsx("path", { d: "M9.8 4l3.8 4-3.8 4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round" })
				]
			});
		}
		/** Sent-bubble node: chip label that expands the original context on click. */
		function InspectUserText(props) {
			const node = props !== null && props !== undefined ? props.node : undefined;
			const data = node !== null && node !== undefined && typeof node === "object" && node.data !== null && typeof node.data === "object" ? node.data : {};
			const label = typeof data.label === "string" && data.label !== "" ? data.label : "<element>";
			const markdown = typeof data.markdown === "string" ? data.markdown : "";
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const onActivate = () => openContextPopover(markdown, label, t);
			return jsxs("button", {
				type: "button",
				className: "__dsh_web_inspect_bchip",
				title: label,
				"data-dsh-web-inspect-chip": label,
				onPointerDown: (event) => {
					event.preventDefault();
				},
				onClick: onActivate,
				children: [jsx(ChipGlyph, {}), jsx("span", { children: label })]
			});
		}
		//#endregion

		//#region components
		/** Small inline glyph for the toggle button (no icon package dependency). */
		function CrosshairGlyph() {
			return jsxs("svg", {
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [
					jsx("circle", { cx: "8", cy: "8", r: "4.25", stroke: "currentColor", strokeWidth: "1.4" }),
					jsx("path", { d: "M8 1v3M8 12v3M1 8h3M12 8h3", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })
				]
			});
		}
		/**
		 * Header action: toggle inspect mode for HTML previews.
		 * @param props - slot owner props (`absolutePath`) plus locale `t`.
		 */
		function InspectToggleAction(props) {
			const on = useInspectEnabled();
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const path = typeof props.absolutePath === "string" ? props.absolutePath : "";
			// The header is the only slot that knows the real path; remember it for the
			// context block (the body slot only sees the resource address).
			react.useEffect(() => {
				rememberDocumentPath(path);
			}, [path]);
			const lower = path.toLowerCase();
			if (!lower.endsWith(".html") && !lower.endsWith(".htm")) return null;
			return jsxs("button", {
				type: "button",
				className: "__dsh_web_inspect_toggle",
				"data-on": on ? "true" : "false",
				"aria-pressed": on,
				title: on ? t("toggleOn") : t("toggle"),
				onPointerDown: (event) => {
					event.preventDefault();
				},
				onClick: () => {
					inspectStore.set(!inspectStore.get());
				},
				children: [jsx(CrosshairGlyph, {}), jsx("span", { children: on ? t("toggleOn") : t("toggle") })]
			});
		}
		/**
		 * Document body: own the same-origin iframe and attach/detach the inspector.
		 * @param props - keyed body owner props plus injected helpers and locale `t`.
		 */
		/**
		 * Preview body: renders the source in a sandboxed iframe with an opaque
		 * origin. The inspector runtime is injected into the document itself
		 * (see INSPECT_RUNTIME_TAG) and reports back over postMessage, so the
		 * parent never reads `contentDocument` and page scripts stay isolated
		 * from the app origin.
		 * @param props - keyed body owner props plus injected helpers and locale `t`.
		 */
		function InspectHtmlBody(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const enabled = useInspectEnabled();
			const frameRef = react.useRef(null);
			const readyRef = react.useRef(false);
			const enabledRef = react.useRef(enabled);
			const propsRef = react.useRef(props);
			propsRef.current = props;
			const selectRef = react.useRef(null);
			const [html, setHtml] = react.useState(null);
			const [status, setStatus] = react.useState(null);
			react.useEffect(() => {
				const content = propsRef.current.content;
				if (content === null || content === undefined) {
					setHtml(null);
					return;
				}
				let source = null;
				try {
					if (content.kind === "bytes") source = new TextDecoder("utf-8").decode(content.data);
					else if (content.kind === "text") source = content.text;
				} catch (error) {
					source = null;
				}
				setHtml(source);
			}, [props.content]);
			enabledRef.current = enabled;
			/** Tell the runtime (inside the iframe) whether inspect mode is on. */
			const postMode = react.useCallback((nextEnabled) => {
				const frame = frameRef.current;
				if (frame === null) return;
				try {
					const win = frame.contentWindow;
					if (win === null) return;
					win.postMessage({ source: MESSAGE_SOURCE, type: nextEnabled ? "enable" : "disable" }, "*");
				} catch (error) {
					/* iframe not ready yet; the runtime announces itself later */
				}
			}, []);
			react.useEffect(() => {
				readyRef.current = false;
			}, [html]);
			react.useEffect(() => {
				if (!readyRef.current) return;
				postMode(enabled);
			}, [enabled, postMode]);
			// The runtime announces `ready` from inside the document; a document CSP
			// that blocks inline scripts never reports, so surface that explicitly.
			react.useEffect(() => {
				if (!enabled || html === null) return undefined;
				const timer = window.setTimeout(() => {
					if (readyRef.current) return;
					setStatus({ tone: "error", text: propsRef.current.t("runtimeBlocked") });
				}, 2500);
				return () => window.clearTimeout(timer);
			}, [enabled, html]);
			react.useEffect(() => {
				if (!enabled) setStatus(null);
			}, [enabled]);
			// Escape leaves inspect mode from either realm: when focus is in the
			// preview the runtime reports it over postMessage, and when focus is
			// in the app this listener covers the case (an open chip popover
			// handles Escape itself and stops propagation first).
			react.useEffect(() => {
				if (!enabled) return undefined;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (contextPopover !== null) return;
					event.preventDefault();
					inspectStore.set(false);
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [enabled]);
			selectRef.current = (payload) => {
				const current = propsRef.current;
				const info = payload;
				const address = typeof current.resourceAddress === "string" ? current.resourceAddress : "";
				// Resolve provenance first: the block must say which document it came from.
				const markdown = formatContextMarkdown({ ...info, ...provenanceOf(address) });
				const chipLabel = chipLabelOf(info);
				const wireMarkdown = wrapContextForWire(markdown);
				const sessionId = typeof current.sessionId === "string" && current.sessionId !== "" ? current.sessionId : sessionIdOfAddress(address);
				const insertChip = typeof current.insertChip === "function" ? current.insertChip : () => false;
				const insertContext = typeof current.insertContext === "function" ? current.insertContext : () => false;
				const draftText = typeof current.draftText === "function" ? current.draftText : () => "";
				const actions = current.inputActions;
				let inserted = false;
				let chipMode = false;
				if (sessionId !== null && actions !== undefined && actions !== null) {
					try {
						inserted = insertChip(sessionId, actions, markdown, chipLabel) === true;
						chipMode = inserted;
					} catch (error) {
						inserted = false;
						chipMode = false;
					}
					if (!inserted) {
						try {
							inserted = actions.insertQuote(markdown) === true;
							chipMode = inserted;
						} catch (error) {
							inserted = false;
							chipMode = false;
						}
					}
					if (!inserted) {
						let existing = "";
						try {
							existing = draftText(sessionId);
						} catch (error) {
							existing = "";
						}
						const separator = typeof existing === "string" && existing.trim() !== "" ? "\n\n" : "";
						try {
							inserted = actions.insertText(separator + wireMarkdown, actions.captureInsertion()) === true;
						} catch (error) {
							inserted = false;
						}
						if (!inserted) {
							try {
								inserted = actions.insertText(separator + wireMarkdown, actions.captureInsertion()) === true;
							} catch (error) {
								inserted = false;
							}
						}
					}
				}
				if (!inserted && sessionId !== null) {
					try {
						inserted = insertContext(sessionId, wireMarkdown) === true;
					} catch (error) {
						inserted = false;
					}
				}
				if (inserted) {
					const message = chipMode ? current.t("chipInserted") : current.t("inserted");
					setStatus({ tone: "ok", text: message.replace("{tag}", chipLabel) });
					return;
				}
				setStatus({ tone: "error", text: current.t("insertFailed") });
				try {
					const clipboard = window.navigator === undefined ? null : window.navigator.clipboard;
					if (clipboard !== null && clipboard !== undefined) clipboard.writeText(markdown);
				} catch (error) {
					/* clipboard unavailable: the status text is the only fallback */
				}
			};
			react.useEffect(() => {
				const onMessage = (event) => {
					const frame = frameRef.current;
					if (frame === null || event.source !== frame.contentWindow) return;
					const data = event.data;
					if (data === null || typeof data !== "object" || data.source !== MESSAGE_SOURCE) return;
					if (data.type === "ready") {
						readyRef.current = true;
						postMode(enabledRef.current);
						return;
					}
					if (data.type === "select") {
						const handler = selectRef.current;
						if (handler !== null) handler(data.payload);
						return;
					}
					if (data.type === "exit") {
						inspectStore.set(false);
						return;
					}
					if (data.type === "error") {
						setStatus({ tone: "error", text: propsRef.current.t("runtimeBlocked") });
					}
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			}, [postMode]);
			// Render the iframe only once the source is known, so the sandboxed
			// document is created with its final `srcdoc` in one navigation. A
			// sandboxed `srcdoc` frame that first mounts empty and only later gets
			// its attribute filled may drop that follow-up navigation, leaving a
			// blank preview; remounting per source change keeps the load reliable.
			if (html === null) return null;
			const srcdoc = buildInspectSrcdoc(html);
			return jsxs("div", {
				className: "__dsh_web_inspect_frame_wrap",
				children: [
					enabled
						? jsx("div", {
								className: "__dsh_web_inspect_bar",
								"data-tone": status === null ? "hint" : status.tone,
								children: status === null ? t("hint") : status.text
							})
						: null,
					jsx("iframe", {
						key: contentSignatureOf(html),
						ref: frameRef,
						className: "__dsh_web_inspect_frame",
						title: t("frame"),
						sandbox: FRAME_SANDBOX,
						srcDoc: srcdoc,
						"data-dsh-web-inspect-frame": true,
						onLoad: () => {
							// Backstop for the ready handshake: the runtime also announces
							// itself, but if it could not run we still push the current mode.
							readyRef.current = true;
							postMode(enabledRef.current);
						}
					})
				]
			});
		}

		//#endregion

		//#region plugin
		/** Services this browser half waits for. */
		const inject = ["slots", "locale", "sessions", "documentPreviews", "inputTriggers", "uiConversation"];
		/**
		 * Register dictionaries, the HTML renderer override, its body and the header toggle.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-web-inspect: dictionaries");
			ctx.effect(() => registerInspectTriggerSource(ctx), "dsh-web-inspect: reference chip source");
			ctx.effect(() => ctx.uiConversation.userText.register(inspectUserTextRule), "dsh-web-inspect: user text rule");
			ctx.slots.inject("conversation.user.text.node", () => ctx.slots.register({
				name: "conversation.user.text.node",
				key: USER_TEXT_RULE_ID,
				priority: 100,
				locale: NS
			}, InspectUserText));
			ctx.effect(() => ctx.documentPreviews.register({
				id: RENDERER_ID,
				extensions: ["html", "htm"],
				priority: "extension",
				title: () => t("title"),
				loading: "bytes-complete",
				wrap: false
			}), "dsh-web-inspect: html renderer metadata");
			ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
				name: "sidebar.right.tab.document",
				key: RENDERER_ID,
				locale: NS,
				inject: () => ({
					insertContext: (sessionId, markdown) => insertMarkdownIntoSession(ctx, sessionId, markdown),
					insertChip: (sessionId, actions, markdown, label) => insertReferenceChip(ctx, sessionId, actions, markdown, label),
					draftText: (sessionId) => sessionDraftTextOf(ctx, sessionId)
				})
			}, InspectHtmlBody));
			ctx.slots.inject("sidebar.right.tab.document.actions", () => ctx.slots.register({
				name: "sidebar.right.tab.document.actions",
				id: "dsh-web-inspect",
				locale: NS,
				order: 100
			}, InspectToggleAction));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "dsh-web-inspect";
		return module.exports;
	}
});
