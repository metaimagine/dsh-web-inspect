#!/usr/bin/env node
/**
 * tools/shots.mjs — regenerate the two README shots (task F).
 *
 *   node tools/shots.mjs
 *
 * Produces exactly:
 *   assets/howto-select.png  (close-up: hover highlight + tooltip inside the preview)
 *   assets/howto-send.png    (composer chip above, folded bubble chip below)
 *
 * This script is intentionally self-contained: it reuses the helper block of
 * tools/e2e.mjs (cookie minting, CDP client, Chrome launch, OOPIF preview
 * helpers, hover/click) so the E2E harness stays the single source of truth for
 * the mechanics, but this file has no dependency on it at runtime.
 *
 * It never touches the profile, lib/ or fixtures/. It writes only assets/*.png.
 */

/**
 * tools/e2e.mjs — real-browser end-to-end verification for the `dsh-web-inspect` plugin.
 *
 * Zero dependencies: raw Chrome DevTools Protocol over Node's built-in WebSocket
 * (Node >= 22). It drives a *fresh headless Chrome instance* (its own
 * --user-data-dir, so the user's browser is untouched), authenticates the DSH
 * web GUI, opens a fixture HTML file in the right-sidebar document preview,
 * enables 「检查元素」, hovers + clicks an element inside the preview iframe and
 * asserts that ONE atomic reference chip ("<h1#doc-title>") landed in the chat
 * composer draft WITHOUT sending a message: the composer text must stay free of
 * Markdown, and the full context lives in the chip's base64url ref.
 *
 * Chip-mode checks (bundle rev with `input.insertReference` + `inputTriggers`):
 *   - chip click opens the [data-dsh-web-inspect-popover] full-context popover
 *     (selector + ```html fence + 样式), closed via the 关闭 button;
 *   - a second element produces a DISTINCT second chip (append, no overwrite);
 *   - Backspace after the last chip removes it atomically (2 -> 1);
 *   - outgoing-content proof: CDP `Fetch.enable` intercepts the live
 *     `POST /api/session/prompt` request, reads its JSON body, asserts the
 *     expanded Markdown (selector + fence + styles) is what the model would
 *     receive, then `Fetch.failRequest` aborts it — nothing is ever sent.
 *
 * Security model (opaque-origin iframe): the plugin renderer mounts the preview
 * with sandbox="allow-scripts" ONLY. The parent must never read the frame DOM;
 * the harness therefore resolves the srcdoc child frame through Page.getFrameTree
 * and evaluates inside its default execution context via CDP, asserts both
 * cross-origin directions throw SecurityError, and records the postMessage
 * traffic (parent -> frame enable/disable, frame -> parent ready/select/exit).
 *
 * Live-send phase (task-6, ON by default; pass --no-live-send to skip):
 *   1. a REAL chip message is sent (ONE model turn — disposable session); the
 *      prompt POST is intercepted and CONTINUED, proving the wire text carries
 *      the `<!--dsh-web-inspect:v1-->` / `<!--/dsh-web-inspect-->` sentinel boundaries
 *      with the human-readable `> Selected element: …` quote line FIRST (so chat
 *      titles and previews stay readable);
 *   2. the sent user bubble must fold to exactly ONE `[data-dsh-web-inspect-chip]`
 *      label (`<h1#doc-title>`) with no raw Markdown or sentinel text;
 *   3. clicking that bubble chip opens the full-context popover (selector +
 *      ```html + styles + positioned ancestor) and closes via 关闭;
 *   4. the conversation title / header text must stay readable (no `<!--`
 *      sentinel leak, shows the `> Selected element: …` prefix);
 *   5. the same composer sends "plain text check" to prove plain messages keep
 *      a plain bubble (no chip, no sentinel) — a second, tiny model turn;
 *   6. an official `> 引用回归测试` markdown quote is sent to prove the
 *      message-quotes rule still owns ordinary `>` quotes (the fold rule runs
 *      at order -20, ahead of quoteRule -10, so this is a real regression guard).
 *
 * Usage:
 *   node tools/e2e.mjs                          # full run against http://127.0.0.1:3080
 *   node tools/e2e.mjs --headed                 # watch it in a real (headed) Chrome window
 *   node tools/e2e.mjs --fixture fixtures/simple.html --target '#go'
 *   node tools/e2e.mjs --fixture fixtures/apple-square.html --target '#shape-round' \
 *     --expect-label '<button#shape-round>' --no-live-send
 *   node tools/e2e.mjs --fixture fixtures/apple-square.html --target '#shape-round' \
 *     --expect-label '<button#shape-round>' --assets-dir assets   # README shots
 *   node tools/e2e.mjs --second-target '#fixed-badge'   # element for the 2nd (append) cycle
 *   node tools/e2e.mjs --gui http://127.0.0.1:3080 --shots tests/screens
 *   node tools/e2e.mjs --token <launchToken>     # use the ?token= URL instead of the self-signed cookie
 *   node tools/e2e.mjs --remote-port 9333        # reuse an already-running debug Chrome
 *
 * Exit codes: 0 = all checks passed, 1 = assertion/step failure, 2 = plugin not
 * loaded/activated (the navigation chain is still exercised and reported).
 *
 * Auth (see docs/notes/install-verify.md): `dsh web` prints a one-shot
 * `.../?token=<launchToken>` URL whose token only lives in process memory. The
 * cookie *signing secret* is persisted in ~/.dsh/.credentials.yaml, so this
 * script mints a valid browser-session cookie itself:
 *   name  = "dsh-auth-" + base64url(sha256(authority))      (authority = host:port)
 *   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
 *                 + "." + base64url(HMAC-SHA256(secret, body))
 * and injects it with Network.setCookie before navigating.
 *
 * Write scope: this file only reads the GUI / profile config; it writes
 * screenshots and a JSON report under tests/screens/ (never the profile).
 */

import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// constants, options, logging
// ---------------------------------------------------------------------------

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const RENDERER_TOGGLE = 'button.__dsh_web_inspect_toggle';
const INSPECT_FRAME = 'iframe[data-dsh-web-inspect-frame]';
const INSERTED_ZH = '已插入当前会话输入框（未发送）';
const CHIP_INSERTED_ZH = '已插入引用块';

const DEFAULTS = {
  gui: process.env.DSH_GUI ?? 'http://127.0.0.1:3080',
  chrome: process.env.CHROME_PATH ?? null,
  headed: false,
  fixture: 'fixtures/inspect-demo.html',
  target: '#doc-title',
  secondTarget: '#panel-dark .dup',
  expectLabel: null,
  assetsDir: null,
  workspace: basename(REPO_ROOT),
  shots: join(REPO_ROOT, 'tests', 'screens'),
  token: null,
  remotePort: null,
  timeout: 45_000,
  stepTimeout: 15_000,
  keepProfile: false,
  keepOpen: false,
  liveSend: true,
  hero: false,
  verbose: false,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--gui': opts.gui = next(); break;
      case '--chrome': opts.chrome = next(); break;
      case '--headed': opts.headed = true; break;
      case '--fixture': opts.fixture = next(); break;
      case '--target': opts.target = next(); break;
      case '--second-target': opts.secondTarget = next(); break;
      case '--expect-label': opts.expectLabel = next(); break;
      case '--assets-dir': opts.assetsDir = next(); break;
      case '--workspace': opts.workspace = next(); break;
      case '--shots': opts.shots = next(); break;
      case '--token': opts.token = next(); break;
      case '--remote-port': opts.remotePort = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--keep-profile': opts.keepProfile = true; break;
      case '--keep-open': opts.keepOpen = true; break;
      case '--no-live-send': opts.liveSend = false; break;
      case '--hero': opts.hero = true; break;
      case '--verbose': opts.verbose = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  opts.gui = opts.gui.replace(/\/+$/u, '');
  return opts;
}

function printHelp() {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/u, ''));
}

const opts = parseArgs(process.argv.slice(2));
// Fixture-agnostic expectations: the E2E still exercises the same behaviour,
// but the concrete element label/selector can be supplied for other fixtures
// (e.g. fixtures/apple-square.html --target '#shape-round').
const TARGET_LABEL = opts.expectLabel ?? '<h1#doc-title>';
const TARGET_TAG = TARGET_LABEL.replace(/^</u, '').split(/[.#]/u)[0];
const TARGET_HEADING = '> Selected element: ' + opts.target;
const startedAt = new Date();
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const log = (...args) => console.log(...args);
const debug = (...args) => { if (opts.verbose) console.log('   ·', ...args); };

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

class EnvironmentError extends Error {}
class StepFailure extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}
class PluginMissingError extends StepFailure {
  constructor(message) { super(message, 2); }
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol (raw WebSocket, no deps)
// ---------------------------------------------------------------------------

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener('open', () => resolveReady(this), { once: true });
      this.ws.addEventListener('error', () => rejectReady(new Error(`CDP websocket error: ${wsUrl}`)), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId);
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error('CDP websocket closed'));
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolveSend, rejectSend) => this.pending.set(id, { resolve: resolveSend, reject: rejectSend }));
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

