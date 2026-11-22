/**
 * dsh-inspect — dependency-free, framework-free DOM inspector engine.
 *
 * The engine is attached to ANY Document (in practice: our own same-origin preview
 * iframe's document). It never assumes it owns the page/window: it only reads layout,
 * injects its own overlay nodes, and removes/restores everything on disable().
 *
 * LOADING (this file has NO top-level import/export so its text can be embedded as the
 * body of the plugin loader's factory function):
 *   (a) Browser plugin loader — window.__ModuleLoader__.load({factory}): put this file's
 *       text inside the factory body (top-level `export` is illegal there), evaluate it,
 *       then read `globalThis.__DSH_INSPECT_ENGINE__`.
 *   (b) Classic script: <script src="lib/inspector.js"></script> -> same global.
 *   (c) ESM (this package is `"type": "module"`, so this file IS an ES module in Node):
 *         import './lib/inspector.js';   // side effect: defines the global
 *         const { createInspector, describeElement, formatContextMarkdown, cssPath } =
 *           globalThis.__DSH_INSPECT_ENGINE__;
 *       Do NOT rely on CommonJS `require()` here: under `"type": "module"` Node loads
 *       this file as ESM and `require()` yields an empty namespace — the global is the
 *       only handoff point (the `module.exports` branch below only fires if someone
 *       explicitly loads the file as CommonJS, e.g. in a `.cjs`-scoped context).
 *   If a native named-export module is ever wanted, append exactly this line at the
 *   bottom of a COPY of the file (do not add it to this file itself):
 *         export const { createInspector, describeElement, formatContextMarkdown,
 *                        cssPath } = globalThis.__DSH_INSPECT_ENGINE__;
 *
 * API
 *   createInspector(doc, opts) -> { enable, disable, destroy, isEnabled, getSelection }
 *     opts = {
 *       onSelect(ctxObj),          // called on click-selection
 *       onHover(ctxObj | null),    // called when the hovered element changes
 *       color,                     // hover accent, default '#2f7cf6'
 *       selectionColor,            // selection accent, default '#f43f5e'
 *       zIndex                     // overlay stacking, default 2147483000
 *     }
 *   describeElement(el, doc) -> ctxObj
 *   formatContextMarkdown(ctxObj) -> string
 *   cssPath(el, doc) -> string    // uniqueness-verified CSS selector
 *
 * KNOWN LIMITATIONS
 *   - Cross-origin iframes cannot be inspected (opaque origin; events over them never
 *     reach the parent at all).
 *   - Same-origin nested iframes are tracked (depth <= 4) and resolve to the <iframe>
 *     element itself, which is what gets selected/described.
 *   - Shadow DOM: the deepest element inside a shadow root resolves to its host element
 *     (document.querySelector cannot cross shadow boundaries).
 *   - Elements inside scaled/rotated ancestor transforms: the overlay is positioned from
 *     getBoundingClientRect deltas, so scale/rotate are approximated.
 *   - The document's own scroll behavior/overflow is never modified.
 */
