#!/usr/bin/env node
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
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

async function main() {
  log(`\ndsh-web-inspect E2E — ${opts.gui}`);
  log(`fixture: ${opts.fixture}   target: ${opts.target}   workspace: ${opts.workspace}`);
  log('');

  // ---- 1. auth ----------------------------------------------------------
  const authority = new URL(opts.gui).host;
  let cookie = null;
  if (opts.token !== null) {
    facts.auth = 'launch-token URL (?token=…; server sets the cookie)';
  } else {
    cookie = mintAuthCookie(authority);
    facts.auth = `self-signed ${cookie.name} cookie (HMAC from ~/.dsh/.credentials.yaml browser-session secret, authority ${authority})`;
  }
  record('auth', 'PASS', facts.auth);

  // ---- 2. launch Chrome ------------------------------------------------
  const chromePath = resolveChromePath();
  facts.chrome = chromePath;
  if (opts.remotePort !== null) {
    browserPort = opts.remotePort;
    log(`  · reusing Chrome on port ${browserPort}`);
  } else {
    chromeDir = mkdtempSync(join(tmpdir(), 'dsh-web-inspect-e2e-'));
    const launched = await launchChrome({ chromePath, userDataDir: chromeDir, headless: !opts.headed });
    chromeProc = launched.proc;
    browserPort = launched.port;
  }
  record('chrome', 'PASS', `${opts.remotePort === null ? (opts.headed ? 'headed' : 'headless') : 'reused'} on 127.0.0.1:${browserPort}`);

  // ---- 3. CDP session + page ------------------------------------------
  const connected = await connectBrowser(browserPort);
  cdp = connected.cdp;
  facts.browser = connected.info.Browser;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  sessionId = attached.sessionId;
  for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await cdp.send(domain, {}, sessionId);
  trackFrameContexts();
  // Auto-attach flattened child targets (OOPIF preview frames) so their
  // execution contexts reach Runtime.executionContextCreated.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'warning') return;
    const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? arg.type).join(' ');
    consoleErrors.push({ source: 'console', type: params.type, text: text.slice(0, 1200) });
    if (params.type === 'error') debug(`console.error: ${text.slice(0, 400)}`);
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    const description = params.exceptionDetails?.exception?.description
      ?? params.exceptionDetails?.text
      ?? 'uncaught exception';
    consoleErrors.push({ source: 'exception', text: String(description).slice(0, 2000) });
    debug(`uncaught: ${String(description).slice(0, 400)}`);
  });
  cdp.on('Log.entryAdded', (params) => {
    const entry = params.entry;
    if (entry?.level !== 'error' && entry?.level !== 'warning') return;
    consoleErrors.push({ source: `log:${entry.source ?? '?'}`, type: entry.level, text: String(entry.text ?? '').slice(0, 1200) });
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  if (opts.assetsDir !== null) {
    // A wider capture so the cropped (sidebar-free) README images stay inside
    // the 1200-1600px logical width range while showing chat + preview.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  }

  const entryUrl = opts.token === null ? `${opts.gui}/` : `${opts.gui}/?token=${encodeURIComponent(opts.token)}`;
  if (cookie !== null) {
    await cdp.send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      url: `${opts.gui}/`,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
      expires: (Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000,
    }, sessionId);
  }
  await cdp.send('Page.navigate', { url: entryUrl }, sessionId);

  await waitUntil(async () => {
    const state = await evaluate(`({
      boot: typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__ !== null,
      ready: '__DSH_BOOT_READY__' in window,
      composer: document.querySelector('[data-composer-input]') !== null,
      text: document.body?.innerText ?? '',
    })`);
    return state.boot && state.ready && state.composer && !state.text.includes('Loading plugins');
  }, { label: 'DSH app shell + composer ready' });
  const boot = await evaluate(`(() => {
    const payload = window.__DSH_BOOT__;
    const entries = payload?.entries ?? [];
    const inspectEntry = entries.find((entry) => entry.id === 'dsh-web-inspect') ?? null;
    return {
      rev: payload?.rev ?? null,
      version: payload?.release?.version ?? null,
      entries: entries.map((entry) => entry.id),
      inspectEntry: inspectEntry && { url: inspectEntry.url, rev: inspectEntry.rev ?? null },
    };
  })()`);
  // Never trust a cached/hardcoded bundle rev: the profile HMR reloads the
  // plugin bundle with a new `rev` on every recomposition, and the boot payload
  // is the only source of truth for the code this page will execute.
  facts.app = { version: boot.version, bootRev: boot.rev, clientEntries: boot.entries.length };
  facts.pluginEntry = boot.inspectEntry;
  record('open-gui', 'PASS', `app ${boot.version ?? '?'}, boot rev ${boot.rev ?? '?'}, ${boot.entries.length} client entries, composer mounted`);

  // ---- 4. plugin presence ---------------------------------------------
  const pluginLoaded = await waitUntil(async () => {
    const state = await evaluate(`({
      styleTag: document.querySelector('style[data-plugin="dsh-web-inspect"]') !== null
        || Array.from(document.querySelectorAll('style')).some((style) => /__dsh_web_inspect_/u.test(style.textContent ?? '')),
      bootEntry: (window.__DSH_BOOT__?.entries ?? []).some((entry) => entry.id === 'dsh-web-inspect'),
    })`);
    return state.styleTag || state.bootEntry ? state : null;
  }, { timeout: 8_000, label: 'dsh-web-inspect client bundle' }).catch(() => null);

  facts.plugin = pluginLoaded === null
    ? { loaded: false }
    : { loaded: true, signals: Object.entries(pluginLoaded).filter(([, value]) => value).map(([key]) => key), entry: boot.inspectEntry };
  if (pluginLoaded === null) {
    // Soft failure: keep walking the navigation chain so the report still shows
    // where the environment breaks; PluginMissingError is thrown at the toggle.
    const detail = 'dsh-web-inspect missing from window.__DSH_BOOT__.entries and no style[data-plugin="dsh-web-inspect"] — plugin not installed/activated (see docs/notes/install-verify.md)';
    log(`  ✖ plugin-loaded — ${detail}`);
    steps.push({ name: 'plugin-loaded', status: 'FAIL', detail, at: new Date().toISOString() });
  } else {
    record('plugin-loaded', 'PASS', `signals: ${facts.plugin.signals.join(', ')}${boot.inspectEntry?.rev ? `; bundle rev ${boot.inspectEntry.rev}` : ''}`);
  }

  // ---- 4b. served bundle: boot URL must serve the code the page executes ----
  if (pluginLoaded !== null && facts.pluginEntry !== null) {
    if (cookie === null) {
      record('plugin-bundle', 'SKIP', 'token mode — Node cannot reuse the browser cookie for a bundle fetch');
    } else {
      const bundlePath = String(facts.pluginEntry.url ?? '');
      const bundleUrl = `${opts.gui}/${bundlePath.replace(/^\/+|^/u, '').replace(/^\//u, '')}`;
      const response = await fetch(bundlePath.startsWith('http') ? bundlePath : bundleUrl, {
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
      const source = await response.text();
      const served = {
        url: bundleUrl,
        status: response.status,
        bytes: Buffer.byteLength(source),
        revMatches: facts.pluginEntry.rev === null ? false : bundleUrl.includes(`rev=${facts.pluginEntry.rev}`),
        runtimeFunction: source.includes('function inspectRuntime'),
        messageSource: source.includes('dsh-web-inspect') && source.includes('postMessage'),
        newChipPrefix: source.includes('dsh-web-inspect:v1:'),
        legacyChipPrefix: source.includes('dsh-inspect:v1:'),
        frameAttribute: source.includes('data-dsh-web-inspect-frame'),
        extraSentinels: source.includes('<!--dsh-inspect:v1-->') && source.includes('<!--/dsh-inspect-->'),
        weakSandbox: source.includes('allow-scripts allow-same-origin'),
      };
      facts.served = served;
      const servedChecks = [
        ['served bundle responds 200', served.status === 200],
        ['served bundle URL carries the boot rev', served.revMatches],
        ['served bundle exposes the injected runtime', served.runtimeFunction],
        ['served bundle uses the postMessage bridge source', served.messageSource],
        ['served bundle knows the new chip prefix', served.newChipPrefix],
        ['served bundle still decodes the legacy chip prefix', served.legacyChipPrefix],
        ['served bundle marks its frame attribute', served.frameAttribute],
        ['served bundle still folds legacy sentinels', served.extraSentinels],
        ['served bundle never asks for allow-same-origin', !served.weakSandbox],
      ];
      const servedFailed = servedChecks.filter(([, ok]) => !ok).map(([label]) => label);
      if (servedFailed.length > 0) {
        throw new StepFailure(`served plugin bundle failed checks: ${servedFailed.join(', ')}\n  served: ${JSON.stringify(served)}`);
      }
      record('plugin-bundle', 'PASS', `${served.bytes} B from ${served.url.replace(opts.gui, '')} (rev matches boot; runtime + postMessage + new/legacy prefixes; no allow-same-origin)`);
    }
  }

  // ---- 5. deterministic workspace -------------------------------------
  // A fresh browser profile restores a server-side "last workspace", which may
  // be any workspace the user touched recently; select ours explicitly.
  await clickSelector('button[aria-label="选择工作区"]');
  await waitUntil(async () => (await evaluate(`document.querySelectorAll('[role=menuitem]').length > 0`)), { label: 'workspace menu' });
  await clickByText('[role=menuitem]', opts.workspace);
  await waitUntil(async () => {
    const chip = await evaluate(`document.querySelector('button[aria-label="选择工作区"]')?.innerText ?? ''`);
    return chip.includes(opts.workspace);
  }, { label: `workspace chip shows ${opts.workspace}` });
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-composer-input]') !== null`)), { label: 'composer after workspace switch' });
  facts.session = await evaluate(`(() => {
    const raw = localStorage.getItem('dsh.sessions.current');
    if (raw === null) return null;
    try { return JSON.parse(raw).sessionId ?? null; } catch { return null; }
  })()`);
  record('select-workspace', 'PASS', `${opts.workspace} (session ${facts.session ?? '?'})`);

  // ---- 6. right sidebar files page ------------------------------------
  // Switching workspace remounts the conversation shell, so the top-right
  // expand button can briefly disappear: wait for a *visible* surface, never
  // treat an invisible/aria-hidden collapsed panel as "already open".
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
    debug('files guide entry absent; treating existing tab as the files page');
  });
  await waitUntil(async () => (await evaluate(`document.querySelectorAll('li[data-files-entry]').length > 0`)), { label: 'files tree rows' });
  const tree = await evaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-panel]');
    return {
      root: (panel?.innerText ?? '').split('\\n')[1] ?? null,
      dirs: Array.from(panel?.querySelectorAll('li[data-files-entry=directory]') ?? []).map((row) => row.getAttribute('data-files-path')),
      files: Array.from(panel?.querySelectorAll('li[data-files-entry=file]') ?? []).map((row) => row.getAttribute('data-files-path')),
      tabs: Array.from(panel?.querySelectorAll('[data-dockkit-tab]') ?? []).map((tab) => tab.innerText.trim()),
    };
  })()`);
  facts.filesTree = tree;
  record('open-files-page', 'PASS', `root ${tree.root ?? '?'}, ${tree.dirs.length} dirs, ${tree.files.length} files`);

  // ---- 7. open the fixture preview ------------------------------------
  const fixtureAbs = isAbsolute(opts.fixture) ? opts.fixture : resolve(REPO_ROOT, opts.fixture);
  if (!existsSync(fixtureAbs)) throw new EnvironmentError(`fixture not found: ${fixtureAbs}`);
  const relative = opts.fixture.replace(/^\.\//u, '');
  const segments = relative.split('/');
  // Expand each parent directory (the tree is lazily loaded per level).
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

  const preview = await waitUntil(async () => (await evaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-panel]');
    const url = Array.from(panel?.querySelectorAll('[data-textpreview-url]') ?? [])
      .map((node) => node.getAttribute('data-textpreview-url'))
      .find((value) => value !== null && value.includes(${JSON.stringify(basename(fixtureAbs))}));
    if (url === undefined) return null;
    return {
      address: url,
      tabs: Array.from(panel.querySelectorAll('[data-dockkit-tab]')).map((tab) => tab.innerText.trim()),
      state: panel.querySelector('[data-textpreview-state]')?.getAttribute('data-textpreview-state') ?? null,
    };
  })()`)), { timeout: opts.timeout, label: `preview tab for ${basename(fixtureAbs)}` });
  facts.preview = preview;
  const addressSession = preview.address?.match(/^dsh-resource:\/\/file\/session\/([^/]+)\//u)?.[1] ?? null;
  facts.preview.sessionId = addressSession;
  if (facts.session === null) facts.session = addressSession; // pre-switch DOM might not expose it yet
  record('open-preview', 'PASS', `tab "${preview.tabs.at(-1)}", address ${preview.address}`);

  // 7b. security model: the plugin renderer must mount an OPAQUE-origin frame
  // (sandbox="allow-scripts" only) and bridge through postMessage — the parent
  // is not allowed to read contentDocument any more.
  const frameEvidence = pluginLoaded === null ? null : await waitUntil(async () => (await evaluate(`(() => {
    const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
    if (frame === null) return null;
    // The fixed plugin mounts the iframe once with the decoded srcdoc; a blank
    // initial mount would be a stale/pre-fix build and must not be asserted.
    if (String(frame.getAttribute('srcdoc') ?? '').length === 0) return null;
    const rect = frame.getBoundingClientRect();
    let sameOriginDocument = 'missing';
    let contentWindowDocument = 'missing';
    try {
      const doc = frame.contentDocument;
      sameOriginDocument = doc === null ? 'null' : 'accessible';
    } catch (error) { sameOriginDocument = error.name; }
    try {
      const doc = frame.contentWindow?.document;
      contentWindowDocument = doc === null ? 'null' : 'accessible';
    } catch (error) { contentWindowDocument = error.name; }
    return {
      sandbox: frame.getAttribute('sandbox'),
      sandboxTokenList: String(frame.getAttribute('sandbox') ?? '').split(' ').filter(Boolean),
      dataAttr: frame.getAttribute('data-dsh-web-inspect-frame') !== null,
      sameOriginDocument,
      contentWindowDocument,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      parentOrigin: location.origin,
    };
  })()`)), { timeout: 12_000, label: 'plugin preview iframe' }).catch(() => null);
  if (pluginLoaded !== null && frameEvidence === null) {
    const diagnostics = await evaluate(`(() => {
      const panel = document.querySelector('[data-sidebar-right-panel]');
      return {
        tabs: Array.from(panel?.querySelectorAll('[data-dockkit-tab]') ?? []).map((tab) => tab.innerText.trim()),
        builtinFrames: Array.from(panel?.querySelectorAll('iframe[data-html-preview]') ?? []).map((frame) => ({
          sandbox: frame.getAttribute('sandbox'),
          src: String(frame.getAttribute('src') ?? '').slice(0, 60),
        })),
        bar: panel?.querySelector('.__dsh_web_inspect_bar')?.innerText ?? null,
        toggle: panel?.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.innerText ?? null,
      };
    })()`);
    facts.rendererDiagnostics = diagnostics;
    throw new StepFailure(
      'the plugin renderer did not take over the HTML preview (no iframe[data-dsh-web-inspect-frame]). '
      + `diagnostics: ${JSON.stringify(diagnostics)}; console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
    );
  }
  if (pluginLoaded !== null) {
    // The parent cannot touch the frame DOM: reach it through CDP's per-frame
    // default execution context instead.
    let previewContextId;
    try {
      previewContextId = await waitPreviewContext(opts.timeout);
    } catch (error) {
      const parentView = await evaluate(`(() => {
        const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
        if (frame === null) return { frame: null };
        const srcdoc = frame.getAttribute('srcdoc') ?? '';
        return {
          sandbox: frame.getAttribute('sandbox'),
          srcdocLength: srcdoc.length,
          srcdocHead: srcdoc.slice(0, 160),
          runtimeTagIndex: srcdoc.indexOf('data-dsh-web-inspect-runtime'),
          rect: (() => { const rect = frame.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; })(),
          contentDocument: frame.contentDocument === null ? 'null' : 'accessible',
        };
      })()`);
      let frameTree = null;
      try { frameTree = await listFrames(); } catch { frameTree = 'unavailable'; }
      facts.frameDiagnostics = {
        error: error instanceof Error ? error.message : String(error),
        parentView,
        frames: frameTree,
        trackedContexts: [...previewContexts.entries()].map(([frameId, value]) => ({ frameId, contextId: value.contextId, sessionId: value.sessionId === sessionId ? 'page' : value.sessionId, origin: value.origin, isDefault: value.isDefault })),
        attachedSessions: [...attachedSessions.entries()],
      };
      throw new StepFailure(`preview iframe execution context was never exposed to CDP (see facts.frameDiagnostics): ${JSON.stringify(facts.frameDiagnostics).slice(0, 2200)}`);
    }
    const bridge = await previewContext();
    // The OOPIF is attached before its srcDoc navigation commits, so the first
    // execution context can still be the initial about:blank document. Poll
    // until the injected runtime script and the fixture body are live.
    const IN_FRAME_STATE = `(() => {
      const runtimeScript = document.querySelector('script[data-dsh-web-inspect-runtime="1"]');
      const globals = Object.keys(window).filter((key) => /element_inspect|dsh_inspect/i.test(key));
      let parentAccess;
      try { void parent.document; parentAccess = 'accessible'; } catch (error) { parentAccess = error.name; }
      const scripts = Array.from(document.scripts ?? []);
      const runtimeIndex = scripts.findIndex((script) => script.hasAttribute('data-dsh-web-inspect-runtime'));
      return {
        docTitle: document.title,
        runtimeScript: runtimeScript !== null,
        runtimeScriptCount: document.querySelectorAll('script[data-dsh-web-inspect-runtime="1"]').length,
        runtimeFirstScript: runtimeIndex === 0,
        runtimeScriptIndex: runtimeIndex,
        scriptCount: scripts.length,
        overlayMounted: document.querySelector('.__dsh_web_inspect_hl') !== null,
        globals,
        parentAccess,
        readyState: document.readyState,
        bodyChildren: document.body === null ? 0 : document.body.children.length,
        bodyFirstChild: document.body?.firstElementChild?.tagName ?? null,
        origin: location.origin,
      };
    })()`;
    let inFrame;
    try {
      inFrame = await waitUntil(async () => {
        try {
          const state = await evalInPreview(IN_FRAME_STATE);
          return state.value.runtimeScript === true && state.value.bodyChildren > 0 ? state : null;
        } catch { return null; } // context replaced by the srcdoc navigation — retry
      }, { timeout: 20_000, interval: 120, label: 'srcdoc document with injected inspect runtime' });
    } catch (error) {
      const parentFrames = await evaluate(`Array.from(document.querySelectorAll('iframe')).map((frame) => ({
        sandbox: frame.getAttribute('sandbox'),
        srcdocLength: (frame.getAttribute('srcdoc') ?? '').length,
        src: String(frame.getAttribute('src') ?? '').slice(0, 80),
        attr: frame.hasAttribute('data-dsh-web-inspect-frame'),
        rect: (() => { const r = frame.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
      }))`);
      const childTrees = [];
      for (const [targetId, childSessionId] of attachedSessions) {
        try {
          const { frameTree } = await cdp.send('Page.getFrameTree', {}, childSessionId);
          childTrees.push({ targetId, childSessionId, frame: { id: frameTree.frame.id, url: frameTree.frame.url, parentId: frameTree.frame.parentId ?? null } });
        } catch (childError) {
          childTrees.push({ targetId, childSessionId, error: String(childError) });
        }
      }
      const contextDumps = await dumpTrackedContexts();
      // Isolated probes: (1) plain srcdoc control, (2) a CLONE of the plugin's
      // own srcdoc. This separates "environment blocks srcdoc" from "the plugin
      // srcdoc content is what keeps the frame empty".
      const srcdocProbe = await evaluate(`(async () => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:0;bottom:0;width:420px;height:100px;opacity:0.01;pointer-events:none';
        document.body.appendChild(host);
        const make = (srcdoc) => {
          const frame = document.createElement('iframe');
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.setAttribute('srcdoc', srcdoc);
          frame.style.cssText = 'width:200px;height:100px';
          host.appendChild(frame);
          return frame;
        };
        const control = make('<!doctype html><html><body><h1 id="probe">probe</h1></body></html>');
        const pluginFrame = document.querySelector('.__dsh_web_inspect_frame');
        const pluginSrcdoc = pluginFrame === null ? '' : String(pluginFrame.getAttribute('srcdoc') ?? '');
        const clone = make(pluginSrcdoc);
        const meta = {
          pluginSrcdocLength: pluginSrcdoc.length,
          hasNull: /\u0000/u.test(pluginSrcdoc),
          controlChars: pluginSrcdoc.split('').filter((ch) => ch.charCodeAt(0) < 32 && ch !== '\n' && ch !== '\t' && ch !== '\r').length,
          hasLoneSurrogate: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(pluginSrcdoc),
          pluginFrameClientWidth: pluginFrame === null ? null : pluginFrame.clientWidth,
          pluginFrameIsConnected: pluginFrame === null ? null : pluginFrame.isConnected,
        };
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return {
          meta,
          controlRect: [Math.round(control.getBoundingClientRect().width), Math.round(control.getBoundingClientRect().height)],
          cloneRect: [Math.round(clone.getBoundingClientRect().width), Math.round(clone.getBoundingClientRect().height)],
          totalIframes: document.querySelectorAll('iframe').length,
        };
      })()`);
      await sleep(400);
      const probeContextDumps = await dumpTrackedContexts();
      facts.frameInFrameDiagnostics = { parentFrames, frames: await previewFrame().catch(() => null), childTrees, contextDumps, srcdocProbe, probeContextDumps };
      throw new StepFailure(`the iframe never showed a loaded srcdoc document with the injected runtime: ${JSON.stringify(facts.frameInFrameDiagnostics).slice(0, 3200)}`);
    }
    facts.frame = {
      ...frameEvidence,
      frameId: bridge.frame.id,
      frameUrl: bridge.frame.url,
      contextId: bridge.context.contextId,
      contextOrigin: bridge.context.origin,
      contextIsDefault: bridge.context.isDefault,
    };
    facts.frameInFrame = inFrame.value;
    const sandboxChecks = [
      ['sandbox attribute is exactly "allow-scripts"', frameEvidence.sandbox === 'allow-scripts'],
      ['sandbox does not contain allow-same-origin', !frameEvidence.sandboxTokenList.includes('allow-same-origin')],
      ['parent iframe.contentDocument is null', frameEvidence.sameOriginDocument === 'null'],
      ['parent iframe.contentWindow.document throws SecurityError', frameEvidence.contentWindowDocument === 'SecurityError'],
      ['iframe parent.document access throws SecurityError', inFrame.value.parentAccess === 'SecurityError'],
      ['iframe document carries the plugin runtime script', inFrame.value.runtimeScript === true],
      ['runtime script is the first inline script in the srcdoc document', inFrame.value.runtimeFirstScript === true],
    ];
    const sandboxFailed = sandboxChecks.filter(([, ok]) => !ok).map(([label]) => label);
    if (sandboxFailed.length > 0) {
      throw new StepFailure(`security model (opaque-origin iframe) is incomplete: ${sandboxFailed.join(', ')}
  evidence: ${JSON.stringify({ frame: facts.frame, inFrame: facts.frameInFrame }).slice(0, 1600)}`);
    }
    record('plugin-frame', 'PASS',
      `sandbox="${frameEvidence.sandbox}"; parent contentDocument=null; parent↔iframe cross-origin (SecurityError both ways); runtime script inside frame; context ${bridge.context.contextId} for frame ${bridge.frame.id}`);
    await screenshot('03-preview-plugin-frame');
    await screenshotFile(join(SECOND_SHOTS, '13-opaque-origin.png'));
  } else {
    facts.frame = { loaded: false };
  }

  // ---- 8. toggle 「检查元素」 (postMessage bridge, no parent DOM access) ----
  if (pluginLoaded === null) {
    record('inspect-toggle', 'SKIP', 'plugin not loaded — skipping inspect-mode checks');
    throw new PluginMissingError('plugin not loaded: cannot verify inspect mode. Install/activate dsh-web-inspect first (see docs/notes/install-verify.md), then re-run.');
  }
  const toggleFound = await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)}) !== null`)), { timeout: 8_000, label: `renderer toggle ${RENDERER_TOGGLE}` }).catch(() => null);
  if (toggleFound === null) {
    const diagnostics = await evaluate(`(() => {
      const panel = document.querySelector('[data-sidebar-right-panel]');
      return {
        tabs: Array.from(panel?.querySelectorAll('[data-dockkit-tab]') ?? []).map((tab) => tab.innerText.trim()),
        documentActions: Array.from(document.querySelectorAll('[data-slot="sidebar.right.tab.document.actions"] button, [data-slot*="tab.document"] button') ?? []).map((button) => button.innerText.trim()),
        toggleButtons: Array.from(panel?.querySelectorAll('button') ?? []).map((button) => (button.innerText || button.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 40),
      };
    })()`);
    facts.toggleDiagnostics = diagnostics;
    throw new StepFailure(
      `「检查元素」 button not found in the preview tab header — the extension-priority renderer did not install its document actions. diagnostics: ${JSON.stringify(diagnostics)}; console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
    );
  }
  const toggleLabel = await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.innerText?.trim() ?? ''`);
  if (toggleLabel !== '检查元素') throw new StepFailure(`toggle label is "${toggleLabel}", expected "检查元素" (zh locale)`);

  // Record the postMessage traffic in BOTH realms before toggling: the parent
  // must only talk to the opaque iframe through `postMessage`, never through
  // `contentDocument`.
  await evaluate(`(() => {
    window.__e2e_pm_out = [];
    if (window.__e2e_pm_parent_hook !== true) {
      window.__e2e_pm_parent_hook = true;
      window.addEventListener('message', (event) => {
        try {
          const data = event.data;
          if (data === null || typeof data !== 'object' || data.source !== 'dsh-web-inspect') return;
          window.__e2e_pm_out.push({ origin: event.origin, type: data.type, payload: data.payload ?? null });
        } catch { /* ignore */ }
      });
    }
    return true;
  })()`);
  await evalInPreview(`(() => {
    window.__e2e_pm_in = [];
    if (window.__e2e_pm_hook !== true) {
      window.__e2e_pm_hook = true;
      window.addEventListener('message', (event) => {
        try {
          const data = event.data;
          if (data === null || typeof data !== 'object' || data.source !== 'dsh-web-inspect') return;
          window.__e2e_pm_in.push({ type: data.type });
        } catch { /* ignore */ }
      });
    }
    return true;
  })()`);

  await clickSelector(RENDERER_TOGGLE);
  await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true'`)), { label: 'inspect toggle data-on=true' });
  let toggleEvalError = null;
  const probeOverlay = async () => {
    const state = await evalInPreview(`(() => ({
      overlayMounted: document.querySelector('.__dsh_web_inspect_hl') !== null,
      tooltipMounted: document.querySelector('.__dsh_web_inspect_tip') !== null,
      enabledFlag: window.__dsh_web_inspect_runtime__ === true,
      cursor: document.documentElement.style.cursor || '',
      runtimeGlobals: Object.keys(window).filter((key) => /element_inspect/i.test(key)),
    }))()`);
    return state.value;
  };
  let toggleState = null;
  const pollOverlay = (timeout, label) => waitUntil(async () => {
    try {
      const state = await probeOverlay();
      return state.overlayMounted && state.tooltipMounted ? state : null;
    } catch (error) {
      toggleEvalError = String(error?.message ?? error);
      return null;
    }
  }, { timeout, label: `iframe runtime enabled (${label})` }).catch(() => null);
  toggleState = await pollOverlay(2_500, 'overlay+tooltip poll');
  if (toggleState === null) {
    // The runtime may have missed the parent's enable (the parent-side "ready" handshake
    // can complete after the toggle click). Re-post the same documented enable message
    // once from the parent; the runtime handler is idempotent.
    const posted = await evaluate(`(() => {
      const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
      if (frame === null || frame.contentWindow === null) return false;
      frame.contentWindow.postMessage({ source: MESSAGE_SOURCE, type: 'enable' }, '*');
      return true;
    })()`.replace('MESSAGE_SOURCE', JSON.stringify('dsh-web-inspect')));
    const pmOutRaw = await evaluate(`(window.__e2e_pm_out ?? []).map((event) => ({ origin: event.origin, type: event.type }))`);
    let pmInRaw = null;
    let iframeStateNow = null;
    try {
      pmInRaw = (await evalInPreview(`(window.__e2e_pm_in ?? []).map((event) => event.type)`)).value;
      iframeStateNow = await evaluate(`(() => {
        const frame = document.querySelector(${JSON.stringify(INSPECT_FRAME)});
        if (frame === null) return { frame: null };
        const rect = frame.getBoundingClientRect();
        return {
          rect: [Math.round(rect.width), Math.round(rect.height)],
          sandbox: frame.getAttribute('sandbox'),
          srcdocLength: (frame.getAttribute('srcdoc') ?? '').length,
          toggleOn: frame.ownerDocument.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') ?? null,
        };
      })()`);
    } catch (error) {
      facts.toggleDiagnostics = { diagnosticEvalError: String(error?.message ?? error) };
    }
    facts.toggleDiagnostics = {
      ...(facts.toggleDiagnostics ?? {}),
      manualEnablePosted: posted,
      toggleEvalError,
      postMessageParentReceived: pmOutRaw,
      postMessageFrameReceived: pmInRaw,
      iframeStateNow,
    };
    toggleState = await pollOverlay(3_000, 'manual enable fallback');
  }
  if (toggleState === null) {
    throw new StepFailure(`inspect overlay never mounted in the opaque iframe runtime: ${JSON.stringify(facts.toggleDiagnostics ?? {}).slice(0, 1600)}`);
  }
  await waitUntil(async () => (await evaluate(`(window.__e2e_pm_out ?? []).some((event) => event.type === 'ready')`)), { timeout: 8_000, label: 'iframe -> parent "ready" postMessage' }).catch(() => {});
  const pmOut = await evaluate(`(window.__e2e_pm_out ?? []).map((event) => ({ origin: event.origin, type: event.type, payloadBytes: event.payload === null ? 0 : JSON.stringify(event.payload).length }))`);
  const pmIn = await evalInPreview(`(window.__e2e_pm_in ?? []).map((event) => event.type)`);
  await waitUntil(async () => (await evaluate(`document.querySelector('.__dsh_web_inspect_bar') !== null`)), { label: 'inspect status bar' });
  const barText = await evaluate(`document.querySelector('.__dsh_web_inspect_bar')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''`);
  facts.inspectBar = barText;
  facts.toggle = {
    label: toggleLabel,
    barText,
    iframeState: toggleState,
    postMessageParentReceived: pmOut,
    postMessageFrameReceived: pmIn,
  };
  if (!pmIn.value.includes('enable')) {
    throw new StepFailure(`the parent did not postMessage an "enable" command into the opaque iframe (frame received: ${JSON.stringify(pmIn.value)})`);
  }
  record('inspect-toggle', 'PASS', `"${toggleLabel}" -> on; bar: "${barText}"; postMessage: parent->frame [${pmIn.value.join(', ')}], frame->parent [${pmOut.map((event) => event.type).join(', ')}]`);
  await takeAssetShot('opaque-origin.png');
  await screenshot('04-inspect-on');

  // ---- 9. hover highlight + click select ------------------------------
  const geometry = await previewPoint(opts.target);
  facts.target = { selector: opts.target, ...geometry };
  await sleep(250);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x, y: geometry.y, button: 'none', buttons: 0 }, sessionId);
  const hoverState = await waitUntil(async () => {
    const state = await evalInPreview(HOVER_STATE_IN_FRAME);
    return state.value !== null && state.value.visible ? state : null;
  }, { timeout: 8_000, label: 'hover highlight inside the opaque iframe' });
  const hover = { ...hoverState.value, frameId: hoverState.frameId, contextId: hoverState.contextId };
  facts.hover = hover;
  if (!hover.visible || hover.width <= 0 || hover.height <= 0) throw new StepFailure(`hover highlight not painted (${JSON.stringify(hover)})`);
  record('hover-highlight', 'PASS', `${hover.width}×${hover.height} px outline inside the opaque iframe (context ${hover.contextId}), tooltip "${hover.tooltip ?? ''}"`);
  await takeAssetShot('hover-highlight.png');

  const transcriptBefore = await evaluate(TRANSCRIPT_EXPR);
  const conversationBeforeLen = transcriptBefore.transcriptLen;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);

  // The selection context now travels iframe -> parent over postMessage: the
  // select payload itself is the model-context proof at this stage.
  const selectMessage = await waitUntil(async () => {
    const events = await evaluate(`(window.__e2e_pm_out ?? []).filter((event) => event.type === 'select')`);
    return events.length > 0 ? events.at(-1) : null;
  }, { timeout: 8_000, label: 'iframe -> parent "select" postMessage' });
  const selectPayload = selectMessage.payload ?? {};
  const selectKeys = Object.keys(selectPayload);
  facts.selectMessage = {
    origin: selectMessage.origin,
    type: selectMessage.type,
    payloadBytes: JSON.stringify(selectPayload).length,
    keys: selectKeys,
    selector: selectPayload.selector ?? null,
    tag: selectPayload.tag ?? null,
    id: selectPayload.id ?? null,
    classes: selectPayload.classes ?? null,
    text: selectPayload.text ?? null,
    rect: selectPayload.rect ?? selectPayload.box ?? null,
    styles: selectPayload.styles ?? null,
    spacing: selectPayload.spacing ?? null,
    clues: selectPayload.clues ?? null,
    ancestors: selectPayload.ancestors ?? null,
    htmlLength: String(selectPayload.html ?? '').length,
    htmlHead: String(selectPayload.html ?? '').slice(0, 200),
  };
  const selectChecks = [
    ['postMessage origin is opaque ("null")', selectMessage.origin === 'null'],
    ['select payload carries the selector', String(selectPayload.selector ?? '').includes(opts.target)],
    ['select payload carries tag + rect size', selectPayload.tag === TARGET_TAG && Number(selectPayload.rect?.w ?? selectPayload.rect?.width ?? selectPayload.box?.w) > 0],
    ['select payload carries computed styles', selectPayload.styles !== null && selectPayload.styles !== undefined],
    ['select payload carries the html snippet', String(selectPayload.html ?? '').includes('<' + TARGET_TAG)],
  ];
  const selectFailed = selectChecks.filter(([, ok]) => !ok).map(([label]) => label);
  if (selectFailed.length > 0) {
    throw new StepFailure(`iframe -> parent select payload is incomplete: ${selectFailed.join(', ')}\n  facts.selectMessage: ${JSON.stringify(facts.selectMessage).slice(0, 1600)}`);
  }

  // ---- 10. chip insertion: one atomic reference chip, composer text clean ----
  const chipState1 = await waitUntil(async () => {
    const state = await evaluate(CHIP_STATE_EXPR);
    return state.chipCount >= 1 ? state : null;
  }, { timeout: 10_000, label: 'reference chip inserted into the composer' });
  const chip1 = chipState1.chips[0] ?? {};
  const refs1 = chipState1.draft?.draft?.references ?? [];
  const decoded1 = refs1.length === 1 ? decodeChipRef(refs1[0].ref) : null;
  facts.chip1 = {
    chipCount: chipState1.chipCount,
    chip: { title: chip1.title, text: chip1.text, cls: chip1.cls, hostOuterHTML: chip1.hostOuterHTML },
    editorText: chipState1.editorText,
    references: refs1.map((r) => ({ source: r.source, label: r.label, appearance: r.appearance, offset: r.offset, length: r.length, refPrefix: String(r.ref).slice(0, CHIP_REF_PREFIX.length), refLength: String(r.ref).length })),
    decoded: decoded1 === null ? null : { label: decoded1.l, markdown: decoded1.m },
  };
  const chip1Checks = [
    ['exactly one chip is rendered', chipState1.chipCount === 1],
    ['chip title is the element label', chip1.title === TARGET_LABEL],
    ['chip label length <= 24', (chip1.title ?? '').length <= 24],
    ['composer visible text carries no Markdown', !/```|Selected element|选中元素/u.test(chipState1.editorText ?? '')],
    ['persisted draft has exactly one inspect reference', refs1.length === 1 && /inspect/u.test(String(refs1[0].source ?? ''))],
    ['reference ref base64url-decodes to the full context', decoded1 !== null && String(decoded1.m).includes(TARGET_HEADING)],
    ['context Markdown starts with the English quote line', String(decoded1?.m ?? '').startsWith('> Selected element: ')],
    ['context Markdown carries the document source path', String(decoded1?.m ?? '').includes('- Source: ' + fixtureAbs)],
    ['context Markdown is free of the legacy Chinese labels', !/选中元素|元素无内容|- 样式：|- 线索：|- 定位祖先：/u.test(String(decoded1?.m ?? ''))],
  ];
  const chip1Failed = chip1Checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (chip1Failed.length > 0) {
    throw new StepFailure(`chip insertion is missing expected properties: ${chip1Failed.join(', ')}\n  state: ${JSON.stringify({ chip1: facts.chip1.chip, editorText: chipState1.editorText, refs: facts.chip1.references }).slice(0, 1200)}`);
  }
  record('click-select-insert', 'PASS', `1 chip "${chip1.title}" (${chip1.title.length} chars); composer text free of Markdown; ref ${String(refs1[0].ref).length} chars`);

  const barAfter = await evaluate(`document.querySelector('.__dsh_web_inspect_bar')?.innerText?.replace(/\\s+/g, ' ').trim() ?? ''`);
  if (!barAfter.includes(CHIP_INSERTED_ZH)) throw new StepFailure(`status bar did not confirm the chip insertion; got "${barAfter}"`);
  record('status-confirmed', 'PASS', `"${barAfter.slice(0, 90)}"`);

  // ---- 11. never auto-sends: the chip must stay a draft ---------------------
  await sleep(1_200);
  const transcriptAfter = await evaluate(TRANSCRIPT_EXPR);
  facts.noAutoSend = { transcriptLenBefore: conversationBeforeLen, transcriptLenAfter: transcriptAfter.transcriptLen, composerPresent: transcriptBefore.hasComposer };
  if (/选中元素|Selected element/u.test(transcriptAfter.transcriptText) || transcriptAfter.transcriptText.includes(chip1.title ?? '<h1#doc-title>')) {
    throw new StepFailure('the chip label / selection Markdown appears in the conversation transcript — the draft was sent automatically (must stay a draft)');
  }
  const stillDraft = await evaluate(CHIP_STATE_EXPR);
  if (stillDraft.chipCount !== 1 || (stillDraft.draft?.draft?.references ?? []).length !== 1) {
    throw new StepFailure('composer chip disappeared after insertion — looks like a submit happened');
  }
  record('no-auto-send', 'PASS', `no user echo in transcript, chip + reference still in composer (transcript text ${conversationBeforeLen}->${transcriptAfter.transcriptLen} chars)`);
  await screenshot('05-selected-draft');
  await takeAssetShot('composer-chip.png', { selector: '[data-composer-input] [title^="<"]', pad: 18, scale: 2 });

  // ---- 12. chip click opens the full-context popover -----------------------
  await evaluate(`(() => { document.querySelector('[data-composer-input] [title^="<"]')?.click(); return true; })()`);
  const popover = await waitUntil(async () => (await evaluate(`(() => {
    const root = document.querySelector('[data-dsh-web-inspect-popover]');
    if (root === null) return null;
    return {
      attr: root.getAttribute('data-dsh-web-inspect-popover'),
      head: (root.querySelector('.__dsh_web_inspect_pop_head')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      bodyText: (root.querySelector('.__dsh_web_inspect_pop_body')?.innerText ?? '').slice(0, 4000),
      closeBtn: root.querySelector('.__dsh_web_inspect_pop_close')?.innerText?.trim() ?? null,
      computed: (() => {
        const panel = root.querySelector('.__dsh_web_inspect_pop_panel');
        const body = root.querySelector('.__dsh_web_inspect_pop_body');
        const pick = (node) => node === null ? null : { color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor };
        const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return {
          panel: pick(panel),
          body: pick(body),
          vars: {
            bgElevated: cssVar('--dsw-alias-bg-elevated'),
            bgSunken: cssVar('--dsw-alias-bg-sunken'),
            labelPrimary: cssVar('--dsw-alias-label-primary'),
            borderL2: cssVar('--dsw-alias-border-l2'),
          },
          side: {
            bar: pick(document.querySelector('.__dsh_web_inspect_bar')),
            toggle: pick(document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})),
            chip: pick(document.querySelector('[data-composer-input] [title^="<"]')),
            chipLabel: pick(document.querySelector('[data-composer-input] [title^="<"] span')),
          },
          varScope: (() => {
            const chain = [];
            let node = document.body;
            let depth = 0;
            while (node !== null && depth < 8) {
              const value = getComputedStyle(node).getPropertyValue('--dsw-alias-label-primary').trim();
              chain.push({ tag: node.tagName, id: node.id, theme: node.getAttribute('data-theme'), hasVar: value !== '', color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor });
              node = node.parentElement;
              depth += 1;
            }
            return chain;
          })(),
          htmlAttributes: Array.from(document.documentElement.attributes).map((attribute) => attribute.name + '=' + attribute.value).slice(0, 10),
          bodyTokens: (() => {
            const bodyStyle = getComputedStyle(document.body);
            const defined = Array.from(bodyStyle).filter((name) => name.indexOf('--dsw') === 0);
            const candidates = {};
            ['--dsw-alias-bg-elevated', '--dsw-alias-bg-base', '--dsw-alias-bg-sunken', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-overlay', '--dsw-alias-bg-document-preview', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-primary-bluish', '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-button-primary-fill'].forEach((name) => {
              candidates[name] = bodyStyle.getPropertyValue(name).trim();
            });
            return {
              count: defined.length,
              sample: defined.filter((name) => /bg|label|border|surface/.test(name)).slice(0, 60),
              candidates,
            };
          })(),
        };
      })(),
      outerHTML: root.outerHTML.slice(0, 2500),
    };
  })()`)), { timeout: 5_000, label: 'inspect context popover' });
  facts.popover = popover;
  const popoverChecks = [
    ['popover carries data-dsh-web-inspect-popover', popover.attr !== null],
    ['popover header explains what the model receives', popover.head.includes('发送后模型会收到以下完整内容')],
    ['popover body has the selector line', popover.bodyText.includes(TARGET_HEADING)],
    ['popover body has the ```html fence', popover.bodyText.includes('```html')],
    ['popover body has the styles line', popover.bodyText.includes('- Styles: ')],
    ['popover has a 关闭 close control', popover.closeBtn === '关闭'],
  ];
  const popoverFailed = popoverChecks.filter(([, ok]) => !ok).map(([label]) => label);
  if (popoverFailed.length > 0) {
    throw new StepFailure(`context popover is missing expected content: ${popoverFailed.join(', ')}\n  popover: ${JSON.stringify(popover).slice(0, 1200)}`);
  }
  await screenshotFile(join(SECOND_SHOTS, '08-chip.png'));
  await takeAssetShot('chip-popover.png');
  // Quirk recorded: Escape typed while keyboard focus sits inside the preview
  // iframe is consumed by the inspector's own iframe-level listener (it exits
  // inspect mode) and never reaches the popover's parent-document listener.
  // Closing via the 关闭 button is the deterministic path.
  await closeInspectPopover();
  record('chip-popover', 'PASS', `popover "${popover.attr}": head + selector + fence + styles, closed via 关闭`);

  // ---- 13. Escape leaves inspect mode ------------------------------------
  // Current plugin build installs a parent-realm window
  // keydown handler for Escape as well as the in-frame runtime handler. The
  // primary path is therefore a REAL page-target key event (trusted input);
  // the iframe-target dispatch and an in-frame synthetic keydown remain as
  // documented fallbacks (see sandbox-verify.md quirks).
  const escapeEffectsGone = async (timeout) => waitUntil(async () => {
    const toggleOff = await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') !== 'true'`);
    if (!toggleOff) return null;
    try {
      const state = await evalInPreview(`(() => ({
        overlayMounted: document.querySelector('.__dsh_web_inspect_hl') !== null,
        tooltipMounted: document.querySelector('.__dsh_web_inspect_tip') !== null,
        enabledFlag: window.__dsh_web_inspect_runtime__ === true,
        cursor: document.documentElement.style.cursor || '',
      }))()`);
      // NOTE: `__dsh_web_inspect_runtime__` is an install guard that stays
      // true for the lifetime of the document; it does NOT mean "enabled".
      // Disabled state = overlay/tooltip detached + cursor restored.
      if (state.value.overlayMounted || state.value.tooltipMounted) return null;
      if (state.value.cursor === 'crosshair') return null;
      facts.escape = state.value;
      return true;
    } catch { return null; }
  }, { timeout, label: 'escape leaves inspect mode (parent + iframe state)' }).catch(() => null);

  const escapePath = [];
  const escapeExited = await (async () => {
    // 1) real page-target key event (parent-realm handler). Record what the page
    //    realm actually receives so a silent dispatch failure is visible.
    try {
      await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
      await evaluate(`(() => {
        document.body.click();
        const recorder = [];
        window.__e2e_esc_seen = recorder;
        window.addEventListener('keydown', (event) => recorder.push(event.key), true);
        window.focus?.();
        return true;
      })()`);
      const before = await evaluate(`({ on: document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on'), bars: document.querySelectorAll('.__dsh_web_inspect_bar').length })`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, sessionId);
      await sleep(150);
      const after = await evaluate(`({ on: document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on'), bars: document.querySelectorAll('.__dsh_web_inspect_bar').length, seen: (window.__e2e_esc_seen ?? []).slice(0, 5) })`);
      facts.escapePageDispatch = { before, after, path: 'page-target-rawKeyDown' };
      escapePath.push('page-target-rawKeyDown');
      if (after.on !== 'true') escapePath.push('page-realm-handled');
      if (await escapeEffectsGone(3_000)) return true;
    } catch (error) { escapePath.push(`page-target-error: ${String(error?.message ?? error)}`); }

    // 2) trusted key event through the iframe target session
    try {
      const escapeFrame = (await previewContext()).frame;
      if (escapeFrame.sessionId !== undefined) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, escapeFrame.sessionId);
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }, escapeFrame.sessionId);
        escapePath.push('iframe-target-keydown');
        if (await escapeEffectsGone(3_000)) return true;
      }
    } catch (error) { escapePath.push(`iframe-target-error: ${String(error?.message ?? error)}`); }

    // 3) synthetic keydown inside the opaque document (listener-level proof)
    try {
      await evalInPreview(`(() => {
        const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
        document.dispatchEvent(new KeyboardEvent('keydown', init));
        try { window.dispatchEvent(new KeyboardEvent('keydown', init)); } catch { /* ignore */ }
        return true;
      })()`);
      escapePath.push('synthetic-keydown-in-frame');
      if (await escapeEffectsGone(3_000)) return true;
    } catch (error) { escapePath.push(`synthetic-error: ${String(error?.message ?? error)}`); }
    return null;
  })();
  facts.escapeDispatch = escapePath.join(' -> ');
  if (escapeExited === null) {
    log(`  • escape-exit — SKIP (no dispatch path exited inspect mode: ${facts.escapeDispatch})`);
    steps.push({ name: 'escape-exit', status: 'SKIP', detail: `Escape did not exit inspect mode (${facts.escapeDispatch})`, at: new Date().toISOString() });
  } else {
    record('escape-exit', 'PASS', `Esc exited inspect mode via ${facts.escapeDispatch}: toggle data-on=false, overlay+tooltip removed, cursor restored ("${facts.escape?.cursor ?? ''}")`);
  }
  await screenshot('06-escape-exited');

  // ---- 14. second cycle: re-enable and select a DIFFERENT element ----------
  await clickSelector(RENDERER_TOGGLE);
  await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true'`)), { timeout: 8_000, label: 'inspect toggle re-enabled' });
  await waitUntil(async () => {
    const state = await evalInPreview(`(() => ({ overlayMounted: document.querySelector('.__dsh_web_inspect_hl') !== null, enabledFlag: window.__dsh_web_inspect_runtime__ === true }))()`);
    return state.value.overlayMounted || state.value.enabledFlag;
  }, { timeout: 8_000, label: 'iframe runtime re-enabled after reattach' });
  record('inspect-reattach', 'PASS', 'after Escape, 「检查元素」 re-enabled and the overlay mounted again');

  const secondGeometry = await previewPoint(opts.secondTarget);
  facts.secondTarget = { selector: opts.secondTarget, ...secondGeometry };
  await sleep(250);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondGeometry.x, y: secondGeometry.y, button: 'none', buttons: 0 }, sessionId);
  const secondHover = await waitUntil(async () => {
    const state = await evalInPreview(HOVER_STATE_IN_FRAME);
    return state.value !== null && state.value.visible ? state.value : null;
  }, { timeout: 8_000, label: 'second-cycle hover highlight' });
  if (!secondHover.visible || secondHover.width <= 0 || secondHover.height <= 0) throw new StepFailure(`second hover highlight not painted (${JSON.stringify(secondHover)})`);
  record('hover-second-element', 'PASS', `${secondHover.width}×${secondHover.height} px outline on ${opts.secondTarget}, tooltip "${secondHover.tooltip ?? ''}"`);
  await screenshot('07-second-hover');

  await mouseClickAt(secondGeometry.x, secondGeometry.y);
  const chipState2 = await waitUntil(async () => {
    const state = await evaluate(CHIP_STATE_EXPR);
    return state.chipCount >= 2 ? state : null;
  }, { timeout: 10_000, label: 'second reference chip appended to the composer' });
  const titles2 = chipState2.chips.map((chip) => chip.title ?? '');
  const refs2 = chipState2.draft?.draft?.references ?? [];
  facts.chip2 = { chipCount: chipState2.chipCount, titles: titles2, editorText: chipState2.editorText, references: refs2.map((r) => r.label) };
  const chip2Checks = [
    ['exactly two chips are rendered', chipState2.chipCount === 2],
    ['the two chips are distinct', titles2[0] !== titles2[1]],
    ['first chip preserved', titles2[0] === chip1.title],
    ['both labels stay <= 24 chars', titles2.every((title) => title.length <= 24)],
    ['composer text still carries no Markdown', !/```|Selected element|选中元素/u.test(chipState2.editorText ?? '')],
    ['persisted draft has two inspect references (append, not overwrite)', refs2.length === 2],
  ];
  const chip2Failed = chip2Checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (chip2Failed.length > 0) {
    throw new StepFailure(`second chip is missing expected properties: ${chip2Failed.join(', ')}\n  state: ${JSON.stringify(facts.chip2).slice(0, 900)}`);
  }
  await screenshotFile(join(SECOND_SHOTS, '09-two-chips.png'));
  record('second-selection-append', 'PASS', `two distinct chips "${titles2[0]}" + "${titles2[1]}", draft references 2 (append)`);

  // ---- 15. Backspace after the last chip removes it atomically -------------
  await evaluate(`(() => {
    const editor = document.querySelector('[data-composer-input]');
    editor.focus();
    const hosts = editor.querySelectorAll('[data-composer-chip]');
    const host = hosts[hosts.length - 1];
    const range = document.createRange();
    range.setStartAfter(host);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  await sleep(150);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, sessionId);
  const chipState3 = await waitUntil(async () => {
    const state = await evaluate(CHIP_STATE_EXPR);
    return state.chipCount === 1 ? state : null;
  }, { timeout: 8_000, label: 'Backspace removes the last chip (2 -> 1)' });
  const titles3 = chipState3.chips.map((chip) => chip.title ?? '');
  const refs3 = chipState3.draft?.draft?.references ?? [];
  facts.chip3 = { chipCount: chipState3.chipCount, titles: titles3, references: refs3.length };
  if (titles3[0] !== chip1.title || refs3.length !== 1) {
    throw new StepFailure(`Backspace did not delete the last chip atomically; remaining chips ${JSON.stringify(titles3)}, refs ${refs3.length}`);
  }
  record('chip-backspace', 'PASS', `Backspace removed the last chip atomically (2 -> 1), "${chip1.title}" intact`);

  // ---- 16. outgoing-content proof: intercept the send POST, never send ----
  const paused = [];
  let sendMode = 'abort';
  const onRequestPaused = (params) => {
    const request = params.request ?? {};
    if (request.method === 'POST' && /\/api\/session\/prompt$/u.test(request.url ?? '')) {
      paused.push({ url: request.url, method: request.method, postData: request.postData ?? '', mode: sendMode });
      if (sendMode === 'abort') {
        cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }, sessionId).catch(() => {});
      } else {
        cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
      }
      return;
    }
    cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
  };
  cdp.on('Fetch.requestPaused', onRequestPaused);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] }, sessionId);
  const sendClicked = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button[aria-label]'))
      .find((candidate) => /发送消息/u.test(candidate.getAttribute('aria-label') ?? '') && candidate.disabled !== true);
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  if (!sendClicked) throw new StepFailure('send button (aria 发送消息) not found or disabled — cannot intercept the outgoing request');
  const intercepted = await waitUntil(async () => (paused.length > 0 ? paused[0] : null), { timeout: 8_000, label: 'send request intercepted (POST /api/session/prompt)' });
  await cdp.send('Fetch.disable', {}, sessionId).catch(() => {});
  const promptPayload = JSON.parse(intercepted.postData);
  const outgoing = {
    rpcMethod: promptPayload?.method ?? null,
    requestId: promptPayload?.payload?.args?.request?.requestId ?? null,
    contentTypes: (promptPayload?.payload?.args?.request?.content ?? []).map((item) => item.type),
    outgoingText: (promptPayload?.payload?.args?.request?.content ?? []).map((item) => item.text ?? '').join('\n'),
    aborted: true,
  };
  facts.outgoing = outgoing;
  const outgoingChecks = [
    ['intercepted request is a POST to /api/session/prompt', intercepted.method === 'POST' && /\/api\/session\/prompt$/u.test(intercepted.url)],
    ['JSON-RPC method is session/prompt', outgoing.rpcMethod === 'session/prompt'],
    ['outgoing text content carries the selection heading', outgoing.outgoingText.includes(TARGET_HEADING)],
    ['outgoing text content carries the ```html fence', outgoing.outgoingText.includes('```html')],
    ['outgoing text content carries the styles line', outgoing.outgoingText.includes('- Styles: ')],
    ['outgoing text starts with the English quote line', outgoing.outgoingText.trimStart().startsWith('> Selected element: ')],
    ['outgoing text carries the document source path', outgoing.outgoingText.includes('- Source: ' + fixtureAbs)],
  ];
  const outgoingFailed = outgoingChecks.filter(([, ok]) => !ok).map(([label]) => label);
  if (outgoingFailed.length > 0) {
    throw new StepFailure(`outgoing-content proof failed: ${outgoingFailed.join(', ')}\n  payload: ${JSON.stringify(intercepted.postData.slice(0, 1200))}`);
  }
  record('outgoing-content', 'PASS', `aborted POST /api/session/prompt — prompt text carries selector + fence + styles (${outgoing.outgoingText.length} chars)`);

  // the aborted send may surface a transient failure toast; ensure no message
  // actually landed in the transcript and no page-level error was raised.
  await sleep(800);
  const transcriptFinal = await evaluate(TRANSCRIPT_EXPR);
  if (/选中元素|Selected element/u.test(transcriptFinal.transcriptText)) throw new StepFailure('a user message with the selection content appeared in the transcript after the (aborted) send');
  facts.console = {
    errors: consoleErrors.filter((entry) => entry.type === 'error' || entry.source === 'exception').map((entry) => entry.text),
    dshInspect: consoleErrors.filter((entry) => /\[dsh-(?:web-|element-)?inspect\]/u.test(entry.text)).map((entry) => entry.text),
  };
  await screenshotFile(join(SECOND_SHOTS, '10-send-aborted.png'));

  // ---- 17-21. task-6: real send + sent-bubble folding ------------------
  // Sends exactly ONE real model turn (chip message), then ONE plain-text
  // message in a fresh session. Prompt requests are intercepted with CDP Fetch
  // and CONTINUED (not aborted) so the bubble assertions run against real data.
  if (!opts.liveSend) {
    record('send-real', 'SKIP', '--no-live-send: real send and sent-bubble checks skipped');
    facts.liveSend = false;
    facts.console = {
      errors: consoleErrors.filter((entry) => entry.type === 'error' || entry.source === 'exception').map((entry) => entry.text),
      dshInspect: consoleErrors.filter((entry) => /\[dsh-(?:web-|element-)?inspect\]/u.test(entry.text)).map((entry) => entry.text),
    };
    await screenshotFile(join(SECOND_SHOTS, '10-send-aborted.png'));
    return;
  }

  facts.liveSend = true;
  sendMode = 'continue';
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] }, sessionId);

  const clickComposerSend = async () => {
    const clicked = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button[aria-label]'))
        .find((candidate) => /发送消息/u.test(candidate.getAttribute('aria-label') ?? '') && candidate.disabled !== true);
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new StepFailure('send button (aria 发送消息) not found or disabled');
  };
  const captureSend = async (label) => {
    // A running assistant turn turns the primary button into a stop control, so
    // wait for the composer send button to be available before clicking it.
    await waitUntil(async () => (await evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
      const send = buttons.find((candidate) => /发送消息/u.test(candidate.getAttribute('aria-label') ?? ''));
      if (send === undefined) return null;
      const disabled = send.disabled === true || send.getAttribute('aria-disabled') === 'true';
      const busy = buttons.some((candidate) => /停止|取消/u.test(candidate.getAttribute('aria-label') ?? ''));
      return disabled || busy ? null : { aria: send.getAttribute('aria-label') };
    })()`)), { timeout: 150_000, label: `${label}: composer send is available` });
    const before = paused.length;
    await clickComposerSend();
    return waitUntil(async () => (paused.length > before ? paused.at(-1) : null), { timeout: 25_000, label: `${label}: POST /api/session/prompt intercepted` });
  };
  const textOfSend = (request) => {
    try {
      const payload = JSON.parse(request.postData);
      return (payload?.payload?.args?.request?.content ?? []).map((item) => item.text ?? '').join('\n');
    } catch { return ''; }
  };

  // ---- 17. real send of the chip message: model-side sentinel proof ----
  const chipSend = await captureSend('chip send');
  const chipWire = textOfSend(chipSend);
  facts.sentWire = {
    url: chipSend.url,
    method: chipSend.method,
    mode: chipSend.mode,
    textLength: chipWire.length,
    text: chipWire,
    markers: {
      open: chipWire.includes('<!--dsh-web-inspect:v1-->'),
      close: chipWire.includes('<!--/dsh-web-inspect-->'),
      selector: chipWire.includes(TARGET_HEADING),
      fence: chipWire.includes('```html'),
      styles: chipWire.includes('- Styles: '),
      source: chipWire.includes('- Source: ' + fixtureAbs),
      // The human-readable quote line must come BEFORE the opening sentinel so
      // chat titles stay readable (new wire format, bundle 591d4138ed55).
      readableFirst: chipWire.indexOf(TARGET_HEADING) !== -1
        && chipWire.indexOf(TARGET_HEADING) < chipWire.indexOf('<!--dsh-web-inspect:v1-->'),
    },
  };
  const wireMissing = Object.entries(facts.sentWire.markers).filter(([, ok]) => !ok).map(([name]) => name);
  if (wireMissing.length > 0) {
    throw new StepFailure(`sentinel wire proof failed (missing: ${wireMissing.join(', ')}); postData head: ${chipSend.postData.slice(0, 1500)}`);
  }
  record('send-real', 'PASS', `real POST /api/session/prompt continued; ${chipWire.length}-char wire text carries sentinel open/close + selector + fence + styles`);

  // ---- 18. sent user bubble folds into ONE chip, no raw context --------
  const dumpPluginDebug = () => evaluate(`(() => {
    const debug = window.__DSH_INSPECT_DEBUG__;
    let copy = null;
    try { copy = debug === undefined ? null : JSON.parse(JSON.stringify(debug)); } catch (error) { copy = { unserializable: String(error) }; }
    const scroll = document.querySelector('[data-conversation-scroll]');
    const bubbles = scroll === null ? [] : Array.from(scroll.querySelectorAll('[data-message-bubble]'));
    const slots = scroll === null ? [] : Array.from(scroll.querySelectorAll('[data-slot="conversation.user.text.node"]'));
    return {
      debug: copy,
      chipCount: scroll === null ? 0 : scroll.querySelectorAll('[data-dsh-web-inspect-chip]').length,
      bubbleCount: bubbles.length,
      bubbleText: bubbles.length === 0 ? null : (bubbles[bubbles.length - 1].textContent || '').slice(0, 300),
      bubbleTextRaw: bubbles.length === 0 ? null : JSON.stringify((bubbles[bubbles.length - 1].textContent || '').slice(0, 300)),
      slots: slots.map((slot) => ({
        children: Array.from(slot.children).map((child) => String(child.className || '').slice(0, 120)),
        chip: slot.querySelector('[data-dsh-web-inspect-chip]') !== null,
        text: (slot.textContent || '').slice(0, 160),
      })).slice(-3),
    };
  })()`);
  facts.debugBefore = await dumpPluginDebug();
  let bubble;
  try {
    bubble = await waitUntil(async () => (await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return null;
    const chips = Array.from(scroll.querySelectorAll('[data-dsh-web-inspect-chip]'));
    if (chips.length === 0) return null;
    const chip = chips[0];
    const textOf = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
    const label = (chip.getAttribute('title') || chip.textContent || '').trim();
    let container = chip;
    let node = chip.parentElement;
    while (node !== null && node !== scroll) {
      if (textOf(node) === label) container = node;
      node = node.parentElement;
    }
    const fence = String.fromCharCode(96, 96, 96) + 'html';
    // Legacy dsh-inspect:* sentinels must ALSO stay out of the folded bubble:
    // old persisted messages are folded by the same rule and we keep the compat.
    const forbidden = [fence, '- Styles: ', '> Selected element', '<!--dsh-web-inspect:v1-->', '<!--/dsh-web-inspect-->', '<!--dsh-inspect:v1-->', '<!--/dsh-inspect-->'];
    const containerText = textOf(container);
    return {
      chipCount: chips.length,
      chipTitle: chip.getAttribute('title'),
      chipText: textOf(chip),
      chipOuterHTML: chip.outerHTML.slice(0, 1200),
      containerTag: container.tagName,
      containerClass: String(container.className || ''),
      containerText,
      containerOuterHTML: container.outerHTML.slice(0, 2000),
      leaked: forbidden.filter((needle) => containerText.includes(needle)),
    };
  })()`)), { timeout: 25_000, label: 'sent user bubble with folded chip' });
  } catch (error) {
    facts.debugAfter = await dumpPluginDebug();
    await screenshotFile(join(SECOND_SHOTS, '09-sent-bubble-failure.png'));
    throw new StepFailure(`sent-bubble folding failed: ${error instanceof Error ? error.message : String(error)}\n  debug: ${JSON.stringify(facts.debugAfter).slice(0, 2600)}`);
  }
  facts.bubble = bubble;
  const bubbleChecks = [
    ['exactly one sent-bubble chip', bubble.chipCount === 1],
    ['chip title/text is the element label', bubble.chipTitle === TARGET_LABEL && bubble.chipText === TARGET_LABEL],
    ['bubble container renders only the folded label', bubble.containerText === TARGET_LABEL],
    ['bubble text leaks no Markdown/sentinel', bubble.leaked.length === 0],
  ];
  const bubbleFailed = bubbleChecks.filter(([, ok]) => !ok).map(([name]) => name);
  if (bubbleFailed.length > 0) throw new StepFailure(`sent-bubble folding failed: ${bubbleFailed.join(', ')}\n  bubble: ${JSON.stringify(bubble).slice(0, 2200)}`);
  await dismissErrorToasts();
  await screenshotFile(join(SECOND_SHOTS, '09-sent-bubble.png'));
  record('sent-bubble', 'PASS', `1 chip "${bubble.chipTitle}" in ${bubble.containerTag}.${String(bubble.containerClass).split(' ')[0] || '(no class)'}; bubble text carries no Markdown/sentinel`);
  // Hero: leave inspect mode right before the shot so the hover tooltip and
  // outline vanish (they show the *second* element while the bubble shows the
  // first), and hide the plugin status bar; the folded bubble is the story.
  const heroToggle = await evaluate(`(() => {
    const button = document.querySelector('.__dsh_web_inspect_toggle');
    if (button === null) return 'missing';
    if (button.getAttribute('data-on') === 'true') { button.click(); return 'disabled'; }
    return 'already-off';
  })()`);
  await sleep(300);
  log(`hero shot prep: inspector ${heroToggle}`);
  await takeAssetShot('hero-sent-bubble.png', { hideSelectors: ['.__dsh_web_inspect_bar'] });
  await takeAssetShot('bubble-fold.png', { selector: '[data-conversation-scroll]', pad: 12, cropHeight: 240 });

  // ---- 19. bubble chip opens the full-context popover ------------------
  await evaluate(`(() => {
    const chip = document.querySelector('[data-conversation-scroll] [data-dsh-web-inspect-chip]');
    if (chip === null) return false;
    chip.click();
    return true;
  })()`);
  const bubblePopover = await waitUntil(async () => (await evaluate(`(() => {
    const root = document.querySelector('[data-dsh-web-inspect-popover]');
    if (root === null) return null;
    const body = root.querySelector('.__dsh_web_inspect_pop_body');
    return {
      attr: root.getAttribute('data-dsh-web-inspect-popover'),
      text: body === null ? '' : (body.textContent || ''),
      close: root.querySelector('.__dsh_web_inspect_pop_close')?.innerText?.trim() ?? null,
    };
  })()`)), { timeout: 8_000, label: 'bubble chip popover' });
  const bubbleFence = String.fromCharCode(96, 96, 96) + 'html';
  facts.bubblePopover = { attr: bubblePopover.attr, close: bubblePopover.close, textLength: bubblePopover.text.length, text: bubblePopover.text.slice(0, 4000) };
  const popoverChecks2 = [
    ['popover targets the folded chip label', bubblePopover.attr === TARGET_LABEL],
    ['popover body has the selector line', bubblePopover.text.includes(TARGET_HEADING)],
    ['popover body has the html fence', bubblePopover.text.includes(bubbleFence)],
    ['popover body has the styles line', bubblePopover.text.includes('- Styles: ')],
    ['popover body has the positioned ancestor line', bubblePopover.text.includes('- Positioned ancestor: ')],
    ['popover has a 关闭 control', bubblePopover.close === '关闭'],
  ];
  const popoverFailed2 = popoverChecks2.filter(([, ok]) => !ok).map(([name]) => name);
  if (popoverFailed2.length > 0) throw new StepFailure(`bubble popover is missing expected content: ${popoverFailed2.join(', ')}\n  popover: ${JSON.stringify(bubblePopover).slice(0, 1500)}`);
  await screenshotFile(join(SECOND_SHOTS, '10-bubble-expanded.png'));
  await closeInspectPopover();
  record('bubble-popover', 'PASS', `bubble chip popover "${bubblePopover.attr}" has selector + fence + styles + positioned ancestor (${bubblePopover.text.length} chars), closed via 关闭`);

  // ---- 20. session title stays readable (no raw sentinel) --------------
  await dismissErrorToasts();
  const titleFacts = await waitUntil(async () => (await evaluate(`(() => {
    // Scope to the conversation header bar (right of the left sidebar, top 90px):
    // older sessions created by earlier experiments may still carry raw-sentinel
    // titles in the session list, but the CURRENT conversation title must be clean.
    const leaves = [];
    for (const node of document.querySelectorAll('body *')) {
      if (node.children.length > 0) continue;
      const text = (node.textContent ?? '').trim();
      if (text.length === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top > 90 || rect.left < 280) continue;
      leaves.push({ text: text.slice(0, 160), tag: node.tagName, cls: String(node.className).slice(0, 60) });
    }
    const headerText = leaves.map((entry) => entry.text).join(String.fromCharCode(10));
    return {
      leaked: headerText.includes('<!--dsh-web-inspect') || headerText.includes('dsh-web-inspect:v1'),
      headerText: headerText.slice(0, 400),
      candidates: leaves.slice(0, 12),
    };
  })()`)), { timeout: 25_000, label: 'conversation title after send' });
  facts.title = titleFacts;
  const readableTitle = titleFacts.candidates.filter((entry) => entry.text.includes('Selected element'));
  if (titleFacts.leaked) throw new StepFailure(`raw sentinel leaked into readable UI text: ${JSON.stringify(titleFacts.candidates).slice(0, 900)}`);
  if (readableTitle.length === 0) throw new StepFailure(`conversation title does not show the readable "> Selected element: " prefix; candidates: ${JSON.stringify(titleFacts.candidates).slice(0, 900)}`);
  record('session-title-readable', 'PASS', `session title reads "${readableTitle[0].text.slice(0, 90)}" (no raw sentinel in the UI)`);

  // ---- 21. plain-text regression in the SAME composer ------------------
  await waitUntil(async () => (await evaluate(COMPOSER_DRAFT_EXPR)).text.trim() === '', { timeout: 15_000, label: 'composer cleared after the chip send' });
  const PLAIN_TEXT = 'plain text check';
  await clickSelector('[data-composer-input]');
  await cdp.send('Input.insertText', { text: PLAIN_TEXT }, sessionId);
  let plainDraft = await waitUntil(async () => {
    const state = await evaluate(COMPOSER_DRAFT_EXPR);
    return state.text.includes(PLAIN_TEXT) ? state : null;
  }, { timeout: 8_000, label: 'composer holds plain text' }).catch(() => null);
  if (plainDraft === null) {
    await evaluate(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(PLAIN_TEXT)});
      return true;
    })()`);
    plainDraft = await waitUntil(async () => {
      const state = await evaluate(COMPOSER_DRAFT_EXPR);
      return state.text.includes(PLAIN_TEXT) ? state : null;
    }, { timeout: 8_000, label: 'composer holds plain text (execCommand fallback)' });
  }
  const plainSend = await captureSend('plain-text send');
  const plainWire = textOfSend(plainSend);
  facts.plainSend = { url: plainSend.url, text: plainWire, hasChipSentinel: plainWire.includes('<!--dsh-web-inspect:v1-->') };
  if (!plainWire.includes(PLAIN_TEXT) || plainWire.includes('<!--dsh-web-inspect:v1-->')) {
    throw new StepFailure(`plain-text send payload unexpected: ${JSON.stringify(plainWire).slice(0, 600)}`);
  }
  record('plain-send', 'PASS', `plain message "plain text check" sent (${plainWire.length}-char wire text, no chip sentinel)`);

  const plainBubble = await waitUntil(async () => (await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return null;
    const want = ${JSON.stringify(PLAIN_TEXT)};
    const leaves = Array.from(scroll.querySelectorAll('*'))
      .filter((node) => node.children.length === 0 && (node.textContent || '').trim() === want);
    if (leaves.length === 0) return null;
    const textOf = (node) => (node.textContent || '').replace(/\\s+/g, ' ').trim();
    const leaf = leaves[leaves.length - 1];
    let container = leaf;
    let node = leaf.parentElement;
    while (node !== null && node !== scroll) {
      if (textOf(node) === want) container = node;
      node = node.parentElement;
    }
    return {
      chipCount: scroll.querySelectorAll('[data-dsh-web-inspect-chip]').length,
      bubbleHasChip: container.querySelector('[data-dsh-web-inspect-chip]') !== null,
      bubbleText: textOf(container),
      containerTag: container.tagName,
      containerClass: String(container.className || ''),
      outerHTML: container.outerHTML.slice(0, 1500),
    };
  })()`)), { timeout: 25_000, label: 'plain-text user bubble' });
  facts.plainBubble = plainBubble;
  if (plainBubble.bubbleHasChip || plainBubble.bubbleText !== PLAIN_TEXT || plainBubble.chipCount !== 1) {
    throw new StepFailure(`plain-text bubble regression: ${JSON.stringify(plainBubble).slice(0, 1500)}`);
  }
  await dismissErrorToasts();
  await screenshotFile(join(SECOND_SHOTS, '11-plain-bubble.png'));
  record('plain-bubble', 'PASS', `plain bubble in ${plainBubble.containerTag}.${String(plainBubble.containerClass).split(' ')[0] || '(no class)'} renders "plain text check" with no chip (session keeps its single folded chip bubble)`);

  // ---- 22. official quote regression (message-quotes quoteRule) -------
  await waitUntil(async () => (await evaluate(COMPOSER_DRAFT_EXPR)).text.trim() === '', { timeout: 15_000, label: 'composer cleared after the plain send' });
  const QUOTE_TEXT = '> 引用回归测试';
  await clickSelector('[data-composer-input]');
  await cdp.send('Input.insertText', { text: QUOTE_TEXT }, sessionId);
  let quoteDraft = await waitUntil(async () => {
    const state = await evaluate(COMPOSER_DRAFT_EXPR);
    return state.text.includes('引用回归测试') ? state : null;
  }, { timeout: 8_000, label: 'composer holds official quote text' }).catch(() => null);
  if (quoteDraft === null) {
    await evaluate(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(QUOTE_TEXT)});
      return true;
    })()`);
    quoteDraft = await waitUntil(async () => {
      const state = await evaluate(COMPOSER_DRAFT_EXPR);
      return state.text.includes('引用回归测试') ? state : null;
    }, { timeout: 8_000, label: 'composer holds official quote text (execCommand fallback)' });
  }
  const quoteSend = await captureSend('official-quote send');
  const quoteWire = textOfSend(quoteSend);
  facts.quoteSend = { url: quoteSend.url, text: quoteWire };
  if (!quoteWire.includes('引用回归测试') || quoteWire.includes('<!--dsh-web-inspect:v1-->')) {
    throw new StepFailure(`official-quote send payload unexpected: ${JSON.stringify(quoteWire).slice(0, 600)}`);
  }
  const quoteBubble = await waitUntil(async () => (await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return null;
    const previews = Array.from(scroll.querySelectorAll('[data-quote-preview]'));
    const preview = previews.filter((node) => (node.textContent || '').includes('引用回归测试')).pop();
    if (preview === undefined) return null;
    let container = preview;
    let node = preview.parentElement;
    while (node !== null && node !== scroll) {
      if (node.getAttribute('data-message-bubble') !== null) { container = node; break; }
      node = node.parentElement;
    }
    return {
      previewText: (preview.textContent || '').trim(),
      bubbleHasChip: container.querySelector('[data-dsh-web-inspect-chip]') !== null,
      chipCount: scroll.querySelectorAll('[data-dsh-web-inspect-chip]').length,
      bubbleText: (container.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      previewCount: previews.length,
    };
  })()`)), { timeout: 25_000, label: 'official quote bubble' });
  facts.quoteBubble = quoteBubble;
  const quoteChecks = [
    ['official quote still renders a quote preview', quoteBubble.previewText.includes('引用回归测试')],
    ['official quote bubble is not folded into our chip', quoteBubble.bubbleHasChip === false],
    ['our folded chip count stays 1', quoteBubble.chipCount === 1],
  ];
  const quoteFailed = quoteChecks.filter(([, ok]) => !ok).map(([name]) => name);
  await dismissErrorToasts();
  await screenshotFile(join(SECOND_SHOTS, '12-quote-regression.png'));
  if (quoteFailed.length > 0) throw new StepFailure(`official quote regression: ${quoteFailed.join(', ')}\n  bubble: ${JSON.stringify(quoteBubble).slice(0, 1200)}`);
  record('quote-regression', 'PASS', `official "> 引用回归测试" still renders a quote preview (${quoteBubble.previewCount} previews), no chip fold, our chip count stays 1`);

  // ---- 22b. legacy sentinel compatibility: pre-rename messages still fold ----
  await waitUntil(async () => (await evaluate(COMPOSER_DRAFT_EXPR)).text.trim() === '', { timeout: 15_000, label: 'composer cleared after the quote send' });
  const LEGACY_MARKDOWN = '> 选中元素：#doc-title（h1#doc-title，599×33）\n\n```html\n<h1 id="doc-title">dsh-web-inspect 演示页面</h1>\n```\n\n- 样式：color: rgb(248, 250, 252); font-size: 22px\n\n（在这里补充你要对这块 HTML 做的修改）';
  const LEGACY_WIRE = '<!--dsh-inspect:v1-->\n\n' + LEGACY_MARKDOWN + '\n<!--/dsh-inspect-->';
  await clickSelector('[data-composer-input]');
  await cdp.send('Input.insertText', { text: LEGACY_WIRE }, sessionId);
  let legacyDraft = await waitUntil(async () => {
    const state = await evaluate(COMPOSER_DRAFT_EXPR);
    return state.text.includes('dsh-inspect:v1') ? state : null;
  }, { timeout: 8_000, label: 'composer holds legacy wire text' }).catch(() => null);
  if (legacyDraft === null) {
    await evaluate(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(LEGACY_WIRE)});
      return true;
    })()`);
    legacyDraft = await waitUntil(async () => {
      const state = await evaluate(COMPOSER_DRAFT_EXPR);
      return state.text.includes('dsh-inspect:v1') ? state : null;
    }, { timeout: 8_000, label: 'composer holds legacy wire text (execCommand fallback)' });
  }
  const legacySend = await captureSend('legacy-sentinel send');
  const legacyWire = textOfSend(legacySend);
  facts.legacySend = { url: legacySend.url, text: legacyWire, hasLegacySentinel: legacyWire.includes('<!--dsh-inspect:v1-->'), hasLegacyClose: legacyWire.includes('<!--/dsh-inspect-->') };
  if (!legacyWire.includes('<!--dsh-inspect:v1-->') || !legacyWire.includes('<!--/dsh-inspect-->')) {
    throw new StepFailure(`legacy-sentinel send payload unexpected: ${JSON.stringify(legacyWire).slice(0, 600)}`);
  }
  const legacyBubble = await waitUntil(async () => (await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return null;
    const chips = Array.from(scroll.querySelectorAll('[data-dsh-web-inspect-chip]'));
    if (chips.length < 2) return null;
    const scrollText = (scroll.textContent || '');
    return {
      chipCount: chips.length,
      chipTitles: chips.map((chip) => chip.getAttribute('title') || '').slice(0, 6),
      leakedLegacySentinel: scrollText.includes('<!--dsh-inspect:v1-->') || scrollText.includes('<!--/dsh-inspect-->'),
      leakedNewSentinel: scrollText.includes('<!--dsh-web-inspect:v1-->') || scrollText.includes('<!--/dsh-web-inspect-->'),
      leakedFence: scrollText.includes(String.fromCharCode(96, 96, 96) + 'html'),
      leakedStyles: scrollText.includes('- 样式：'),
      textSample: scrollText.replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`)), { timeout: 30_000, label: 'legacy sentinel message folded into a chip bubble' });
  facts.legacyBubble = legacyBubble;
  const legacyChecks = [
    ['legacy sentinel message folds into a chip (2 chips in transcript)', legacyBubble.chipCount === 2],
    ['legacy raw sentinel is not rendered in the transcript', legacyBubble.leakedLegacySentinel === false],
    ['new raw sentinel is not rendered in the transcript', legacyBubble.leakedNewSentinel === false],
    ['markdown fence is not rendered in the transcript', legacyBubble.leakedFence === false],
    ['style line is not rendered in the transcript', legacyBubble.leakedStyles === false],
  ];
  const legacyFailed = legacyChecks.filter(([, ok]) => !ok).map(([name]) => name);
  await dismissErrorToasts();
  await screenshotFile(join(SECOND_SHOTS, '14-bubble-fold.png'));
  if (legacyFailed.length > 0) throw new StepFailure(`legacy sentinel fold: ${legacyFailed.join(', ')}\n  bubble: ${JSON.stringify(legacyBubble).slice(0, 1400)}`);
  record('legacy-sentinel-fold', 'PASS', `pre-rename "<!--dsh-inspect:v1-->" message still folds to a chip (${legacyBubble.chipCount} chips in transcript, no raw sentinel/fence/style leak)`);

  // ---- 22c. intermediate-name (element) sentinel compatibility -------------
  await waitUntil(async () => (await evaluate(COMPOSER_DRAFT_EXPR)).text.trim() === '', { timeout: 15_000, label: 'composer cleared after the first legacy send' });
  const LEGACY_ELEMENT_WIRE = '<!--dsh-element-inspect:v1-->\n\n' + LEGACY_MARKDOWN + '\n<!--/dsh-element-inspect-->';
  await clickSelector('[data-composer-input]');
  await cdp.send('Input.insertText', { text: LEGACY_ELEMENT_WIRE }, sessionId);
  const elementDraft = await waitUntil(async () => {
    const state = await evaluate(COMPOSER_DRAFT_EXPR);
    return state.text.includes('dsh-element-inspect:v1') ? state : null;
  }, { timeout: 8_000, label: 'composer holds the element-era wire text' }).catch(() => null);
  if (elementDraft === null) {
    await evaluate(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(LEGACY_ELEMENT_WIRE)});
      return true;
    })()`);
  }
  const elementSend = await captureSend('element-era legacy send');
  facts.legacyElementSend = { url: elementSend.url, text: textOfSend(elementSend).slice(0, 600) };
  const elementBubble = await waitUntil(async () => (await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return null;
    const chips = Array.from(scroll.querySelectorAll('[data-dsh-web-inspect-chip]'));
    if (chips.length < 3) return null;
    const scrollText = (scroll.textContent || '');
    return {
      chipCount: chips.length,
      chipTitles: chips.map((chip) => chip.getAttribute('title') || '').slice(0, 8),
      leakedElementSentinel: scrollText.includes('<!--dsh-element-inspect:v1-->') || scrollText.includes('<!--/dsh-element-inspect-->'),
      leakedFence: scrollText.includes(String.fromCharCode(96, 96, 96) + 'html'),
      leakedStyles: scrollText.includes('- 样式：'),
      textSample: scrollText.replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`)), { timeout: 30_000, label: 'element-era sentinel message folded into a chip bubble' });
  facts.legacyElementBubble = elementBubble;
  const elementChecks = [
    ['element-era sentinel message folds into a chip (3 chips in transcript)', elementBubble.chipCount === 3],
    ['element-era raw sentinel is not rendered in the transcript', elementBubble.leakedElementSentinel === false],
    ['markdown fence is not rendered in the transcript', elementBubble.leakedFence === false],
    ['style line is not rendered in the transcript', elementBubble.leakedStyles === false],
  ];
  const elementFailed = elementChecks.filter(([, ok]) => !ok).map(([name]) => name);
  await dismissErrorToasts();
  if (elementFailed.length > 0) throw new StepFailure(`element-era legacy sentinel fold: ${elementFailed.join(', ')}\n  bubble: ${JSON.stringify(elementBubble).slice(0, 1400)}`);
  record('legacy-element-sentinel-fold', 'PASS', `intermediate-name "<!--dsh-element-inspect:v1-->" message still folds to a chip (${elementBubble.chipCount} chips in transcript, no raw sentinel/fence/style leak)`);

  // ---- 22d. plain legacy (pre-sentinel) Chinese context still folds ------
  // Messages sent before the sentinel release carry no `<!--…-->` boundaries:
  // the first line + the closing Chinese hint line are all the rule has, so this
  // case guards the plain-text path (CONTEXT_START + footer detection).
  await waitUntil(async () => (await evaluate(COMPOSER_DRAFT_EXPR)).text.trim() === '', { timeout: 15_000, label: 'composer cleared after the element-era send' });
  const PLAIN_LEGACY = '> 选中元素：#doc-title（h1#doc-title，599×33）\n\n```html\n<h1 id="doc-title">dsh-web-inspect 演示页面</h1>\n```\n\n- 文本：「dsh-web-inspect 演示页面」\n- 样式：color: rgb(248, 250, 252); font-size: 22px\n\n（在这里补充你要对这块 HTML 做的修改）';
  await clickSelector('[data-composer-input]');
  await cdp.send('Input.insertText', { text: PLAIN_LEGACY }, sessionId);
  const plainLegacyDraft = await waitUntil(async () => {
    const state = await evaluate(COMPOSER_DRAFT_EXPR);
    return state.text.includes('选中元素') ? state : null;
  }, { timeout: 8_000, label: 'composer holds the plain legacy Chinese context' }).catch(() => null);
  if (plainLegacyDraft === null) {
    await evaluate(`(() => {
      const editor = document.querySelector('[data-composer-input]');
      editor.focus();
      document.execCommand('insertText', false, ${JSON.stringify(PLAIN_LEGACY)});
      return true;
    })()`);
  }
  const plainLegacySend = await captureSend('plain legacy send');
  facts.plainLegacySend = { url: plainLegacySend.url, text: textOfSend(plainLegacySend).slice(0, 600) };
  const plainLegacyBubble = await waitUntil(async () => (await evaluate(`(() => {
    const scroll = document.querySelector('[data-conversation-scroll]');
    if (scroll === null) return null;
    const chips = Array.from(scroll.querySelectorAll('[data-dsh-web-inspect-chip]'));
    if (chips.length < 4) return null;
    const scrollText = (scroll.textContent || '');
    return {
      chipCount: chips.length,
      chipTitles: chips.map((chip) => chip.getAttribute('title') || '').slice(0, 8),
      leakedHeading: scrollText.includes('选中元素：'),
      leakedFence: scrollText.includes(String.fromCharCode(96, 96, 96) + 'html'),
      leakedStyles: scrollText.includes('- 样式：'),
      leakedFooter: scrollText.includes('（在这里补充你要对这块 HTML 做的修改）'),
      textSample: scrollText.replace(/\\s+/g, ' ').slice(0, 300),
    };
  })()`)), { timeout: 30_000, label: 'plain legacy Chinese context folded into a chip bubble' });
  facts.plainLegacyBubble = plainLegacyBubble;
  const plainLegacyChecks = [
    ['plain legacy context folds into a chip (4 chips in transcript)', plainLegacyBubble.chipCount === 4],
    ['legacy Chinese heading is not rendered in the transcript', plainLegacyBubble.leakedHeading === false],
    ['markdown fence is not rendered in the transcript', plainLegacyBubble.leakedFence === false],
    ['style line is not rendered in the transcript', plainLegacyBubble.leakedStyles === false],
    ['legacy footer line is not rendered in the transcript', plainLegacyBubble.leakedFooter === false],
  ];
  const plainLegacyFailed = plainLegacyChecks.filter(([, ok]) => !ok).map(([name]) => name);
  await dismissErrorToasts();
  if (plainLegacyFailed.length > 0) throw new StepFailure(`plain legacy fold: ${plainLegacyFailed.join(', ')}\n  bubble: ${JSON.stringify(plainLegacyBubble).slice(0, 1400)}`);
  record('legacy-plain-fold', 'PASS', `sentinel-free "> 选中元素：" message still folds to a chip (${plainLegacyBubble.chipCount} chips in transcript)`);

  // ---- 23. console regression -----------------------------------------
  facts.console = {
    errors: consoleErrors.filter((entry) => entry.type === 'error' || entry.source === 'exception').map((entry) => entry.text),
    dshInspect: consoleErrors.filter((entry) => /\[dsh-(?:web-|element-)?inspect\]/u.test(entry.text)).map((entry) => entry.text),
  };
  const consoleClean = facts.console.errors.length === 0 && facts.console.dshInspect.length === 0;
  record('console-clean', consoleClean ? 'PASS' : 'FAIL', consoleClean
    ? 'no console.error / no [dsh-web-inspect] warning during the live send scenario'
    : `console errors: ${JSON.stringify(facts.console).slice(0, 800)}`);
  if (!consoleClean) throw new StepFailure(`console regression: ${JSON.stringify(facts.console).slice(0, 1200)}`);
}

async function finalize(status, error = null) {
  const report = {
    ok: status === 'PASS',
    status,
    error: error === null ? null : String(error.message ?? error),
    command: `node tools/e2e.mjs${opts.headed ? ' --headed' : ''}`,
    gui: opts.gui,
    fixture: opts.fixture,
    target: opts.target,
    workspace: opts.workspace,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    steps,
    facts,
    consoleErrors,
    screenshots: shotPaths,
  };
  try {
    mkdirSync(opts.shots, { recursive: true });
    writeFileSync(join(opts.shots, 'e2e-report.json'), JSON.stringify(report, null, 2));
  } catch (writeError) {
    log(`  ! could not write report: ${writeError.message}`);
  }
  log('');
  const errorCount = consoleErrors.filter((entry) => entry.type === 'error' || entry.source === 'exception').length;
  if (status === 'PASS') {
    log(`RESULT: PASS  (${steps.filter((step) => step.status === 'PASS').length} checks, ${report.durationMs} ms)`);
    log(`  console: ${errorCount === 0 ? 'no errors' : `${errorCount} error(s) — see report`}`);
    log(`report: ${join(opts.shots, 'e2e-report.json')}`);
  } else {
    log(`RESULT: ${status}`);
    log(`  ${String(error?.message ?? error)}`);
    if (status === 'PLUGIN_MISSING') {
      log('');
      log('  Plugin not loaded. Install/activate it first:');
      log('    1. ~/.dsh/profiles/web/package.json → dependencies["dsh-web-inspect"] = "link:' + REPO_ROOT + '"');
      log('    2. ~/.dsh/profiles/web/package.json → dsh.profile.bundles += "dsh-web-inspect"');
      log('    3. cd ~/.dsh/profiles/web && pnpm install');
      log('    4. touch/append a comment line in ~/.dsh/profiles/web/cordis.patch.yml to force a profile recompose');
      log('    5. re-run: node tools/e2e.mjs      (no dsh web restart needed)');
      log('  Details: docs/notes/install-verify.md');
    }
    if (consoleErrors.length > 0) {
      log(`  console errors/warnings (${consoleErrors.length}):`);
      for (const entry of consoleErrors.slice(0, 6)) log(`    [${entry.source}] ${entry.text}`);
    }
    if (shotPaths.length > 0) log(`  screenshots: ${shotPaths.join(', ')}`);
  }
  return report;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

try {
  await main();
  await finalize('PASS');
  cleanup();
  process.exit(0);
} catch (error) {
  let status = 'FAIL';
  if (error instanceof PluginMissingError) status = 'PLUGIN_MISSING';
  try { await screenshot('99-failure'); } catch { /* screenshot is best-effort */ }
  await finalize(status, error);
  cleanup();
  process.exit(error instanceof PluginMissingError ? 2 : 1);
}

function cleanup() {
  if (opts.keepOpen || opts.remotePort !== null) {
    if (chromeProc !== undefined) log(`  · Chrome left running on 127.0.0.1:${browserPort} (--keep-open)`);
    return;
  }
  try { cdp?.close(); } catch { /* noop */ }
  try { chromeProc?.kill('SIGKILL'); } catch { /* noop */ }
  if (chromeDir !== undefined && !opts.keepProfile) {
    try { rmSync(chromeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