async function connectBrowser(port) {
  const deadline = Date.now() + opts.stepTimeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await response.json();
      const cdp = await new CDP(info.webSocketDebuggerUrl).ready;
      return { cdp, info };
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw new EnvironmentError(`could not connect to Chrome DevTools on port ${port}: ${lastError?.message ?? 'timeout'}`);
}

function resolveChromePath() {
  const candidates = [opts.chrome, process.env.CHROME_PATH, ...DEFAULT_CHROME_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new EnvironmentError(`no Chrome/Chromium binary found (checked: ${candidates.join(', ')}); pass --chrome <path>`);
}

async function launchChrome({ chromePath, userDataDir, headless }) {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-service-autorun',
    '--disable-features=Translate,MediaRouter',
    '--remote-allow-origins=*',
    '--window-size=1440,900',
    ...(headless ? ['--headless=new', '--disable-gpu', '--hide-scrollbars'] : []),
    'about:blank',
  ];
  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += String(chunk); });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + opts.stepTimeout;
  while (Date.now() < deadline) {
    try {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port > 0) return { proc, port };
    } catch { /* not written yet */ }
    if (proc.exitCode !== null) throw new EnvironmentError(`Chrome exited early (code ${proc.exitCode}): ${stderr.slice(-1500)}`);
    await sleep(100);
  }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  throw new EnvironmentError(`Chrome DevTools port did not appear within ${opts.stepTimeout} ms: ${stderr.slice(-1500)}`);
}

// ---------------------------------------------------------------------------
// auth cookie (self-signed from the persisted browser-session secret)
// ---------------------------------------------------------------------------

const b64url = (buffer) => Buffer.from(buffer).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const b64urlDecode = (text) => text.replaceAll('-', '+').replaceAll('_', '/')
  + '='.repeat((4 - (text.length % 4)) % 4);

function readBrowserSessionSecret() {
  const credentialsPath = join(homedir(), '.dsh', '.credentials.yaml');
  if (!existsSync(credentialsPath)) {
    throw new EnvironmentError(`cannot find ${credentialsPath}; is this a dsh web host? (or pass --token <launchToken>)`);
  }
  const yaml = readFileSync(credentialsPath, 'utf8');
  const match = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/u);
  if (match === null) {
    throw new EnvironmentError(`no client-connection/browser-session secret in ${credentialsPath}; pass --token <launchToken> instead`);
  }
  return Buffer.from(b64urlDecode(match[1]), 'base64');
}

function mintAuthCookie(authority) {
  const secret = readBrowserSessionSecret();
  const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
  const issuedAt = Date.now();
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt,
    expiresAt: issuedAt + 30 * 24 * 60 * 60 * 1000,
  }), 'utf8');
  const body = b64url(payload);
  const signature = createHmac('sha256', secret).update(body).digest();
  return { name, value: `v1.${body}.${b64url(signature)}` };
}

// ---------------------------------------------------------------------------
// page helpers
// ---------------------------------------------------------------------------

/** Evaluate an expression in the top page; unwraps promise results. */
async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (response.exceptionDetails !== undefined) {
    const description = response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? 'page exception';
    throw new StepFailure(`page evaluation failed: ${description}\n  expression: ${expression.slice(0, 240)}`);
  }
  return response.result?.value;
}

async function waitUntil(predicate, { timeout = opts.timeout, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(interval);
  }
  throw new StepFailure(`timed out after ${timeout} ms waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

const TRANSCRIPT_EXPR = `(() => {
    const root = document.querySelector('[data-conversation-content]');
    const composer = document.querySelector('[data-composer-seat]');
    const rootText = root?.innerText ?? '';
    const composerText = composer?.innerText ?? '';
    const transcriptText = composerText === '' ? rootText : rootText.split(composerText).join('');
    return { transcriptLen: transcriptText.length, transcriptText, hasComposer: composer !== null };
  })()`;

const COMPOSER_DRAFT_EXPR = `(() => {
    const editor = document.querySelector('[data-composer-input]');
    const domText = editor === null ? '' : (editor.innerText || editor.textContent || '');
    let storedText = '';
    try {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith('dsh.conversation.')) ?? null;
      if (key !== null) {
        const parsed = JSON.parse(localStorage.getItem(key));
        storedText = parsed?.draft?.text ?? '';
      }
    } catch { /* localStorage mirror is best-effort */ }
    // The Lexical editor may render long drafts partially (virtualized), so the
    // persisted draft mirror is preferred when it is the longer one.
    const text = storedText.length >= domText.length ? storedText : domText;
    return { text, domText, storedText };
  })()`;

const CHIP_STATE_EXPR = `(() => {
    const editor = document.querySelector('[data-composer-input]');
    const chips = Array.from(document.querySelectorAll('[data-composer-input] [title]'))
      .filter((el) => (el.getAttribute('title') ?? '').startsWith('<'));
    let draft = null;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('dsh.conversation.')) {
        try { draft = JSON.parse(localStorage.getItem(key)); } catch { /* ignore */ }
      }
    }
    return {
      chipCount: chips.length,
      chips: chips.map((el) => ({
        title: el.getAttribute('title'),
        text: (el.innerText || el.textContent || '').trim(),
        cls: String(el.className),
        outerHTML: el.outerHTML,
        hostOuterHTML: (el.parentElement?.outerHTML ?? '').slice(0, 2000),
      })),
      editorText: editor === null ? null : (editor.innerText || editor.textContent || ''),
      draft,
    };
  })()`;

const CHIP_REF_PREFIX = 'dsh-web-inspect:v1:';
function decodeChipRef(encoded) {
  try {
    const payload = String(encoded).slice(CHIP_REF_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// opaque-origin preview frame bridge
// ---------------------------------------------------------------------------
// The plugin renderer uses sandbox="allow-scripts" (NO allow-same-origin), so
// the parent document can never read iframe.contentDocument. Drive the frame
// through CDP instead: map the srcdoc child frame to its default execution
// context and evaluate inside that context.
const previewContexts = new Map(); // frameId -> { contextId, sessionId, isDefault, origin }
const attachedSessions = new Map(); // targetId -> flattened CDP sessionId (OOPIF)

function recordPreviewContext(context, eventSessionId) {
  const frameId = context?.auxData?.frameId;
  if (frameId === undefined) return;
  previewContexts.set(frameId, {
    contextId: context.id,
    sessionId: eventSessionId,
    isDefault: context.auxData?.isDefault === true,
    origin: context.origin ?? '',
    name: context.name ?? '',
  });
}

function trackFrameContexts() {
  cdp.on('Runtime.executionContextCreated', (params, eventSessionId) => {
    recordPreviewContext(params.context, eventSessionId);
  });
  cdp.on('Runtime.executionContextDestroyed', (params, eventSessionId) => {
    for (const [frameId, value] of previewContexts) {
      if (value.contextId === params.executionContextId && value.sessionId === eventSessionId) previewContexts.delete(frameId);
    }
  });
  cdp.on('Runtime.executionContextsCleared', (params, eventSessionId) => {
    for (const [frameId, value] of previewContexts) {
      if (value.sessionId === eventSessionId) previewContexts.delete(frameId);
    }
  });
  // A sandboxed opaque-origin iframe can be an out-of-process frame (OOPIF):
  // its execution contexts only show up on the child target session, so
  // auto-attach and enable Runtime there too.
  cdp.on('Target.attachedToTarget', async (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    attachedSessions.set(params.targetInfo.targetId, params.sessionId);
    try {
      await cdp.send('Runtime.enable', {}, params.sessionId);
      await cdp.send('Page.enable', {}, params.sessionId);
      // Never leave the srcdoc document paused: a target that waits for the
      // debugger would parse the head but never execute the injected runtime.
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId);
    } catch { /* detached already */ }
  });
  cdp.on('Target.detachedFromTarget', (params) => {
    for (const [targetId, childSessionId] of attachedSessions) {
      if (childSessionId === params.sessionId) attachedSessions.delete(targetId);
    }
  });
}

async function listFrames() {
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
  const frames = [];
  const walk = (node) => {
    frames.push({ id: node.frame.id, url: node.frame.url, parentId: node.frame.parentId ?? null, name: node.frame.name ?? '' });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return frames;
}

const PREVIEW_HEALTH_EXPR = `(() => {
  const scripts = Array.from(document.scripts ?? []);
  return {
    href: String(location.href).slice(0, 80),
    title: document.title,
    readyState: document.readyState,
    runtime: window.__dsh_web_inspect_runtime__ === true,
    runtimeScript: scripts.some((script) => script.hasAttribute('data-dsh-web-inspect-runtime')),
    scriptCount: scripts.length,
    bodyChildren: document.body === null ? -1 : document.body.children.length,
  };
})()`;

async function previewCandidates() {
  // A sandboxed opaque-origin iframe is an out-of-process frame (OOPIF): the
  // parent page frame tree does not list it, and Chrome can keep more than one
  // attached srcdoc target around (stale blank ones from earlier navigations).
  // Rank every reachable candidate by whether the injected runtime is live.
  const candidates = [];
  for (const [targetId, childSessionId] of attachedSessions) {
    try {
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, childSessionId);
      const frame = frameTree?.frame;
      if (frame === undefined || frame === null || !String(frame.url).startsWith('about:srcdoc')) continue;
      let context = previewContexts.get(frame.id);
      if (context === undefined) {
        for (const value of previewContexts.values()) {
          if (value.sessionId === childSessionId && value.isDefault === true) { context = value; break; }
        }
      }
      if (context === undefined) continue;
      let health = null;
      try {
        const result = await cdp.send('Runtime.evaluate', {
          expression: PREVIEW_HEALTH_EXPR, contextId: context.contextId, returnByValue: true,
        }, childSessionId);
        health = result.result?.value ?? null;
      } catch { /* context mid-navigation */ }
      candidates.push({
        frame: { id: frame.id, url: frame.url, parentId: frame.parentId ?? null, name: frame.name ?? '', targetId, sessionId: childSessionId },
        context, health,
      });
    } catch { /* child target detaching */ }
  }
  if (candidates.length === 0) {
    // Same-process fallback (iframe not promoted to its own process).
    const frames = await listFrames();
    const frame = frames.find((candidate) => candidate.parentId !== null && candidate.url.startsWith('about:srcdoc'));
    if (frame !== undefined) {
      let context = previewContexts.get(frame.id);
      if (context === undefined) {
        for (const value of previewContexts.values()) {
          if (value.sessionId === sessionId && value.isDefault === true) { context = value; break; }
        }
      }
      if (context !== undefined) candidates.push({ frame: { ...frame, targetId: undefined, sessionId: undefined }, context, health: null });
    }
  }
  return candidates;
}

async function previewContext() {
  const candidates = await previewCandidates();
  if (candidates.length === 0) {
    throw new StepFailure('preview iframe target not found (no attached about:srcdoc OOPIF target and no same-process child frame)');
  }
  const live = candidates.filter((candidate) => candidate.health !== null && candidate.health.runtime === true);
  const loaded = candidates.filter((candidate) => candidate.health !== null && candidate.health.bodyChildren > 0);
  const chosen = live[0] ?? loaded[0] ?? candidates.find((candidate) => candidate.health === null) ?? candidates[0];
  return { frame: chosen.frame, context: chosen.context, health: chosen.health };
}

async function previewFrame() {
  return (await previewContext()).frame;
}

async function evalInPreview(expression) {
  const { frame, context } = await previewContext();
  const ownerSession = context.sessionId === sessionId ? undefined : context.sessionId;
  const result = await cdp.send('Runtime.evaluate', {
    expression, contextId: context.contextId, returnByValue: true, awaitPromise: true,
  }, ownerSession);
  if (result.exceptionDetails !== undefined) {
    throw new StepFailure(`preview-frame evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return { frameId: frame.id, contextId: context.contextId, value: result.result?.value };
}