(function (global, factory) {
  'use strict';
  var api = factory(global);
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
  if (global) {
    try { global.__DSH_INSPECT_ENGINE__ = api; } catch (e) { /* ignore */ }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  var XHTML_NS = 'http://www.w3.org/1999/xhtml';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ACTIVE_CLASS = 'dsh-inspect-active';
  var OVERLAY_ATTR = 'data-dsh-inspect-overlay';
  var PART_ATTR = 'data-dsh-inspect-part';
  var Z_DEFAULT = 2147483000;
  var MAX_TEXT = 80;
  var MAX_MARKDOWN_HTML = 600;
  var MAX_CTX_HTML = 4000;
  var MAX_HINTS = 8;
  var MAX_DATA_HINTS = 6;

  var ACTIVE_CSS = [
    '.' + ACTIVE_CLASS + ', .' + ACTIVE_CLASS + ' * {',
    '  cursor: crosshair !important;',
    '  -webkit-user-select: none !important;',
    '  user-select: none !important;',
    '}',
    '.' + ACTIVE_CLASS + ' ::selection { background: transparent !important; }',
    '.' + ACTIVE_CLASS + ' input, .' + ACTIVE_CLASS + ' textarea { caret-color: transparent !important; }'
  ].join('\n');

  var DEFAULT_CACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var EMPTY_DEFAULTS = {
    display: '', position: '', color: '', backgroundColor: '', fontSize: '',
    zIndex: '', borderRadius: '', opacity: '', transform: '',
    padding: '', margin: ''
  };

  /* ------------------------------------------------------------------ *
   * small generic helpers
   * ------------------------------------------------------------------ */

  function clip(str, max) {
    var s = String(str == null ? '' : str);
    if (max <= 0) return '';
    if (s.length <= max) return s;
    if (max === 1) return '…';
    return s.slice(0, max - 1) + '…';
  }

  function collapseWs(str) {
    return String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  }

  function attr(el, name) {
    try { return el && el.getAttribute ? el.getAttribute(name) : null; } catch (e) { return null; }
  }

  function isHtmlNamespace(el) {
    return !el.namespaceURI || el.namespaceURI === XHTML_NS;
  }

  function tagNameOf(el) {
    var raw = (el && (el.tagName || el.nodeName)) || '';
    if (!raw) return '';
    return isHtmlNamespace(el) ? String(raw).toLowerCase() : String(raw);
  }

  function classNamesOf(el) {
    var raw = attr(el, 'class') || '';
    var parts = String(raw).split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
    return out;
  }

  function tagLabelOf(el) {
    var label = tagNameOf(el);
    var id = attr(el, 'id');
    if (id) label += '#' + id;
    var classes = classNamesOf(el);
    for (var i = 0; i < classes.length && i < 3; i++) label += '.' + classes[i];
    return label;
  }

  /* CSS.escape fallback (spec algorithm shape, limited but safe for ids/classes). */
  function escapeIdent(value) {
    var s = String(value == null ? '' : value);
    if (!s) return '';
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      try { return CSS.escape(s); } catch (e) { /* fall through */ }
    }
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      var ch = s.charAt(i);
      if (code === 0) { out += '\uFFFD'; continue; }
      if ((code >= 1 && code <= 31) || code === 127) { out += '\\' + code.toString(16) + ' '; continue; }
      if (i === 0 && code >= 48 && code <= 57) { out += '\\' + code.toString(16) + ' '; continue; }
      if (i === 1 && code >= 48 && code <= 57 && s.charCodeAt(0) === 45) {
        out += '\\' + code.toString(16) + ' ';
        continue;
      }
      if (code >= 128 || ch === '-' || ch === '_' ||
          (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        out += ch;
      } else {
        out += '\\' + ch;
      }
    }
    return out;
  }

  function isUniqueSelector(selector, doc) {
    if (!selector || !doc || !doc.querySelectorAll) return false;
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function nthOfType(el) {
    var n = 1;
    var sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) n++;
      sib = sib.previousElementSibling;
    }
    return n;
  }

  function simpleSegment(el) {
    var seg = tagNameOf(el);
    var classes = classNamesOf(el);
    for (var i = 0; i < classes.length; i++) {
      /* only readable identifiers make the selector nicer; others are skipped */
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(classes[i])) {
        seg += '.' + escapeIdent(classes[i]);
        break;
      }
    }
    return seg;
  }

  function absolutePath(el, doc) {
    var root = doc && doc.documentElement;
    var segs = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 40) {
      if (node === root) { segs.unshift('html'); break; }
      segs.unshift(tagNameOf(node) + ':nth-of-type(' + nthOfType(node) + ')');
      node = node.parentElement;
    }
    return segs.join(' > ');
  }

  /**
   * Uniqueness-verified CSS selector for `el` inside `doc`.
   * Prefers a unique #id; otherwise walks up building tag/class + :nth-of-type
   * segments; verifies with querySelectorAll at every step; falls back to a full
   * absolute nth-of-type chain. Capped at 12 levels.
   */
  function cssPath(el, doc) {
    doc = doc || (el && el.ownerDocument);
    if (!doc || !el || el.nodeType !== 1) return '';
    var root = doc.documentElement;
    if (!el || el === root) return 'html';

    var id = attr(el, 'id');
    if (id) {
      var idSelector = '#' + escapeIdent(id);
      if (isUniqueSelector(idSelector, doc)) return idSelector;
    }

    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      var seg = simpleSegment(node);
      parts.unshift(seg);
      var candidate = parts.join(' > ');
      if (!isUniqueSelector(candidate, doc)) {
        parts[0] = seg + ':nth-of-type(' + nthOfType(node) + ')';
        candidate = parts.join(' > ');
      }
      if (isUniqueSelector(candidate, doc)) return candidate;
      if (node === root) break;
      var parent = node.parentElement;
      if (!parent) break;
      node = parent;
      depth++;
    }

    var abs = absolutePath(el, doc);
    return abs || parts.join(' > ');
  }

  /* ------------------------------------------------------------------ *
   * computed-style defaults probe (tag-level UA defaults)
   * ------------------------------------------------------------------ */

  function toCamel(prop) {
    return String(prop).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
  }

  function csGet(cs, prop) {
    if (!cs) return '';
    var value = '';
    try {
      value = cs.getPropertyValue ? cs.getPropertyValue(prop) : cs[toCamel(prop)];
    } catch (e) {
      value = '';
    }
    return value == null ? '' : String(value).trim();
  }

  function shorthand(t, r, b, l) {
    var vals = [t || '0px', r || '0px', b || '0px', l || '0px'];
    if (vals[1] === vals[3]) vals.pop();
    if (vals.length === 3 && vals[0] === vals[2]) vals.pop();
    if (vals.length === 2 && vals[0] === vals[1]) vals.pop();
    return vals.join(' ');
  }

  function snapshotStyles(cs) {
    return {
      display: csGet(cs, 'display'),
      position: csGet(cs, 'position'),
      color: csGet(cs, 'color'),
      backgroundColor: csGet(cs, 'background-color'),
      fontSize: csGet(cs, 'font-size'),
      zIndex: csGet(cs, 'z-index'),
      borderRadius: csGet(cs, 'border-radius'),
      opacity: csGet(cs, 'opacity'),
      transform: csGet(cs, 'transform'),
      padding: shorthand(
        csGet(cs, 'padding-top'), csGet(cs, 'padding-right'),
        csGet(cs, 'padding-bottom'), csGet(cs, 'padding-left')
      ),
      margin: shorthand(
        csGet(cs, 'margin-top'), csGet(cs, 'margin-right'),
        csGet(cs, 'margin-bottom'), csGet(cs, 'margin-left')
      )
    };
  }

  /**
   * UA/default computed styles for a tag. A probe element is created inside a
   * `all:initial` wrapper in a closed shadow root (detached elements return empty
   * computed styles in Chrome, and inheritance must not leak in from the page), its
   * computed style is snapshotted, then the probe is removed. Cached per (doc, tag,type).
   */
  function buildProbe(doc, tag, type, ns) {
    var win = doc.defaultView;
    if (!win || typeof win.getComputedStyle !== 'function') return null;
    var parent = doc.body || doc.documentElement;
    if (!parent) return null;
    var host = doc.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute!important;left:-999999px!important;top:0!important;' +
      'width:0!important;height:0!important;overflow:hidden!important;visibility:hidden!important;' +
      'pointer-events:none!important;contain:strict!important;';
    var target = null;
    try {
      if (typeof host.attachShadow === 'function') {
        var shadow = host.attachShadow({ mode: 'closed' });
        var reset = doc.createElement('div');
        reset.style.cssText = 'all:initial;display:block;';
        target = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
        if (type) { try { target.setAttribute('type', type); } catch (e) { /* ignore */ } }
        reset.appendChild(target);
        shadow.appendChild(reset);
      }
    } catch (e) {
      target = null;
    }
    if (!target) {
      target = ns ? doc.createElementNS(ns, tag) : doc.createElement(tag);
      if (type) { try { target.setAttribute('type', type); } catch (e) { /* ignore */ } }
      host.appendChild(target);
    }
    parent.appendChild(host);
    var out = null;
    try {
      out = snapshotStyles(win.getComputedStyle(target));
    } catch (e) {
      out = null;
    }
    if (host.parentNode) host.parentNode.removeChild(host);
    return out;
  }

  function defaultsFor(doc, el, tag, type) {
    if (!doc) return EMPTY_DEFAULTS;
    var key = tag + (type ? '|' + type : '');
    var ns = !isHtmlNamespace(el) ? (el.namespaceURI || SVG_NS) : null;
    var map = null;
    if (DEFAULT_CACHE) {
      try {
        map = DEFAULT_CACHE.get(doc);
        if (!map) { map = {}; DEFAULT_CACHE.set(doc, map); }
      } catch (e) {
        map = null;
      }
    }
    if (map && map[key]) return map[key];
    var probe = buildProbe(doc, tag, type, ns);
    if (!probe) probe = EMPTY_DEFAULTS;
    if (map) map[key] = probe;
    return probe;
  }

  /* ------------------------------------------------------------------ *
   * describeElement
   * ------------------------------------------------------------------ */

  function collapsibleText(el) {
    var text = '';
    try {
      var tag = tagNameOf(el);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        var type = String(attr(el, 'type') || '').toLowerCase();
        var valueOk = tag !== 'input' ||
          (type !== 'checkbox' && type !== 'radio' && type !== 'file' &&
           type !== 'range' && type !== 'color' && type !== 'hidden');
        if (valueOk && el.value != null) text = String(el.value);
      }
      if (!text && el.textContent) text = String(el.textContent);
    } catch (e) {
      text = '';
    }
    text = collapseWs(text);
    return text ? clip(text, MAX_TEXT) : '';
  }

  function collectHints(el) {
    var hints = [];
    function add(name, value, max) {
      if (value == null) return;
      value = collapseWs(String(value));
      if (!value) return;
      hints.push({ name: name, value: clip(value, max || 80) });
    }
    var attrs = el.attributes || [];
    var dataCount = 0;
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (!a || !a.name || dataCount >= MAX_DATA_HINTS) continue;
      if (/^data-/i.test(a.name)) {
        add(a.name, a.value);
        dataCount++;
      }
    }
    var inlineStyle = attr(el, 'style');
    if (inlineStyle && inlineStyle.trim()) add('style', inlineStyle.trim(), 160);
    add('role', attr(el, 'role'));
    add('aria-label', attr(el, 'aria-label'));
    add('href', attr(el, 'href'), 140);
    add('src', attr(el, 'src'), 120);
    add('srcset', attr(el, 'srcset'), 120);
    add('alt', attr(el, 'alt'));
    add('title', attr(el, 'title'));
    var tag = tagNameOf(el);
    if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea') {
      add('type', attr(el, 'type'));
      add('name', attr(el, 'name'));
      add('placeholder', attr(el, 'placeholder'));
    }
    var classes = classNamesOf(el);
    if (classes.length > 3) add('class', classes.join(' '), 100);
    return hints.slice(0, MAX_HINTS);
  }

  function outerHtmlOf(el) {
    var html = '';
    try {
      if (typeof el.outerHTML === 'string') html = el.outerHTML;
      else {
        var ow = el.ownerDocument && el.ownerDocument.defaultView;
        if (ow && ow.XMLSerializer) html = new ow.XMLSerializer().serializeToString(el);
      }
    } catch (e) {
      html = '';
    }
    return html.length > MAX_CTX_HTML ? clip(html, MAX_CTX_HTML) : html;
  }

  /**
   * Describe one element into a plain context object (consumed by
   * formatContextMarkdown and by the plugin's onSelect/onHover callbacks).
   */
  function describeElement(el, doc) {
    if (!el || el.nodeType !== 1) return null;
    doc = doc || el.ownerDocument;
    var edoc = el.ownerDocument || doc;
    var tag = tagNameOf(el);
    var id = attr(el, 'id') || '';
    var classes = classNamesOf(el);

    var box = { w: 0, h: 0 };
    try {
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (rect) {
        box.w = Math.round(rect.width);
        box.h = Math.round(rect.height);
      }
    } catch (e) { /* hidden or exotic element */ }

    var win = null;
    try { win = edoc && edoc.defaultView; } catch (e) { win = null; }
    var cs = null;
    try { cs = win && win.getComputedStyle ? win.getComputedStyle(el) : null; } catch (e) { cs = null; }

    var defaults = cs ? defaultsFor(edoc, el, tag, tag === 'input' ? attr(el, 'type') : '') : null;
    var styles = {};
    var padding = '';
    var margin = '';
    if (cs) {
      var d = defaults || EMPTY_DEFAULTS;
      pushStyle(styles, 'display', csGet(cs, 'display'), d.display);
      pushStyle(styles, 'position', csGet(cs, 'position'), d.position);
      pushStyle(styles, 'color', csGet(cs, 'color'), d.color);
      pushStyle(styles, 'background-color', csGet(cs, 'background-color'), d.backgroundColor);
      pushStyle(styles, 'font-size', csGet(cs, 'font-size'), d.fontSize);
      pushStyle(styles, 'z-index', csGet(cs, 'z-index'), d.zIndex);
      pushStyle(styles, 'border-radius', csGet(cs, 'border-radius'), d.borderRadius);
      pushStyle(styles, 'opacity', csGet(cs, 'opacity'), d.opacity);
      pushStyle(styles, 'transform', csGet(cs, 'transform'), d.transform);
      var p = shorthand(
        csGet(cs, 'padding-top'), csGet(cs, 'padding-right'),
        csGet(cs, 'padding-bottom'), csGet(cs, 'padding-left')
      );
      var m = shorthand(
        csGet(cs, 'margin-top'), csGet(cs, 'margin-right'),
        csGet(cs, 'margin-bottom'), csGet(cs, 'margin-left')
      );
      if (p && p !== d.padding) padding = p;
      if (m && m !== d.margin) margin = m;
    }

    var selector = '';
    try { selector = cssPath(el, doc); } catch (e) { selector = ''; }
    if (!selector) selector = tagLabelOf(el);

    return {
      selector: selector,
      tag: tag,
      tagLabel: tagLabelOf(el),
      id: id,
      classes: classes,
      text: collapsibleText(el),
      box: box,
      padding: padding,
      margin: margin,
      styles: styles,
      hints: collectHints(el),
      html: outerHtmlOf(el)
    };
  }

  function pushStyle(styles, key, value, defaultValue) {
    if (!value) return;
    var def = defaultValue == null ? '' : String(defaultValue).trim();
    if (value === def) return;
    styles[key] = value;
  }

  /* ------------------------------------------------------------------ *
   * formatContextMarkdown
   * ------------------------------------------------------------------ */

  function prettyHtml(html) {
    var s = collapseWs(html);
    if (!s) return '';
    if (s.length > 200) s = s.replace(/></g, '>\n<');
    if (s.length > MAX_MARKDOWN_HTML) s = clip(s, MAX_MARKDOWN_HTML);
    return s;
  }

  /**
   * Render a describeElement() context object as the Markdown block that gets
   * inserted into the chat input. English on purpose: the reader is an agent,
   * not the human who picked the element, and element text is page copy that
   * stays exactly as authored. `ctx.source` (absolute path) or `ctx.url`
   * (http(s) page) add the provenance line when the caller knows it.
   * Ends with one trailing empty line.
   */
  function formatContextMarkdown(ctx) {
    if (!ctx) return '';
    var selector = String(ctx.selector || ctx.tagLabel || ctx.tag || '');
    var signature = String(ctx.tagLabel || ctx.tag || '');
    var width = Math.round(ctx.box && ctx.box.w || 0);
    var height = Math.round(ctx.box && ctx.box.h || 0);
    var lines = [];
    var quote = '> Selected element: `' + selector.replace(/`/g, '') + '`';
    if (signature) quote += ' (' + signature + ', ' + width + '×' + height + ')';
    lines.push(quote);
    lines.push('');
    var html = prettyHtml(ctx.html);
    if (html) {
      lines.push('```html');
      lines.push(html);
      lines.push('```');
      lines.push('');
    }
    if (ctx.text) lines.push('- Text: 「' + String(ctx.text) + '」');
    var styleParts = [];
    var styles = ctx.styles || {};
    for (var key in styles) {
      if (!Object.prototype.hasOwnProperty.call(styles, key)) continue;
      styleParts.push(key + ': ' + styles[key]);
    }
    if (ctx.padding) styleParts.push('padding: ' + ctx.padding);
    if (ctx.margin) styleParts.push('margin: ' + ctx.margin);
    if (styleParts.length) lines.push('- Styles: ' + styleParts.join('; '));
    var hintParts = [];
    var hints = ctx.hints || [];
    for (var i = 0; i < hints.length; i++) {
      if (!hints[i] || !hints[i].name) continue;
      hintParts.push('`' + hints[i].name + '="' + String(hints[i].value == null ? '' : hints[i].value) + '"`');
    }
    if (hintParts.length) lines.push('- Clues: ' + hintParts.join(' · '));
    if (ctx.source) lines.push('- Source: ' + String(ctx.source));
    if (ctx.url) lines.push('- URL: ' + String(ctx.url));
    lines.push('');
    lines.push('(Add what you want changed about this element here)');
    return lines.join('\n') + '\n\n';
  }

  /* ------------------------------------------------------------------ *
   * createInspector
   * ------------------------------------------------------------------ */

  function hexToRgba(hex, alpha) {
    if (typeof hex !== 'string') return '';
    var h = hex.trim();
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return '';
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function safeCall(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (err) {
      try {
        if (global && global.console && console.error) {
          console.error('[dsh-inspect] callback threw:', err);
        }
      } catch (e) { /* ignore */ }
    }
  }

  function isEscapeEvent(ev) {
    if (!ev) return false;
    return ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27;
  }

  function createInspector(doc, opts) {
    if (!doc || doc.nodeType !== 9) {
      throw new Error('dsh-inspect: createInspector(document) requires a Document');
    }
    var win = doc.defaultView;
    if (!win) throw new Error('dsh-inspect: document.defaultView is not available');

    opts = opts || {};
    var config = {
      color: typeof opts.color === 'string' && opts.color ? opts.color : '#2f7cf6',
      selectionColor: typeof opts.selectionColor === 'string' && opts.selectionColor
        ? opts.selectionColor : '#f43f5e',
      zIndex: opts.zIndex == null ? Z_DEFAULT : opts.zIndex,
      onSelect: typeof opts.onSelect === 'function' ? opts.onSelect : null,
      onHover: typeof opts.onHover === 'function' ? opts.onHover : null
    };

    var enabled = false;
    var destroyed = false;
    var hoverEl = null;
    var selectedEl = null;
    var selectionCtx = null;
    var overlay = null;
    var hoverBox = null;
    var hoverLabel = null;
    var selBox = null;
    var selLabel = null;
    var entries = [];               /* [{doc, win, frameEl, styleEl}] */
    var observer = null;
    var syncTimer = 0;

    /* ---------------- target resolution ---------------- */

    function isOursNode(node) {
      if (!node) return false;
      if (overlay && (node === overlay || (overlay.contains && overlay.contains(node)))) return true;
      var el = node.nodeType === 1 ? node : (node.parentElement || null);
      var guard = 0;
      while (el && guard++ < 40) {
        if (el === overlay) return true;
        if (el.getAttribute && el.getAttribute(PART_ATTR)) return true;
        el = el.parentElement;
      }
      return false;
    }

    function topFrameFor(childDoc) {
      var frameEl = null;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].doc === childDoc) { frameEl = entries[i].frameEl; break; }
      }
      if (!frameEl) {
        try {
          var cw = childDoc.defaultView;
          frameEl = cw && cw.frameElement;
        } catch (e) { frameEl = null; }
      }
      var guard = 0;
      while (frameEl && frameEl.ownerDocument !== doc && guard++ < 6) {
        var parentFrame = null;
        try {
          var pw = frameEl.ownerDocument && frameEl.ownerDocument.defaultView;
          parentFrame = pw && pw.frameElement;
        } catch (e) { parentFrame = null; }
        frameEl = parentFrame;
      }
      return frameEl && frameEl.ownerDocument === doc ? frameEl : null;
    }

    function resolveTarget(ev) {
      var node = null;
      try {
        var path = ev && ev.composedPath ? ev.composedPath() : null;
        node = path && path.length ? path[0] : (ev && ev.target);
      } catch (e) { node = ev && ev.target; }
      if (node && node.nodeType === 3) node = node.parentNode;
      if (!node || node.nodeType !== 1) return null;
      /* shadow DOM -> host element(s) */
      var guard = 0;
      while (node && node.nodeType === 1 && node.getRootNode && guard++ < 6) {
        var rootNode = null;
        try { rootNode = node.getRootNode(); } catch (e) { rootNode = null; }
        if (rootNode && rootNode.host) {
          if (isOursNode(rootNode.host)) return null;
          node = rootNode.host;
        } else {
          break;
        }
      }
      /* element inside a nested same-origin iframe -> its <iframe> element in our doc */
      if (node && node.ownerDocument && node.ownerDocument !== doc) {
        node = topFrameFor(node.ownerDocument);
        if (!node) return null;
      }
      if (!node || node.nodeType !== 1) return null;
      if (isOursNode(node)) return null;
      return node;
    }

    /* ---------------- overlay ---------------- */

    function overlayCss() {
      return 'position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;' +
        'overflow:visible;display:block;pointer-events:none;z-index:' + config.zIndex + ';';
    }

    function boxCss() {
      return 'position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;' +
        'border:0;box-sizing:border-box;pointer-events:none;display:none;background:transparent;';
    }

    function labelCss() {
      return 'position:absolute;left:0;top:0;margin:0;padding:2px 6px;border:0;border-radius:4px;' +
        'pointer-events:none;display:none;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,' +
        'Consolas,monospace;white-space:nowrap;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);' +
        'max-width:70vw;overflow:hidden;text-overflow:ellipsis;';
    }

    function makePart(kind) {
      var el = doc.createElement('div');
      el.setAttribute(PART_ATTR, kind);
      el.setAttribute('aria-hidden', 'true');
      return el;
    }

    function injectOverlay() {
      if (overlay) return true;
      var parent = doc.body || doc.documentElement;
      if (!parent) return false;
      overlay = doc.createElement('div');
      overlay.setAttribute(OVERLAY_ATTR, '1');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = overlayCss();

      selBox = makePart('selection-box');
      selBox.style.cssText = boxCss();
      selLabel = makePart('selection-label');
      selLabel.style.cssText = labelCss();
      hoverBox = makePart('hover-box');
      hoverBox.style.cssText = boxCss();
      hoverLabel = makePart('hover-label');
      hoverLabel.style.cssText = labelCss();

      overlay.appendChild(selBox);
      overlay.appendChild(selLabel);
      overlay.appendChild(hoverBox);
      overlay.appendChild(hoverLabel);
      parent.appendChild(overlay);
      return true;
    }

    function ensureOverlayConnected() {
      if (!enabled || !overlay) return;
      var parent = doc.body || doc.documentElement;
      if (parent && overlay.parentNode !== parent) parent.appendChild(overlay);
    }

    function hideLabel(box, label) {
      if (box) box.style.display = 'none';
      if (label) label.style.display = 'none';
    }

    function px(value) {
      return (Math.round(value * 100) / 100) + 'px';
    }

    function viewportWidth() {
      if (typeof win.innerWidth === 'number' && win.innerWidth) return win.innerWidth;
      var de = doc.documentElement;
      return (de && de.clientWidth) || 0;
    }

    function viewportHeight() {
      if (typeof win.innerHeight === 'number' && win.innerHeight) return win.innerHeight;
      var de = doc.documentElement;
      return (de && de.clientHeight) || 0;
    }

    function shortLabelFor(el, w, h) {
      var label = '';
      try { label = tagLabelOf(el); } catch (e) { label = tagNameOf(el); }
      return clip(label, 64) + ' ' + w + '×' + h;
    }

    function positionOverlayFor(el, box, label, accent, selected) {
      if (!overlay || !box || !label || !el) return;
      var connected = true;
      try { connected = el.isConnected !== false; } catch (e) { connected = true; }
      if (!connected) {
        hideLabel(box, label);
        return;
      }
      var rect = null;
      try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
      if (!rect) {
        hideLabel(box, label);
        return;
      }
      var origin = { left: 0, top: 0 };
      try {
        var o = overlay.getBoundingClientRect();
        origin.left = o.left;
        origin.top = o.top;
      } catch (e) { /* keep 0 */ }

      var w = Math.max(0, rect.width);
      var h = Math.max(0, rect.height);
      box.style.display = 'block';
      box.style.left = px(rect.left - origin.left);
      box.style.top = px(rect.top - origin.top);
      box.style.width = px(w);
      box.style.height = px(h);
      box.style.outline = (selected ? '2px solid ' : '1px solid ') + accent;
      box.style.background = hexToRgba(accent, selected ? 0.05 : 0.06) || 'transparent';

      label.textContent = shortLabelFor(el, Math.round(w), Math.round(h));
      label.style.display = 'block';
      label.style.background = accent;

      var vw = viewportWidth();
      var vh = viewportHeight();
      var lw = label.offsetWidth || 0;
      var lh = label.offsetHeight || 20;
      var vx = Math.min(Math.max(rect.left, 4), Math.max(4, vw - lw - 4));
      var vy = rect.top - lh - 4;
      if (vy < 4) vy = rect.top + h + 4;                      /* flip below */
      if (vy + lh > vh - 4) vy = Math.max(4, vh - lh - 4);    /* clamp bottom */
      label.style.left = px(vx - origin.left);
      label.style.top = px(vy - origin.top);
    }

    function refreshOverlays() {
      if (!enabled || !overlay) return;
      if (hoverEl) positionOverlayFor(hoverEl, hoverBox, hoverLabel, config.color, false);
      if (selectedEl) {
        positionOverlayFor(selectedEl, selBox, selLabel, config.selectionColor, true);
      }
    }

    function setHover(el) {
      if (el === hoverEl) {
        if (el) positionOverlayFor(el, hoverBox, hoverLabel, config.color, false);
        return;
      }
      hoverEl = el;
      var ctx = null;
      if (el) {
        positionOverlayFor(el, hoverBox, hoverLabel, config.color, false);
        ctx = safeDescribe(el);
      } else {
        hideLabel(hoverBox, hoverLabel);
      }
      if (config.onHover) safeCall(config.onHover, ctx);
    }

    function selectElement(el) {
      if (!el) return;
      selectedEl = el;
      var ctx = safeDescribe(el);
      selectionCtx = ctx;
      positionOverlayFor(el, selBox, selLabel, config.selectionColor, true);
      if (ctx && config.onSelect) safeCall(config.onSelect, ctx);
    }

    function safeDescribe(el) {
      try {
        return describeElement(el, doc);
      } catch (err) {
        try {
          return {
            selector: cssPath(el, doc) || '', tag: tagNameOf(el), tagLabel: tagLabelOf(el),
            id: attr(el, 'id') || '', classes: classNamesOf(el), text: '',
            box: { w: 0, h: 0 }, padding: '', margin: '', styles: {}, hints: [], html: ''
          };
        } catch (e) {
          return null;
        }
      }
    }

    /* ---------------- event handlers ---------------- */

    function onMouseMove(ev) {
      if (!enabled) return;
      setHover(resolveTarget(ev));
    }

    function onMouseOut(ev) {
      if (!enabled) return;
      if (!ev || !ev.relatedTarget) setHover(null);
    }

    function onClick(ev) {
      if (!enabled) return;
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      selectElement(resolveTarget(ev));
    }

    function onMouseDown(ev) {
      if (!enabled) return;
      if (ev.preventDefault) ev.preventDefault();
    }

    function onKeyDown(ev) {
      if (!enabled || !isEscapeEvent(ev)) return;
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      disable();
    }

    function onScrollOrResize() {
      if (enabled) refreshOverlays();
    }

    function onLoad(ev) {
      if (!enabled) return;
      var target = ev && ev.target;
      if (target && /^(IFRAME|FRAME)$/i.test(target.tagName || '')) scheduleSync();
    }

    function onSubmit(ev) {
      if (!enabled) return;
      if (ev.preventDefault) ev.preventDefault();
    }

    function onDragStart(ev) {
      if (!enabled) return;
      if (ev.preventDefault) ev.preventDefault();
    }

    /* ---------------- listener attach / detach ---------------- */

    function attachDoc(targetDoc, targetWin) {
      targetDoc.addEventListener('mousemove', onMouseMove, true);
      targetDoc.addEventListener('click', onClick, true);
      targetDoc.addEventListener('mousedown', onMouseDown, true);
      targetDoc.addEventListener('pointerdown', onMouseDown, true);
      targetDoc.addEventListener('keydown', onKeyDown, true);
      targetDoc.addEventListener('mouseout', onMouseOut, true);
      targetDoc.addEventListener('submit', onSubmit, true);
      targetDoc.addEventListener('dragstart', onDragStart, true);
      targetDoc.addEventListener('load', onLoad, true);
      targetWin.addEventListener('keydown', onKeyDown, true);
      targetWin.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
      targetWin.addEventListener('resize', onScrollOrResize, { capture: true, passive: true });
      try {
        if (targetDoc.documentElement) targetDoc.documentElement.classList.add(ACTIVE_CLASS);
      } catch (e) { /* ignore */ }
      var styleEl = null;
      try {
        styleEl = targetDoc.createElement('style');
        styleEl.setAttribute(PART_ATTR, 'style');
        styleEl.textContent = ACTIVE_CSS;
        (targetDoc.head || targetDoc.documentElement).appendChild(styleEl);
      } catch (e) { styleEl = null; }
      return styleEl;
    }

    function detachDoc(entry) {
      var targetDoc = entry.doc;
      var targetWin = entry.win;
      try {
        targetDoc.removeEventListener('mousemove', onMouseMove, true);
        targetDoc.removeEventListener('click', onClick, true);
        targetDoc.removeEventListener('mousedown', onMouseDown, true);
        targetDoc.removeEventListener('pointerdown', onMouseDown, true);
        targetDoc.removeEventListener('keydown', onKeyDown, true);
        targetDoc.removeEventListener('mouseout', onMouseOut, true);
        targetDoc.removeEventListener('submit', onSubmit, true);
        targetDoc.removeEventListener('dragstart', onDragStart, true);
        targetDoc.removeEventListener('load', onLoad, true);
        targetWin.removeEventListener('keydown', onKeyDown, true);
        targetWin.removeEventListener('scroll', onScrollOrResize, true);
        targetWin.removeEventListener('resize', onScrollOrResize, true);
        if (targetDoc.documentElement) targetDoc.documentElement.classList.remove(ACTIVE_CLASS);
        if (entry.styleEl && entry.styleEl.parentNode) {
          entry.styleEl.parentNode.removeChild(entry.styleEl);
        }
      } catch (e) { /* ignore */ }
    }

    /* ---------------- nested same-origin iframes ---------------- */

    function collectFrames(rootDoc, out, depth) {
      if (!rootDoc || depth > 4) return;
      var frames = null;
      try { frames = rootDoc.querySelectorAll('iframe'); } catch (e) { frames = null; }
      if (!frames) return;
      for (var i = 0; i < frames.length; i++) {
        var frameEl = frames[i];
        var childDoc = null;
        try { childDoc = frameEl.contentDocument; } catch (e) { childDoc = null; }
        if (!childDoc) continue;
        var childWin = null;
        try { childWin = childDoc.defaultView; } catch (e) { childWin = null; }
        if (!childWin) continue;
        out.push({ frameEl: frameEl, doc: childDoc, win: childWin });
        collectFrames(childDoc, out, depth + 1);
      }
    }

    function syncFrames() {
      if (!enabled) return;
      var wanted = [{ frameEl: null, doc: doc, win: win }];
      collectFrames(doc, wanted, 0);
      var i;
      for (i = entries.length - 1; i >= 0; i--) {
        var keep = false;
        for (var j = 0; j < wanted.length; j++) {
          if (wanted[j].doc === entries[i].doc) { keep = true; break; }
        }
        if (!keep) {
          detachDoc(entries[i]);
          entries.splice(i, 1);
        }
      }
      for (i = 0; i < wanted.length; i++) {
        var wantedEntry = wanted[i];
        var existing = null;
        for (var k = 0; k < entries.length; k++) {
          if (entries[k].doc === wantedEntry.doc) { existing = entries[k]; break; }
        }
        if (existing) {
          existing.frameEl = wantedEntry.frameEl;
          continue;
        }
        var entry = {
          doc: wantedEntry.doc,
          win: wantedEntry.win,
          frameEl: wantedEntry.frameEl,
          styleEl: null
        };
        entry.styleEl = attachDoc(entry.doc, entry.win);
        entries.push(entry);
      }
    }

    function scheduleSync() {
      if (!enabled || syncTimer) return;
      try {
        syncTimer = win.setTimeout(function () {
          syncTimer = 0;
          if (!enabled) return;
          try {
            ensureOverlayConnected();
            syncFrames();
          } catch (e) { /* ignore */ }
        }, 60);
      } catch (e) {
        syncTimer = 0;
      }
    }

    function startObserver() {
      if (observer || !global || typeof global.MutationObserver !== 'function') return;
      observer = new global.MutationObserver(function (mutations) {
        if (!enabled) return;
        var relevant = false;
        for (var i = 0; i < mutations.length; i++) {
          var target = mutations[i].target;
          if (overlay && (target === overlay || (overlay.contains && overlay.contains(target)))) continue;
          relevant = true;
          break;
        }
        if (!relevant) return;
        ensureOverlayConnected();
        scheduleSync();
      });
      try {
        observer.observe(doc.documentElement || doc, { childList: true, subtree: true });
      } catch (e) {
        observer = null;
      }
    }

    /* ---------------- public API ---------------- */

    function enable() {
      if (destroyed || enabled) return api;
      if (!doc.documentElement) return api;
      enabled = true;
      injectOverlay();
      syncFrames();
      startObserver();
      return api;
    }

    function disable() {
      if (!enabled) return api;
      enabled = false;
      var hadHover = !!hoverEl;
      hoverEl = null;
      selectedEl = null;
      if (overlay) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
        hoverBox = null;
        hoverLabel = null;
        selBox = null;
        selLabel = null;
      }
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        observer = null;
      }
      if (syncTimer) {
        try { win.clearTimeout(syncTimer); } catch (e) { /* ignore */ }
        syncTimer = 0;
      }
      for (var i = 0; i < entries.length; i++) detachDoc(entries[i]);
      entries.length = 0;
      if (hadHover && config.onHover) safeCall(config.onHover, null);
      return api;
    }

    function destroy() {
      disable();
      destroyed = true;
      config.onSelect = null;
      config.onHover = null;
      return undefined;
    }

    function isEnabled() {
      return enabled;
    }

    function getSelection() {
      return selectionCtx || null;
    }

    var api = {
      enable: enable,
      disable: disable,
      destroy: destroy,
      isEnabled: isEnabled,
      getSelection: getSelection
    };
    return api;
  }

  var API = {
    createInspector: createInspector,
    describeElement: describeElement,
    formatContextMarkdown: formatContextMarkdown,
    cssPath: cssPath
  };
  return API;
});