async function dumpTrackedContexts() {
  const rows = [];
  for (const [frameId, value] of previewContexts) {
    const row = { frameId, contextId: value.contextId, origin: value.origin, isDefault: value.isDefault, owner: value.sessionId === sessionId ? 'page' : 'child' };
    try {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `({ href: String(location.href).slice(0, 80), title: document.title, readyState: document.readyState, bodyChildren: document.body === null ? -1 : document.body.children.length, scripts: document.scripts.length, runtime: document.querySelector('script[data-dsh-web-inspect-runtime="1"]') !== null, htmlHead: document.documentElement === null ? null : document.documentElement.outerHTML.slice(0, 160) })`,
        contextId: value.contextId, returnByValue: true,
      }, value.sessionId === sessionId ? undefined : value.sessionId);
      row.state = result.result?.value ?? null;
      if (result.exceptionDetails !== undefined) row.error = result.exceptionDetails.text;
    } catch (error) { row.error = String(error); }
    rows.push(row);
  }
  return rows;
}

async function waitPreviewContext(timeout = 15_000) {
  return waitUntil(async () => {
    try { return (await previewContext()).context.contextId; } catch { return null; }
  }, { timeout, interval: 120, label: 'preview iframe execution context' });
}

const HOVER_STATE_IN_FRAME = `(() => {
    const highlight = document.querySelector('.__dsh_web_inspect_hl');
    const tooltip = document.querySelector('.__dsh_web_inspect_tip');
    if (highlight === null) return null;
    const rect = highlight.getBoundingClientRect();
    const style = getComputedStyle(highlight);
    return {
      visible: style.display !== 'none',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      pinned: highlight.getAttribute('data-pinned') === 'true',
      tooltip: (tooltip === null ? '' : (tooltip.innerText || tooltip.textContent || '')).replace(/\\s+/g, ' ').trim() || null,
    };
  })()`;

async function previewPoint(selector) {
  const frameRect = await evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
    if (frame === null) throw new Error('plugin preview iframe missing');
    const rect = frame.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`);
  const { value } = await evalInPreview(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, tag: element.tagName.toLowerCase(), id: element.id || null };
  })()`);
  if (value === null) throw new StepFailure(`target selector not found inside preview: ${selector}`);
  return {
    x: Math.round(frameRect.x + value.left + value.width / 2),
    y: Math.round(frameRect.y + value.top + value.height / 2),
    elementRect: { x: Math.round(value.left), y: Math.round(value.top), width: Math.round(value.width), height: Math.round(value.height) },
    frameRect,
    tag: value.tag,
    id: value.id,
  };
}

async function mouseClickAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
}

async function closeInspectPopover() {
  const closed = await evaluate(`(() => {
    const root = document.querySelector('[data-dsh-web-inspect-popover]');
    if (root === null) return 'missing';
    const byClass = root.querySelector('.__dsh_web_inspect_pop_close');
    const byText = Array.from(root.querySelectorAll('button')).find((button) => (button.innerText || button.textContent || '').trim() === '关闭');
    const target = byClass ?? byText;
    if (target === null || target === undefined) return 'no-close-control';
    target.click();
    return 'clicked';
  })()`);
  if (closed === 'missing') throw new StepFailure('inspect popover disappeared before it could be closed');
  if (closed === 'no-close-control') throw new StepFailure('inspect popover has no 关闭 / close control');
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-dsh-web-inspect-popover]') === null`)), { timeout: 5_000, label: 'popover closed' });
}

async function clickSelector(selector) {
  const clicked = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.click();
    return true;
  })()`);
  if (!clicked) throw new StepFailure(`element not found to click: ${selector}`);
}

async function clickByText(selector, text, timeout = opts.timeout) {
  // textContent (not innerText) so items are matched even while an animation
  // keeps them not-yet-rendered; retry until the target appears.
  await waitUntil(async () => (await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)};
    const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find((node) => ((node.textContent ?? '').replace(/\\s+/g, ' ').trim()) === wanted);
    if (el === undefined) return false;
    el.scrollIntoView({ block: 'nearest' });
    el.click();
    return true;
  })()`)), { timeout, interval: 200, label: `${selector} with text "${text}"` });
}

const shotPaths = [];
async function screenshot(name) {
  mkdirSync(opts.shots, { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  const path = join(opts.shots, `${name}.png`);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  shotPaths.push(path);
  debug(`screenshot ${path}`);
  return path;
}

const SECOND_SHOTS = join(REPO_ROOT, 'tests', 'screens', 'second');
async function screenshotFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  shotPaths.push(path);
  debug(`screenshot ${path}`);
  return path;
}

const REDACT_PAGE_SCRIPT = String.raw`(() => {
  const patterns = [
    [/\/Users\/[^\s"'<>]*/g, '…'],
    [/\/dsh-inspect-plugin\/fixtures\//g, '…/fixtures/'],
    [/(?:Kimi|DeepSeek|Claude|GPT)[^\n]{0,40}/g, 'Model'],
    [/\bcare\b/g, 'user'],
    [/\b(?:huaxue|PortyLabs|dsh-fat-fish|dsh-one|dsh-phone|dsh-ui|TradeAgentExp|active-element-count-overhead\S*)\b/g, 'demo-workspace'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'hello@example.com'],
    [/1[3-9]\d{9}/g, '+00 0000 0000'],
  ];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    let next = node.nodeValue;
    for (const [pattern, replacement] of patterns) next = next.replace(pattern, replacement);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  return true;
})()`;

// README/gallery shots: same UI, but cropped past the left sidebar and with the
// private strings redacted (paths, workspace names, model/account chips, emails,
// phone numbers). The crop starts right of the sidebar so its workspace list can
// never appear, even before the text pass runs.
async function takeAssetShot(name, options = {}) {
  if (opts.assetsDir === null) return null;
  mkdirSync(opts.assetsDir, { recursive: true });
  await dismissErrorToasts();
  await evaluate(REDACT_PAGE_SCRIPT);
  await sleep(200);
  let clip = { x: 300, y: 0, width: 1300, height: 1000, scale: 1 };
  const selector = options.selector ?? null;
  if (selector !== null) {
    const rect = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`);
    if (rect !== null) {
      const pad = options.pad ?? 8;
      const x = Math.max(300, Math.floor(rect.left - pad));
      const y = Math.max(0, Math.floor(rect.top - pad));
      clip = {
        x,
        y,
        width: Math.min(1600 - x, Math.ceil(rect.right - x + pad)),
        height: Math.min(1000 - y, Math.ceil(rect.bottom - y + pad)),
        scale: 1,
      };
    }
  }
  if (typeof options.cropHeight === 'number') {
    clip.height = Math.min(clip.height, Math.max(1, Math.floor(options.cropHeight)));
  }
  if (typeof options.scale === 'number' && options.scale > 0) {
    clip.scale = options.scale;
  }
  let hidden = [];
  if (Array.isArray(options.hideSelectors)) {
    hidden = await evaluate(`(() => {
      const list = ${JSON.stringify(options.hideSelectors)};
      const out = [];
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (el === null) continue;
        out.push([selector, el.style.display]);
        el.style.display = 'none';
      }
      return out;
    })()`);
    await sleep(80);
  }
  await sleep(120);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, clip }, sessionId);
  if (hidden.length > 0) {
    await evaluate(`(() => {
      const list = ${JSON.stringify(hidden)};
      for (const [selector, value] of list) {
        const el = document.querySelector(selector);
        if (el !== null) el.style.display = value;
      }
    })()`).catch(() => {});
  }
  const path = join(opts.assetsDir, name);
  writeFileSync(path, Buffer.from(result.data, 'base64'));
  log(`asset shot: ${path} (${clip.width}x${clip.height})`);
  return path;
}

// Remove the transient "session/prompt failed" toast left by the aborted
// task-5 capture so the live-send screenshots show only the plugin UI.
async function dismissErrorToasts() {
  // Hide the transient "session/prompt failed" toast instead of removing the node:
  // it lives inside a React-managed portal, and removing it out-of-band makes
  // React crash later with "Failed to execute 'removeChild' on 'Node'".
  await evaluate(`(() => {
    let style = document.getElementById('e2e-hidden-toasts');
    if (style === null) {
      style = document.createElement('style');
      style.id = 'e2e-hidden-toasts';
      style.textContent = '[data-e2e-hidden-toast]{display:none!important}';
      document.head.appendChild(style);
    }
    let hidden = 0;
    for (const node of Array.from(document.querySelectorAll('body > *'))) {
      if (!/session\\/prompt failed/u.test(node.textContent ?? '')) continue;
      node.setAttribute('data-e2e-hidden-toast', '');
      hidden += 1;
    }
    return hidden;
  })()`).catch(() => {});
}

// ---------------------------------------------------------------------------
// main flow
// ---------------------------------------------------------------------------

let cdp;
let sessionId;
let browserPort;
let chromeProc;
let chromeDir;
const facts = {};
const steps = [];
const consoleErrors = [];

function record(name, status, detail = '') {
  const glyph = status === 'PASS' ? '✔' : status === 'FAIL' ? '✖' : '•';
  const suffix = detail === '' ? '' : ` — ${detail}`;
  log(`  ${glyph} ${name}${suffix}`);
  steps.push({ name, status, detail, at: new Date().toISOString() });
  if (status === 'FAIL') throw new StepFailure(`${name}: ${detail}`);
}


// ---------------------------------------------------------------------------
// README shots (task F)
// ---------------------------------------------------------------------------

const ASSETS_DIR = join(REPO_ROOT, 'assets');

function pngSize(buffer) {
  // IHDR chunk starts at byte 8; width/height are big-endian uint32 at 16/20.
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ---------------------------------------------------------------------------
// 2x-native figure pipeline.
//
// Page.captureScreenshot with a clip rasterises the clip at `scale`, not at the
// emulated deviceScaleFactor, so a clipped capture is 1x unless the clip asks
// for a scale — and asking for one is exactly the upscaling we must avoid.
// Instead we take ONE full-viewport screenshot (native device pixels at
// deviceScaleFactor=2), crop integer device-pixel rectangles out of it via a
// canvas, and compose the final figure 1:1 in device pixels. Nothing is ever
// resampled unless the browser failed to honour DPR (then the single 3 -> 2
// downscale is applied once, from dpr 3 source pixels).
// ---------------------------------------------------------------------------
function pngPixelSize(base64) {
  const buffer = Buffer.from(base64, 'base64');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function captureViewportRaw() {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  }, sessionId);
  return result.data;
}

async function renderFigure({ images, viewportWidth, viewportHeight, outputWidth, outputHeight, background, radius, layers, outPath }) {
  const spec = { viewportWidth, viewportHeight, outputWidth, outputHeight, background, radius, layers };
  const data = await evaluate(`(() => {
    const spec = ${JSON.stringify(spec)};
    const sources = ${JSON.stringify(images)};
    return (async () => {
      const loaded = [];
      for (const base64 of sources) {
        const image = new Image();
        image.src = 'data:image/png;base64,' + base64;
        await image.decode();
        loaded.push(image);
      }
      const canvas = document.createElement('canvas');
      canvas.width = spec.outputWidth;
      canvas.height = spec.outputHeight;
      const context = canvas.getContext('2d');
      context.fillStyle = spec.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (spec.radius > 0) {
        context.beginPath();
        context.roundRect(0, 0, canvas.width, canvas.height, spec.radius);
        context.clip();
      }
      for (const layer of spec.layers) {
        const image = loaded[layer.image ?? 0];
        const dpr = image.naturalWidth / spec.viewportWidth;
        const sourceX = Math.round(layer.css.x * dpr);
        const sourceY = Math.round(layer.css.y * dpr);
        const sourceW = Math.round(layer.css.w * dpr);
        const sourceH = Math.round(layer.css.h * dpr);
        context.drawImage(image, sourceX, sourceY, sourceW, sourceH, layer.dest.x, layer.dest.y, layer.dest.w, layer.dest.h);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    })();
  })()`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(data, 'base64'));
  const size = pngPixelSize(data);
  log(`  ✔ wrote ${outPath.split('/').pop()} (${size.width}×${size.height}, ${Math.round(Buffer.from(data, 'base64').length / 1024)} KB)`);
  return outPath;
}

async function captureClip(clip) {
  const capture = async (scale) => {
    const result = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale },
    }, sessionId);
    return Buffer.from(result.data, 'base64');
  };
  let buffer = await capture(1);
  let size = pngSize(buffer);
  if (size.width < clip.width * 1.5) {
    // Some Chrome builds ignore the emulated deviceScaleFactor for clipped
    // captures; ask for 2x explicitly so the README images stay crisp.
    buffer = await capture(2);
    size = pngSize(buffer);
  }
  return { buffer, size };
}

async function rectOf(selector) {
  return evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`);
}

async function composeCard({ cardWidth, background, border, children, outPath }) {
  const spec = JSON.stringify({ cardWidth, background, border: border === true, children });
  await evaluate(`(() => {
    const spec = ${spec};
    document.getElementById('__shots_root')?.remove();
    const root = document.createElement('div');
    root.id = '__shots_root';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:' + spec.background + ';';
    const card = document.createElement('div');
    card.id = '__shots_card';
    card.style.cssText = 'box-sizing:content-box;padding:28px;border-radius:16px;background:' + spec.background + ';';
    card.style.width = spec.cardWidth + 'px';
    if (spec.border) card.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,0.08)';
    for (const child of spec.children) {
      const img = document.createElement('img');
      img.src = child.src;
      img.style.cssText = 'display:block;margin:0 auto;border-radius:10px;'
        + (child.marginTop ? 'margin-top:' + child.marginTop + 'px;' : '')
        + (child.shadow ? 'box-shadow:0 6px 24px rgba(0,0,0,0.28);' : '')
        + 'width:' + child.width + 'px;';
      card.appendChild(img);
    }
    root.appendChild(card);
    document.body.appendChild(root);
    return true;
  })()`);
  await sleep(220);
  const rect = await rectOf('#__shots_card');
  const captured = await captureClip({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, captured.buffer);
  await evaluate(`(() => { document.getElementById('__shots_root')?.remove(); return true; })()`);
  log(`  ✔ wrote ${outPath.replace(REPO_ROOT + '/', '')} (${captured.size.width}×${captured.size.height}, ${(captured.buffer.length / 1024).toFixed(0)} KB)`);
  return captured;
}

async function waitFrameContext() {
  await waitUntil(async () => (await evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
    return frame !== null && String(frame.getAttribute('srcdoc') ?? '').length > 0;
  })()`)), { label: 'opaque preview iframe with srcdoc' });
  await waitPreviewContext(opts.timeout);
  await waitUntil(async () => {
    try {
      const result = await evalInPreview(`(() => ({
        bodyChildren: document.body === null ? 0 : document.body.children.length,
        runtime: document.querySelector('script[data-dsh-web-inspect-runtime="1"]') !== null,
        ready: window.__dsh_web_inspect_runtime__ === true,
      }))()`);
      return result.value.bodyChildren > 0 && result.value.runtime === true;
    } catch { return false; }
  }, { timeout: 20_000, interval: 120, label: 'injected runtime inside the preview frame' });
}

async function openPreviewFixture() {
  // Session view has no workspace picker (it is fixed to the session's cwd);
  // only the landing composer exposes it. Switch only when it is there.
  const hasWorkspacePicker = await evaluate(`document.querySelector('button[aria-label="选择工作区"]') !== null`);
  if (hasWorkspacePicker) {
    await clickSelector('button[aria-label="选择工作区"]');
    await waitUntil(async () => (await evaluate(`document.querySelectorAll('[role=menuitem]').length > 0`)), { label: 'workspace menu' });
    await clickByText('[role=menuitem]', opts.workspace);
    await waitUntil(async () => {
      const chip = await evaluate(`document.querySelector('button[aria-label="选择工作区"]')?.innerText ?? ''`);
      return chip.includes(opts.workspace);
    }, { label: `workspace chip shows ${opts.workspace}` });
  }
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-composer-input]') !== null`)), { label: 'composer present' });

  const surface = await waitUntil(async () => {
    const state = await evaluate(`(() => {
      const expand = document.querySelector('button[data-sidebar-right-expand=true]');
      const expandVisible = expand !== null && expand.getBoundingClientRect().width > 0;
      const panel = document.querySelector('[data-sidebar-right-panel]:not([aria-hidden="true"])');
      return { expandVisible, panel: panel !== null };
    })()`);
    return state.expandVisible || state.panel ? state : null;
  }, { interval: 100, label: 'right sidebar surface' });
  if (surface.expandVisible) await clickSelector('button[data-sidebar-right-expand=true]');
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-sidebar-right-panel]:not([aria-hidden="true"])') !== null`)), { label: 'right sidebar panel visible' });
  await clickSelector('[data-sidebar-right-guide-entry=files]').catch(async (error) => {
    const alreadyOpen = await evaluate(`document.querySelectorAll('[data-dockkit-tab]').length > 0`);
    if (!alreadyOpen) throw error;
  });
  await waitUntil(async () => (await evaluate(`document.querySelectorAll('li[data-files-entry]').length > 0`)), { label: 'files tree rows' });

  const fixtureAbs = resolve(REPO_ROOT, opts.fixture);
  const segments = opts.fixture.replace(/^\.\//u, '').split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    const dirAbs = resolve(REPO_ROOT, ...segments.slice(0, index + 1));
    await waitUntil(async () => (await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('li[data-files-entry=directory]'));
      return rows.some((row) => row.getAttribute('data-files-path') === ${JSON.stringify(dirAbs)});
    })()`)), { label: `directory row ${dirAbs}` });
    const expanded = await evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('li[data-files-entry=directory]'))
        .find((candidate) => candidate.getAttribute('data-files-path') === ${JSON.stringify(dirAbs)});
      const button = row?.querySelector('button[aria-expanded]');
      if (row === undefined || button === null) return false;
      if (button.getAttribute('aria-expanded') === 'true') return true;
      button.click();
      return false;
    })()`);
    if (!expanded) {
      await waitUntil(async () => (await evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('li[data-files-entry=directory]'))
          .find((candidate) => candidate.getAttribute('data-files-path') === ${JSON.stringify(dirAbs)});
        return row?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true';
      })()`)), { label: `directory expanded ${dirAbs}` });
    }
  }
  await waitUntil(async () => (await evaluate(`(() => {
    return Array.from(document.querySelectorAll('li[data-files-entry=file]'))
      .some((row) => row.getAttribute('data-files-path') === ${JSON.stringify(fixtureAbs)});
  })()`)), { label: `fixture row ${fixtureAbs}` });
  await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('li[data-files-entry=file]'))
      .find((candidate) => candidate.getAttribute('data-files-path') === ${JSON.stringify(fixtureAbs)});
    row.querySelector('button')?.click() ?? row.click();
    return true;
  })()`);
  await waitUntil(async () => (await evaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-panel]');
    return Array.from(panel?.querySelectorAll('[data-dockkit-tab]') ?? [])
      .some((tab) => (tab.innerText ?? '').includes('apple-square'));
  })()`)), { label: 'apple-square.html preview tab' }).catch(() => {});
  await waitFrameContext();
}


// ---------------------------------------------------------------------------
// Hero figure (task H): one clean base shot plus code-drawn numbered callouts.
// The base is a native 2x viewport screenshot (DPR=2, integer crop only); the
// callouts are painted on a canvas in device pixels — no hand-drawn arrows and
// no per-annotation image editors.
// ---------------------------------------------------------------------------

const HERO_COLOR = '#2F6FED';
const HERO_VIEWPORT = { width: 1500, height: 550 };
const HERO_CHAT_WIDTH = 300; // CSS px → 600 device px of real conversation
const HERO_CROP_HEIGHT = 500; // CSS px → 1000 device px

async function hoverUntil(selector, accept) {
  let last = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    let geometry = null;
    try {
      geometry = await previewPoint(selector);
    } catch {
      await sleep(300);
      continue;
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x + 2, y: geometry.y + 2, button: 'none', buttons: 0 }, sessionId);
    await sleep(200);
    const state = await evalInPreview(HOVER_STATE_IN_FRAME);
    last = state?.value ?? null;
    if (last !== null && last.visible === true && last.tooltip !== null && accept(last.tooltip)) {
      return { geometry, hover: last };
    }
  }
  throw new StepFailure(`hero: hover never matched ${selector} (last: ${JSON.stringify(last)})`);
}

async function sendSeedMessage(text) {
  const rect = await rectOf('[data-composer-input]');
  if (rect === null) throw new StepFailure('hero: composer missing before seed message');
  let typed = false;
  for (let attempt = 0; attempt < 5 && !typed; attempt += 1) {
    await mouseClickAt(Math.round(rect.x + Math.min(60, rect.width / 2)), Math.round(rect.y + Math.min(22, rect.height / 2)));
    await sleep(220);
    const focused = await evaluate(`(() => document.activeElement !== null && (document.activeElement.closest?.('[data-composer-input]') !== null || document.activeElement.getAttribute?.('contenteditable') === 'true'))()`);
    if (!focused) {
      await sleep(320);
      continue;
    }
    await cdp.send('Input.insertText', { text }, sessionId);
    await sleep(280);
    typed = await evaluate(`(() => { const el = document.querySelector('[data-composer-input]'); return ((el?.innerText ?? el?.textContent ?? '').trim().length > 0); })()`);
  }
  if (!typed) throw new StepFailure('hero: could not type the seed message');
  await sleep(200);
  await clickSelector('button[aria-label*="发送消息"]');
  await waitUntil(async () => (await evaluate(`(() => { const draft = (document.querySelector('[data-composer-input]')?.innerText ?? '').trim(); const bubbles = document.querySelectorAll('[data-message-bubble]').length; return draft === '' && bubbles >= 1; })()`)), { timeout: 20_000, interval: 400, label: 'seed message sent' });
}

async function drawHeroFigure({ raw, viewportWidth, crop, regions, scale, annotations, color, outPath, basePath, previewPath }) {
  const outputWidth = Math.round(crop.w * scale);
  const outputHeight = Math.round(crop.h * scale);
  const result = await evaluate(`(() => {
    const spec = ${JSON.stringify({ crop, regions, viewportWidth, outputWidth, outputHeight, annotations, color })};
    const raw = ${JSON.stringify(raw)};
    return (async () => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + raw;
      await image.decode();
      const dpr = image.naturalWidth / spec.viewportWidth;
      const canvas = document.createElement('canvas');
      canvas.width = spec.outputWidth;
      canvas.height = spec.outputHeight;
      const context = canvas.getContext('2d');
      if (Array.isArray(spec.regions)) {
        let destinationX = 0;
        for (const region of spec.regions) {
          context.drawImage(
            image,
            Math.round(region.x * dpr), Math.round(spec.crop.y * dpr),
            Math.round(region.w * dpr), Math.round(spec.crop.h * dpr),
            destinationX, 0, Math.round(region.w * spec.outputHeight / spec.crop.h), canvas.height,
          );
          destinationX += Math.round(region.w * spec.outputHeight / spec.crop.h);
        }
      } else {
        context.drawImage(
          image,
          Math.round(spec.crop.x * dpr), Math.round(spec.crop.y * dpr),
          Math.round(spec.crop.w * dpr), Math.round(spec.crop.h * dpr),
          0, 0, canvas.width, canvas.height,
        );
      }
      const base = canvas.toDataURL('image/png').split(',')[1];
      const lineWidth = 6;
      const radius = 28;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.strokeStyle = spec.color;
      context.fillStyle = spec.color;
      context.lineWidth = lineWidth;
      for (const annotation of spec.annotations) {
        const from = annotation.from;
        const to = annotation.to;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length < 1) continue;
        const ux = dx / length;
        const uy = dy / length;
        const startX = from.x + ux * (radius + 2);
        const startY = from.y + uy * (radius + 2);
        const arrowLength = 22;
        const arrowWidth = 16;
        const baseX = to.x - ux * arrowLength;
        const baseY = to.y - uy * arrowLength;
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(baseX, baseY);
        context.stroke();
        context.beginPath();
        context.moveTo(to.x, to.y);
        context.lineTo(baseX - uy * (arrowWidth / 2), baseY + ux * (arrowWidth / 2));
        context.lineTo(baseX + uy * (arrowWidth / 2), baseY - ux * (arrowWidth / 2));
        context.closePath();
        context.fill();
        context.beginPath();
        context.arc(from.x, from.y, radius, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = '#ffffff';
        context.font = '700 34px ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(annotation.number, from.x, from.y + 1);
        context.fillStyle = spec.color;
      }
      const full = canvas.toDataURL('image/png').split(',')[1];
      const previewCanvas = document.createElement('canvas');
      previewCanvas.width = Math.round(canvas.width / 2);
      previewCanvas.height = Math.round(canvas.height / 2);
      const previewContext = previewCanvas.getContext('2d');
      previewContext.imageSmoothingQuality = 'high';
      previewContext.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
      return { base, full, preview: previewCanvas.toDataURL('image/png').split(',')[1] };
    })();
  })()`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(basePath, Buffer.from(result.base, 'base64'));
  writeFileSync(outPath, Buffer.from(result.full, 'base64'));
  writeFileSync(previewPath, Buffer.from(result.preview, 'base64'));
  const size = pngPixelSize(result.full);
  log(`  ✔ wrote ${outPath.replace(REPO_ROOT + '/', '')} (${size.width}×${size.height}, ${Math.round(Buffer.from(result.full, 'base64').length / 1024)} KB)`);
  log(`  ✔ wrote ${basePath.replace(REPO_ROOT + '/', '')} and ${previewPath.replace(REPO_ROOT + '/', '')}`);
}

// Lossless PNG re-encode (identical pixels) using ffmpeg when available.
function optimizePngLossless(path) {
  const temporary = path + '.opt.png';
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path, '-compression_level', '100', '-pred', 'mixed', temporary], { encoding: 'utf8' });
  if (result.status === 0 && existsSync(temporary)) {
    renameSync(temporary, path);
    log(`  ✔ lossless re-encode ${path.replace(REPO_ROOT + '/', '')} (${Math.round(readFileSync(path).length / 1024)} KB)`);
  } else {
    try { rmSync(temporary, { force: true }); } catch { /* noop */ }
  }
}

async function runHero() {
  log('\nhero mode (task H): clean 2x base + unified numbered callouts');
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-composer-input]') !== null`)), { timeout: 30_000, label: 'composer on landing' });
  await sleep(500);

  // 1) The app may restore the last session (whose workspace is fixed). Start
  //    from a fresh landing composer so the workspace picker is available.
  let hasWorkspacePicker = await evaluate(`document.querySelector('button[aria-label="选择工作区"]') !== null`);
  if (!hasWorkspacePicker) {
    await clickByText('button, [role=button], a', '新会话');
    await waitUntil(async () => (await evaluate(`document.querySelector('button[aria-label="选择工作区"]') !== null`)), { timeout: 15_000, interval: 250, label: 'landing workspace picker' });
    hasWorkspacePicker = true;
  }

  // 2) Make sure the session lands in this repository's workspace before
  //    sending anything.
  if (hasWorkspacePicker) {
    await clickSelector('button[aria-label="选择工作区"]');
    await waitUntil(async () => (await evaluate(`document.querySelectorAll('[role=menuitem]').length > 0`)), { label: 'workspace menu' });
    await clickByText('[role=menuitem]', opts.workspace);
    await waitUntil(async () => {
      const chip = await evaluate(`document.querySelector('button[aria-label="选择工作区"]')?.innerText ?? ''`);
      return chip.includes(opts.workspace);
    }, { label: `workspace chip shows ${opts.workspace}` });
    await sleep(200);
  }

  // 3) One neutral exchange turns the landing composer into a chat composer and
  //    gives the left column real content. No live-send assertions involved.
  await sendSeedMessage('这块卡片的圆角和底色先别动，等我在预览里圈一下具体元素。');
  try {
    await waitUntil(async () => (await evaluate(`document.querySelectorAll('[data-message-bubble]').length >= 2 || document.body.innerText.includes('运行失败') || document.body.innerText.includes('RATE_LIMIT')`)), { timeout: 12_000, interval: 500, label: 'seed reply or error' });
  } catch {
    log('  · seed reply did not arrive; continuing without it');
  }
  // A rate-limited model turn renders an error block; hide it (and only it) so
  // the hero does not leak transient infrastructure failures.
  const hidError = await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('div, section, article'));
    const bad = nodes.find((node) => (node.innerText ?? '').includes('RATE_LIMIT') || (node.innerText ?? '').includes('本轮运行失败'));
    if (bad === undefined) return false;
    let block = bad;
    const scroll = document.querySelector('[data-conversation-scroll]');
    while (block.parentElement !== null && block.parentElement !== scroll) block = block.parentElement;
    block.style.display = 'none';
    return true;
  })()`);
  if (hidError) log('  · hid a transient error block from the chat column');
  await sleep(300);
  await screenshotFile('/tmp/hero-before-preview.png');

  // 2) Open the fixture preview inside the session.
  await openPreviewFixture();
  await sleep(400);

  // 3) Mask the breadcrumb path to the bare file name and hide the workspace
  //    selector, so no path/personal crumbs end up in the shot.
  await evaluate(`(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const pathSpan = spans.find((node) => /path/i.test(String(node.className ?? '')) && node.textContent.includes('apple-square.html'));
    if (pathSpan !== undefined) {
      pathSpan.textContent = 'apple-square.html';
      pathSpan.style.textAlign = 'left';
      pathSpan.style.direction = 'ltr';
      pathSpan.style.flex = '0 0 auto';
      pathSpan.style.maxWidth = 'none';
    }
    const picker = document.querySelector('button[aria-label="选择工作区"]');
    if (picker !== null) picker.style.visibility = 'hidden';
    return true;
  })()`);
  await evaluate(REDACT_PAGE_SCRIPT);

  // 4) Turn inspect mode on, then click the same topbar so the composer chip,
  //    outline, and tooltip all refer to one element: div.topbar.
  await clickSelector(RENDERER_TOGGLE);
  let chipInserted = false;
  for (let attempt = 0; attempt < 6 && !chipInserted; attempt += 1) {
    try {
      const { geometry } = await hoverUntil('div.topbar', (tooltip) => tooltip.startsWith('div.topbar'));
      await mouseClickAt(geometry.x, geometry.y);
      await sleep(350);
      chipInserted = await evaluate(`document.querySelector('[data-composer-input] [title^="<"]')?.getAttribute('title') === '<div.topbar>'`);
    } catch {
      await sleep(400);
    }
  }
  if (!chipInserted) throw new StepFailure('hero: could not insert the <div.topbar> chip');

  // 5) Reset the pinned highlight, then hover the topbar for outline + tooltip.
  await clickSelector(RENDERER_TOGGLE);
  await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') !== 'true'`)), { label: 'inspect off (pin reset)' });
  await sleep(160);
  await clickSelector(RENDERER_TOGGLE);
  const { geometry, hover } = await hoverUntil('div.topbar', (tooltip) => tooltip.startsWith('div.topbar'));
  log(`  · hero hover tooltip "${hover.tooltip}"`);
  await evalInPreview(`(() => {
    for (const node of document.querySelectorAll('.__dsh_web_inspect_hl')) {
      if (node.getAttribute('data-pinned') === 'true') node.style.display = 'none';
    }
    return true;
  })()`);
  if (await evaluate(`document.querySelector('[data-dsh-web-inspect-popover]') !== null`)) await closeInspectPopover();
  await sleep(200);

  // 6) Geometry (CSS px) for crop + callout anchors.
  const toggleRect = await rectOf(RENDERER_TOGGLE);
  const chipRect = await rectOf('[data-composer-input] [title^="<"]');
  const frameRect = geometry.frameRect;
  const headerRow = await evaluate(`(() => {
    const wanted = 'apple-square.html';
    const spans = Array.from(document.querySelectorAll('span'));
    const pathSpan = spans.find((node) => node.textContent.includes(wanted) && /path/i.test(String(node.className ?? '')));
    if (pathSpan === undefined) return null;
    let row = pathSpan;
    while (row.parentElement !== null) {
      const rect = row.getBoundingClientRect();
      if (rect.height >= 22 && rect.height <= 48 && rect.width > 600 && row.querySelector('button') !== null) break;
      row = row.parentElement;
    }
    const rect = row.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  })()`);
  const highlight = await evalInPreview(`(() => {
    const node = document.querySelector('.__dsh_web_inspect_hl');
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height, pinned: node.getAttribute('data-pinned') === 'true' };
  })()`);
  log('  · hero header row ' + JSON.stringify(headerRow));
  log('  · hero frame=' + JSON.stringify(frameRect) + ' toggle=' + JSON.stringify(toggleRect) + ' chip=' + JSON.stringify(chipRect));

  const left = HERO_VIEWPORT.width - HERO_CROP_WIDTH;
  const top = clamp(Math.round((headerRow?.y ?? 40) - 6), 0, HERO_VIEWPORT.height - HERO_CROP_HEIGHT);
  const bottom = top + HERO_CROP_HEIGHT;
  const crop = { x: left, y: top, w: HERO_CROP_WIDTH, h: HERO_CROP_HEIGHT };

  // Hide transient turn status (thinking trace / skill loading / deep-search
  // spinner): they are infrastructure chatter, not part of the story.
  const hidStatus = await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return false;
    const patterns = [/^思考/, /深度求索中/, /加载技能/, /I need to respond/];
    let hidden = 0;
    for (const node of Array.from(scroll.querySelectorAll('*'))) {
      const text = (node.innerText ?? '').trim();
      if (text.length === 0 || !patterns.some((pattern) => pattern.test(text))) continue;
      let block = node;
      while (block.parentElement !== null && block.parentElement !== scroll) {
        if (block.querySelector?.('[data-message-bubble]') !== null) break;
        block = block.parentElement;
      }
      if (block.querySelector?.('[data-message-bubble]') !== null && block !== node) continue;
      if (block.style.display !== 'none') {
        block.style.display = 'none';
        hidden += 1;
      }
    }
    return hidden;
  })()`);
  if (hidStatus) log(`  · hid ${hidStatus} transient status block(s)`);
  // Removing tall status blocks can leave the list scrolled past the user
  // bubble; reset to the top so the visible chat starts with the message.
  await evaluate(`(() => { const scroll = document.querySelector('[data-conversation-scroll]'); if (scroll !== null) scroll.scrollTop = 0; return true; })()`);
  const bubbleState = await evaluate(`(() => ({ bubbles: document.querySelectorAll('[data-message-bubble]').length, visible: Array.from(document.querySelectorAll('[data-message-bubble]')).some((node) => { const r = node.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; }) }))()`);
  log('  · chat bubbles ' + JSON.stringify(bubbleState));

  const raw = await captureViewportRaw();
  const rawSize = pngPixelSize(raw);
  if (rawSize.width < HERO_VIEWPORT.width * 2 * 0.98) throw new StepFailure(`hero: viewport is not 2x (${rawSize.width}px wide)`);

  // 7) Three callouts in device pixels (canvas space after the integer crop).
  const scale = 2;
  const toPoint = (css) => ({ x: Math.round((css.x - crop.x) * scale), y: Math.round((css.y - crop.y) * scale) });
  const toggleTarget = toPoint({ x: toggleRect.x + toggleRect.width + 5, y: toggleRect.y + toggleRect.height / 2 });
  const toggleCircle = toPoint({ x: toggleRect.x + toggleRect.width + 75, y: toggleRect.y + toggleRect.height / 2 });
  const outlineTarget = toPoint({ x: frameRect.x + highlight.x - 5, y: frameRect.y + highlight.y + highlight.h / 2 });
  const outlineCircle = toPoint({ x: frameRect.x + highlight.x - 75, y: frameRect.y + highlight.y + highlight.h / 2 });
  const chipTarget = toPoint({ x: chipRect.x + chipRect.width + 5, y: chipRect.y + chipRect.height / 2 });
  const chipCircle = toPoint({ x: chipRect.x + chipRect.width + 75, y: chipRect.y + chipRect.height / 2 });

  await drawHeroFigure({
    raw,
    viewportWidth: HERO_VIEWPORT.width,
    crop,
    scale,
    annotations: [
      { number: '1', from: toggleCircle, to: toggleTarget },
      { number: '2', from: outlineCircle, to: outlineTarget },
      { number: '3', from: chipCircle, to: chipTarget },
    ],
    color: HERO_COLOR,
    outPath: join(ASSETS_DIR, 'howto.png'),
    basePath: join(REPO_ROOT, 'tests', 'screens', 'hero-base.png'),
    previewPath: join(REPO_ROOT, 'tests', 'screens', 'hero-preview.png'),
  });
  optimizePngLossless(join(ASSETS_DIR, 'howto.png'));
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

async function main() {
  const hero = opts.hero === true;
  opts.fixture = 'fixtures/apple-square.html';
  opts.target = hero ? 'div.topbar' : '#shape-round';
  opts.expectLabel = hero ? '<div.topbar>' : '<button#shape-round>';

  log(`\ndsh-web-inspect shots — ${opts.gui}`);
  log(`fixture: ${opts.fixture}   target: ${opts.target}`);
  log('');

  const authority = new URL(opts.gui).host;
  const cookie = mintAuthCookie(authority);
  const chromePath = resolveChromePath();
  chromeDir = mkdtempSync(join(tmpdir(), 'dsh-web-inspect-shots-'));
  const launched = await launchChrome({ chromePath, userDataDir: chromeDir, headless: true });
  chromeProc = launched.proc;
  browserPort = launched.port;
  const connected = await connectBrowser(browserPort);
  cdp = connected.cdp;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  sessionId = attached.sessionId;
  for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) {
    await cdp.send(domain, {}, sessionId);
  }
  trackFrameContexts();
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  // 2x device scale: every clipped capture below is rasterised at 2x, which is
  // what makes the two README close-ups printable/Retina-crisp.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: hero ? 'light' : 'dark' }] }, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: hero ? HERO_VIEWPORT.width : 1900,
    height: hero ? HERO_VIEWPORT.height : 1100,
    deviceScaleFactor: 2,
    mobile: false,
  }, sessionId);
  await cdp.send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    url: `${opts.gui}/`,
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    expires: (Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000,
  }, sessionId);
  await cdp.send('Page.navigate', { url: `${opts.gui}/` }, sessionId);
  await waitUntil(async () => {
    const state = await evaluate(`({
      boot: typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__ !== null,
      ready: '__DSH_BOOT_READY__' in window,
      composer: document.querySelector('[data-composer-input]') !== null,
      text: document.body?.innerText ?? '',
    })`);
    return state.boot && state.ready && state.composer && !state.text.includes('Loading plugins');
  }, { timeout: 60_000, label: 'DSH app shell + composer ready' });

  if (hero) {
    await runHero();
    log('\nhero done.');
    return;
  }
  await openPreviewFixture();
  await evaluate(REDACT_PAGE_SCRIPT);
  await sleep(150);

  // The right dock animates open; wait until its frame rect stops moving before
  // measuring/capturing the header strip (otherwise the chat panel is still
  // visible at the header row's x range).
  let stableFrame = null;
  let previousFrame = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const probe = await evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
      if (frame === null) return null;
      const rect = frame.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width) };
    })()`);
    if (probe !== null && previousFrame !== null && probe.x === previousFrame.x && probe.w === previousFrame.w) {
      stableFrame = probe;
      break;
    }
    previousFrame = probe;
    await sleep(320);
  }
  log('  · stable preview frame ' + JSON.stringify(stableFrame));
  if (stableFrame === null) throw new StepFailure('preview panel never reached a stable position');

  // Header strip for figure 1: the preview title bar (file name + 「检查元素」),
  // captured BEFORE the toggle flips to 「退出检查」. The breadcrumb path is
  // masked down to the bare file name so no absolute path can appear.
  const headerBar = await evaluate(`(() => {
    const wanted = 'apple-square.html';
    const spans = Array.from(document.querySelectorAll('span'));
    const pathSpan = spans.find((node) => {
      if (!node.textContent.includes(wanted)) return false;
      const cls = String(node.className ?? '');
      return /path/i.test(cls);
    }) ?? spans.find((node) => node.textContent.includes(wanted) && node.textContent.includes('/'));
    if (pathSpan === undefined) return null;
    let row = pathSpan;
    while (row.parentElement !== null) {
      const rect = row.getBoundingClientRect();
      if (rect.height >= 22 && rect.height <= 48 && rect.width > 600 && row.querySelector('button') !== null) break;
      row = row.parentElement;
    }
    pathSpan.textContent = wanted;
    pathSpan.style.textAlign = 'left';
    pathSpan.style.direction = 'ltr';
    pathSpan.style.flex = '0 0 auto';
    pathSpan.style.maxWidth = 'none';
    const rect = row.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  })()`);
  log('  · header bar ' + JSON.stringify(headerBar));  const headerRaw = await captureViewportRaw();

  // ---- figure 1: hover highlight + tooltip inside the preview panel ------
  await clickSelector(RENDERER_TOGGLE);
  await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true'`)), { label: 'inspect toggle on' });
  await waitUntil(async () => {
    try {
      const state = await evalInPreview(`(() => ({
        highlight: document.querySelector('.__dsh_web_inspect_hl') !== null,
        tooltip: document.querySelector('.__dsh_web_inspect_tip') !== null,
      }))()`);
      return state.value.highlight && state.value.tooltip;
    } catch { return false; }
  }, { timeout: 10_000, label: 'inspect overlay mounted in the iframe' });

  // The right panel can still be finishing its open animation when the first
  // rect is read, so re-read the frame + element rect right before every
  // pointer move and retry until the runtime paints the hover overlay.
  let geometry = null;
  let hoverState = null;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const point = await previewPoint(opts.target);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 }, sessionId);
    await sleep(200);
    try {
      const state = await evalInPreview(HOVER_STATE_IN_FRAME);
      if (state.value !== null && state.value.visible === true && typeof state.value.tooltip === 'string' && state.value.tooltip !== '') {
        geometry = point;
        hoverState = state.value;
        break;
      }
    } catch { /* context mid-navigation */ }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 3, y: point.y + 3, button: 'none', buttons: 0 }, sessionId);
    await sleep(120);
  }
  if (geometry === null) {
    const diag = {
      hoverState,
      viewport: await evaluate(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`),
      frame: await evaluate(`(() => { const f = document.querySelector(${JSON.stringify(INSPECT_FRAME)}); if (f === null) return null; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, sandbox: f.getAttribute('sandbox') }; })()`),
      inFrame: await evalInPreview(`(() => ({
        overlay: (() => { const node = document.querySelector('.__dsh_web_inspect_hl'); return node === null ? null : { display: getComputedStyle(node).display, rect: node.getBoundingClientRect().toJSON() }; })(),
        tip: (() => { const node = document.querySelector('.__dsh_web_inspect_tip'); return node === null ? null : { text: node.textContent, display: getComputedStyle(node).display }; })(),
        targetRect: (() => { const node = document.querySelector('#shape-round'); if (node === null) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
      }))()`).catch((error) => ({ error: String(error) })),
    };
    log('hover diagnostics: ' + JSON.stringify(diag).slice(0, 2000));
    throw new StepFailure('hover highlight + tooltip never appeared');
  }
  log(`  · hover target ${opts.target} tooltip "${hoverState.tooltip}"`);
  await sleep(150);
  const frameRect = geometry.frameRect;
  const viewportWidth = 1900;
  const viewportHeight = 1100;
  const pad = 56; // 28 CSS px of matte on every side, in device pixels
  const frameCss = { x: Math.round(frameRect.x), y: Math.round(frameRect.y), w: Math.round(frameRect.width) };
  const headerCss = headerBar === null ? null : { x: Math.round(headerBar.x), y: Math.round(headerBar.y), w: Math.round(headerBar.w), h: Math.round(headerBar.h) };
  const headerH = headerCss === null ? 0 : headerCss.h;
  const bodyH = 268;
  const bodyTop = frameCss.y + 10;
  const cropW = Math.max(frameCss.w, headerCss === null ? 0 : headerCss.w);
  const appBackground = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  const bodyRaw = await captureViewportRaw();
  const rawSize = pngPixelSize(bodyRaw);
  log(`  · viewport screenshot ${rawSize.width}×${rawSize.height} (expected ${viewportWidth * 2}×${viewportHeight * 2})`);
  if (rawSize.width < viewportWidth * 1.5) {
    throw new StepFailure('deviceScaleFactor=2 was not honoured by the screenshot (got 1x pixels)');
  }
  const figureLayers = [];
  if (headerCss !== null) {
    figureLayers.push({
      image: 0,
      css: { x: frameCss.x, y: headerCss.y, w: frameCss.w, h: headerCss.h },
      dest: { x: pad, y: pad, w: frameCss.w * 2, h: headerCss.h * 2 },
    });
  }
  figureLayers.push({
    image: 1,
    css: { x: frameCss.x, y: bodyTop, w: frameCss.w, h: bodyH },
    dest: { x: pad + (cropW - frameCss.w), y: pad + headerH * 2, w: frameCss.w * 2, h: bodyH * 2 },
  });
  await renderFigure({
    images: [headerRaw, bodyRaw],
    viewportWidth,
    viewportHeight,
    outputWidth: pad * 2 + cropW * 2,
    outputHeight: pad * 2 + headerH * 2 + bodyH * 2,
    background: appBackground,
    radius: 24,
    layers: figureLayers,
    outPath: join(ASSETS_DIR, 'howto-select.png'),
  });

  // ---- figure 2: composer chip + the folded chip in the sent bubble ------
  await mouseClickAt(geometry.x, geometry.y);
  await waitUntil(async () => (await evaluate(`document.querySelectorAll('[data-composer-input] [title^="<"]').length >= 1`)), { timeout: 15_000, label: 'chip inserted into the composer' });

  // Put a caret right after the chip so the composer reads as "still a draft".
  const chipRect = await rectOf('[data-composer-input] [title^="<"]');
  await mouseClickAt(Math.round(chipRect.x + chipRect.width + 10), Math.round(chipRect.y + chipRect.height / 2));
  await sleep(120);
  if (await evaluate(`document.querySelector('[data-dsh-web-inspect-popover]') !== null`)) await closeInspectPopover();
  await sleep(80);
  const chipRect2 = await rectOf('[data-composer-input] [title^="<"]');
  const composerRect = await rectOf('[data-composer-input]');
  const viewportWidth2 = 1900;
  const viewportHeight2 = 1100;
  const chipBox = chipRect2;
  const composerCrop = {
    x: clamp(Math.round(chipBox.x - 4), 0, viewportWidth2 - 10),
    y: clamp(Math.round(chipBox.y - 4), 0, viewportHeight2 - 10),
    w: Math.round(chipBox.width + 220),
    h: Math.round(chipBox.height + 20),
  };
  composerCrop.x = clamp(composerCrop.x, 0, viewportWidth2 - composerCrop.w);
  composerCrop.y = clamp(composerCrop.y, 0, viewportHeight2 - composerCrop.h);
  const composerRaw = await captureViewportRaw();
  log('  · composer crop ' + JSON.stringify(composerCrop));

  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button[aria-label]'))
      .find((candidate) => /发送消息/u.test(candidate.getAttribute('aria-label') ?? '') && candidate.disabled !== true);
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-conversation-scroll] [data-dsh-web-inspect-chip]') !== null`)), { timeout: 120_000, label: 'sent bubble with folded chip' });
  await dismissErrorToasts();
  await sleep(400);
  const bubbleRect = await evaluate(`(() => {
    const chip = document.querySelector('[data-conversation-scroll] [data-dsh-web-inspect-chip]');
    if (chip === null) return null;
    const bubble = chip.closest('[data-message-bubble]') ?? chip;
    const row = chip.closest('[data-message-id]') ?? bubble.parentElement ?? bubble;
    const toRect = (node) => { const rect = node.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; };
    return { bubble: toRect(bubble), row: toRect(row) };
  })()`);
  const bubbleCrop = {
    x: clamp(Math.round(bubbleRect.bubble.x - 18), 0, viewportWidth2 - 10),
    y: clamp(Math.round(bubbleRect.row.y - 10), 0, viewportHeight2 - 10),
    w: Math.round(bubbleRect.bubble.width + 36),
    h: Math.round(bubbleRect.row.height + 20),
  };
  bubbleCrop.x = clamp(bubbleCrop.x, 0, viewportWidth2 - bubbleCrop.w);
  bubbleCrop.y = clamp(bubbleCrop.y, 0, viewportHeight2 - bubbleCrop.h);
  const appBackground2 = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  const sendRaw = await captureViewportRaw();
  const sendSize = pngPixelSize(sendRaw);
  if (sendSize.width < viewportWidth2 * 1.5) throw new StepFailure('deviceScaleFactor=2 was not honoured by the screenshot (got 1x pixels)');
  const outputWidth = 1800;
  const columnWidth = Math.max(composerCrop.w, bubbleCrop.w) * 2;
  const columnX = Math.round((outputWidth - columnWidth) / 2);
  const topY = 64;
  const gap = 40;
  const outputHeight = topY + composerCrop.h * 2 + gap + bubbleCrop.h * 2 + 64;
  await renderFigure({
    images: [composerRaw, sendRaw],
    viewportWidth: viewportWidth2,
    viewportHeight: viewportHeight2,
    outputWidth,
    outputHeight,
    background: appBackground2,
    radius: 0,
    layers: [
      { image: 0, css: composerCrop, dest: { x: columnX, y: topY, w: composerCrop.w * 2, h: composerCrop.h * 2 } },
      { image: 1, css: bubbleCrop, dest: { x: columnX + columnWidth - bubbleCrop.w * 2, y: topY + composerCrop.h * 2 + gap, w: bubbleCrop.w * 2, h: bubbleCrop.h * 2 } },
    ],
    outPath: join(ASSETS_DIR, 'howto-send.png'),
  });

  // Task F: the README only keeps these two figures (plus the skill body).
  const keep = new Set(['howto-select.png', 'howto-send.png']);
  for (const entry of readdirSync(ASSETS_DIR)) {
    if (!entry.endsWith('.png') || keep.has(entry)) continue;
    unlinkSync(join(ASSETS_DIR, entry));
    log(`  · removed legacy asset ${entry}`);
  }
  log('\nshots done.');
}

main().then(async () => {
  try { chromeProc?.kill('SIGKILL'); } catch { /* noop */ }
  try { if (chromeDir !== undefined && chromeDir !== null) rmSync(chromeDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(0);
}).catch(async (error) => {
  console.error('\nshots failed:', error instanceof Error ? error.message : error);
  try { chromeProc?.kill('SIGKILL'); } catch { /* noop */ }
  try { if (chromeDir !== undefined && chromeDir !== null) rmSync(chromeDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
