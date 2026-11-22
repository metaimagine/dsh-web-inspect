#!/usr/bin/env node
/**
 * tools/screencast.mjs — render the README hero loop (assets/demo.gif + assets/demo.mp4).
 *
 *   node tools/screencast.mjs                 # capture frames, encode, self-check
 *   node tools/screencast.mjs --skip-encode   # frames only (fast iteration)
 *   node tools/screencast.mjs --width 1280 --height 820 --crop-height 740
 *
 * What it does: drives a fresh headless Chrome over raw CDP (same mechanics as
 * tools/shots.mjs: self-signed auth cookie, opaque-origin preview iframe reached
 * through its own OOPIF session), plays the scripted 6.8 s sequence
 *
 *   click 「检查元素」 → hover div.topbar (tooltip) → click (chip lands in the
 *   composer) → cursor travels to the chip → reset to the first frame
 *
 * as a *deterministic stop-motion*: every frame is captured at an exact virtual
 * time at 15 fps, with a synthetic cursor overlay drawn in the parent page (CDP
 * mouse events never render a real pointer in screenshots). Frames are written
 * to tests/screencast/frames/ (git-ignored), then encoded to H.264 mp4 and a
 * palette-optimised GIF.
 *
 * Privacy: the capture is cropped to the right of the left sidebar (no session
 * list, no workspace switcher) and the remaining page text is redacted the same
 * way as tools/shots.mjs (absolute paths, workspace name, model chip, e-mail,
 * phone). Nothing outside tests/screencast/, assets/demo.* is written.
 */

import { createHash, createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DEFAULTS = {
  gui: process.env.DSH_GUI ?? 'http://127.0.0.1:3080',
  chrome: process.env.CHROME_PATH ?? null,
  workspace: basename(REPO_ROOT),
  fixture: 'fixtures/apple-square.html',
  target: 'div.topbar',
  width: 1280,
  height: 820,
  cropHeight: null,
  dpr: 2,
  fps: 15,
  gifWidth: 960,
  mp4Width: 1440,
  colors: 128,
  frames: join(REPO_ROOT, 'tests', 'screencast'),
  assets: join(REPO_ROOT, 'assets'),
  duration: 6.6,
  timeout: 45_000,
  stepTimeout: 15_000,
  keepChrome: false,
  skipEncode: false,
  skipCapture: false,
  verbose: false,
  widthExplicit: false,
  heightExplicit: false,
  still: false,
  stillWidth: 1500,
  stillHeight: 900,
  stillCropHeight: null,
  stillOutput: join(REPO_ROOT, 'assets', 'howto.png'),
  stillPreviewWidth: 900,
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
      case '--workspace': opts.workspace = next(); break;
      case '--fixture': opts.fixture = next(); break;
      case '--target': opts.target = next(); break;
      case '--width': opts.width = Number(next()); opts.widthExplicit = true; break;
      case '--height': opts.height = Number(next()); opts.heightExplicit = true; break;
      case '--crop-height': opts.cropHeight = Number(next()); break;
      case '--dpr': opts.dpr = Number(next()); break;
      case '--fps': opts.fps = Number(next()); break;
      case '--gif-width': opts.gifWidth = Number(next()); break;
      case '--mp4-width': opts.mp4Width = Number(next()); break;
      case '--colors': opts.colors = Number(next()); break;
      case '--frames': opts.frames = next(); break;
      case '--assets': opts.assets = next(); break;
      case '--duration': opts.duration = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--keep-chrome': opts.keepChrome = true; break;
      case '--skip-encode': opts.skipEncode = true; break;
      case '--skip-capture': opts.skipCapture = true; break;
      case '--still': opts.still = true; break;
      case '--still-width': opts.stillWidth = Number(next()); break;
      case '--still-height': opts.stillHeight = Number(next()); break;
      case '--still-crop-height': opts.stillCropHeight = Number(next()); break;
      case '--still-output': opts.stillOutput = next(); break;
      case '--still-preview-width': opts.stillPreviewWidth = Number(next()); break;
      case '--verbose': opts.verbose = true; break;
      case '--help': case '-h': console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  opts.gui = opts.gui.replace(/\/+$/u, '');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const log = (...args) => console.log(...args);
const debug = (...args) => { if (opts.verbose) console.log('   ·', ...args); };

class EnvironmentError extends Error {}
class StepFailure extends Error {}

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

async function rectOf(selector) {
  return evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`);
}

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

async function waitPreviewContext(timeout = 15_000) {
  return waitUntil(async () => {
    try { return (await previewContext()).context.contextId; } catch { return null; }
  }, { timeout, interval: 120, label: 'preview iframe execution context' });
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
  await clickSelector('button[aria-label="选择工作区"]');
  await waitUntil(async () => (await evaluate(`document.querySelectorAll('[role=menuitem]').length > 0`)), { label: 'workspace menu' });
  await clickByText('[role=menuitem]', opts.workspace);
  await waitUntil(async () => {
    const chip = await evaluate(`document.querySelector('button[aria-label="选择工作区"]')?.innerText ?? ''`);
    return chip.includes(opts.workspace);
  }, { label: `workspace chip shows ${opts.workspace}` });
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-composer-input]') !== null`)), { label: 'composer after workspace switch' });

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

// ---------------------------------------------------------------------------
// capture state
// ---------------------------------------------------------------------------

let cdp;
let sessionId;
let chromeProc;
let chromeDir;

const framesDir = join(opts.frames, 'frames');
const qcDir = join(opts.frames, 'qc');
const ASSETS_DIR = opts.assets;
const pad = (index) => String(index).padStart(4, '0');

// The scripted timeline, in virtual seconds. Every beat is a frame index at
// 15 fps, so the recording is the same on every machine.
const TL = {
  toToggle: [0.70, 1.35],
  clickToggle: 1.40,
  toTarget: [1.95, 2.95],
  clickTarget: 3.70,
  closePopover: 4.10,
  toChip: [4.55, 5.30],
  reset: 5.85,
  back: [5.90, 6.35],
};

// ---------------------------------------------------------------------------
// sanitising: crop kills the sidebar, this pass kills everything else
// ---------------------------------------------------------------------------

// Same redaction vocabulary as tools/shots.mjs, plus the preview header path
// (which otherwise prints the absolute fixture location) and the composer caret
// (a blinking caret would double the GIF size and flicker).
const SANITIZE_SCRIPT = String.raw`(() => {
  const style = document.createElement('style');
  style.id = '__demo_screencast_style';
  style.textContent = [
    '[data-composer-input]{caret-color:transparent!important}',
    '[data-composer-input] *{caret-color:transparent!important}',
    '*{scrollbar-width:none!important}',
    '*::-webkit-scrollbar{display:none!important}',
  ].join('\n');
  document.head.appendChild(style);

  // Background activity pill ("4 进行中") pulses on its own: not part of the
  // story and a source of inter-frame noise.
  for (const node of Array.from(document.querySelectorAll('body *'))) {
    if (node.children.length > 0) continue;
    if (/^\d+\s*进行中$/u.test((node.textContent ?? '').trim())) {
      let host = node;
      for (let depth = 0; depth < 3 && host.parentElement !== null; depth += 1) host = host.parentElement;
      host.style.setProperty('display', 'none', 'important');
    }
  }

  const patterns = [
    [/\/Users\/[^\s"'<>]*/gu, '…'],
    [/(?:Kimi|DeepSeek|Claude|GPT)[^\n]{0,40}/gu, 'Model'],
    [/\bcare\b/gu, 'user'],
    [/\b(?:huaxue|PortyLabs|dsh-fat-fish|dsh-one|dsh-phone|dsh-ui|dsh-inspect-plugin|TradeAgentExp)\b/gu, 'demo-workspace'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, 'hello@example.com'],
    [/1[3-9]\d{9}/gu, '+00 0000 0000'],
  ];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (parent === null) continue;
    let text = node.nodeValue;
    for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
    if (text !== node.nodeValue) node.nodeValue = text;
  }

  // The model chip renders as two text nodes ("Kimi …" + "High"); redaction
  // leaves a dangling size word, so drop it once the name is redacted.
  for (const node of nodes) {
    if (node.nodeValue === null) continue;
    if (!/^(High|Highspeed|Medium|Low|Lowpower)$/u.test(node.nodeValue.trim())) continue;
    const host = node.parentElement?.closest('button, [role="button"], div');
    if (host !== null && host !== undefined && /Model/u.test(host.textContent ?? '')) node.nodeValue = '';
  }

  // Preview header: show the file name only, never its directory.
  const spans = Array.from(document.querySelectorAll('span, div'));
  const pathSpan = spans.find((node) => node.children.length === 0 && /fixtures[\\/]apple-square\.html$/u.test((node.textContent ?? '').trim()));
  if (pathSpan !== undefined) pathSpan.textContent = 'apple-square.html';
  return true;
})()`;

// Synthetic pointer: CDP mouse events move hit-testing but never paint a
// cursor, so the visible arrow is an overlay we drive frame by frame.
const CURSOR_SCRIPT = String.raw`(() => {
  if (window.__demoCursor !== undefined) return 'exists';
  const host = document.createElement('div');
  host.id = '__demo_cursor__';
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform;';
  host.innerHTML = [
    '<div class="__demo_cursor_ripple" style="position:absolute;left:0;top:0;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;border:2px solid rgba(64,110,255,.9);background:rgba(64,110,255,.16);opacity:0;transform:scale(.3);"></div>',
    '<svg class="__demo_cursor_arrow" width="26" height="30" viewBox="0 0 26 30" style="position:absolute;left:-1px;top:-1px;overflow:visible;transform-origin:4px 3px;filter:drop-shadow(0 1px 2px rgba(15,23,42,.45));">',
    '<path d="M4 3 L4 23.4 L8.9 18.6 L12.4 26.4 L15.9 24.9 L12.5 17.2 L18.9 17.2 Z" fill="#ffffff" stroke="#0f172a" stroke-width="1.6" stroke-linejoin="round"/>',
    '</svg>',
  ].join('');
  document.documentElement.appendChild(host);
  const ripple = host.querySelector('.__demo_cursor_ripple');
  const arrow = host.querySelector('.__demo_cursor_arrow');
  window.__demoCursor = {
    set(x, y) { host.style.transform = 'translate(' + x + 'px,' + y + 'px)'; },
    press(on) { arrow.style.transform = on ? 'scale(.9)' : 'scale(1)'; },
    pulse() {
      ripple.style.transition = 'none';
      ripple.style.opacity = '0.9';
      ripple.style.transform = 'scale(.35)';
      void ripple.offsetWidth;
      ripple.style.transition = 'opacity .42s ease-out, transform .42s cubic-bezier(.2,.7,.3,1)';
      ripple.style.opacity = '0';
      ripple.style.transform = 'scale(1.25)';
    },
  };
  return 'ok';
})()`;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** Page-space rect of an element living inside the opaque preview iframe. */
async function inFrameRect(selector) {
  const frame = await rectOf(INSPECT_FRAME);
  if (frame === null) throw new StepFailure('preview iframe missing');
  const result = await evalInPreview(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`);
  if (result.value === null || result.value === undefined) throw new StepFailure(`element not found inside the preview: ${selector}`);
  return { x: frame.x + result.value.x, y: frame.y + result.value.y, width: result.value.width, height: result.value.height };
}

const centerOf = (rect) => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });

async function chipRects() {
  return evaluate(`(() => {
    return Array.from(document.querySelectorAll('[data-composer-input] [title^="<"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    });
  })()`);
}

// ---------------------------------------------------------------------------
// deterministic frame capture
// ---------------------------------------------------------------------------

// Flick-and-settle: most of the distance is covered in the first third, then the
// pointer crawls into the target. Same feel as a hand throwing the mouse, and it
// keeps the inspector's transient highlights (every element crossed on the way)
// down to two or three frames instead of a six-frame strobe.
const easeFlick = (u) => 1 - (1 - u) ** 4;

/** Position of the synthetic pointer at virtual time t. */
function cursorAt(legs, t) {
  let point = legs[0].from;
  for (const leg of legs) {
    if (t >= leg.t1) { point = leg.to; continue; }
    if (t <= leg.t0) return point;
    const u = (t - leg.t0) / (leg.t1 - leg.t0);
    const eased = easeFlick(u);
    return { x: leg.from.x + (leg.to.x - leg.from.x) * eased, y: leg.from.y + (leg.to.y - leg.from.y) * eased };
  }
  return point;
}

/** Wait for the compositor to accept the DOM changes made above. */
async function flushPaint() {
  await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
}

async function movePointer(point) {
  await evaluate(`(() => { window.__demoCursor?.set(${Math.round(point.x)}, ${Math.round(point.y)}); return true; })()`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(point.x), y: Math.round(point.y), button: 'none', buttons: 0, pointerType: 'mouse',
  }, sessionId);
}

async function pulsePointer() {
  await evaluate(`(() => { window.__demoCursor?.pulse(); return true; })()`);
}

async function captureFrame(clip, index) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: opts.dpr },
  }, sessionId);
  const file = join(framesDir, `${pad(index)}.png`);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

async function playTimeline({ clip, legs, events, totalFrames }) {
  const started = Date.now();
  let next = 0;
  for (let index = 0; index < totalFrames; index += 1) {
    const t = index / opts.fps;
    while (next < events.length && events[next].at <= t + 1e-6) {
      const event = events[next];
      next += 1;
      debug(`t=${t.toFixed(2)}s ${event.label}`);
      await event.run();
    }
    await movePointer(cursorAt(legs, t));
    await flushPaint();
    await captureFrame(clip, index);
    if (index % 15 === 0) log(`    frame ${String(index).padStart(3, '0')}/${totalFrames}`);
  }
  log(`  ✔ captured ${totalFrames} frames in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

function runFfmpeg(args, { label = 'ffmpeg' } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-20000); });
    proc.on('error', (error) => rejectRun(new EnvironmentError(`cannot run ffmpeg: ${error.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolveRun(stderr);
      else rejectRun(new StepFailure(`${label} failed (exit ${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function ffprobe(file) {
  return new Promise((resolveProbe, rejectProbe) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (chunk) => { out += String(chunk); });
    proc.on('error', (error) => rejectProbe(new EnvironmentError(`cannot run ffprobe: ${error.message}`)));
    proc.on('close', () => {
      try { resolveProbe(JSON.parse(out)); } catch { rejectProbe(new StepFailure(`ffprobe returned junk for ${file}: ${out.slice(0, 300)}`)); }
    });
  });
}

const KIB = 1024;

async function encodeMp4() {
  const out = join(ASSETS_DIR, 'demo.mp4');
  const attempts = [];
  for (const crf of [20, 23, 26]) {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(opts.fps), '-i', join(framesDir, '%04d.png'),
      '-vf', `scale=${opts.mp4Width}:-2:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      out,
    ], { label: `mp4 encode (crf ${crf})` });
    const bytes = statSync(out).size;
    attempts.push({ crf, bytes });
    log(`  mp4 crf ${crf}: ${(bytes / KIB / KIB).toFixed(2)} MB`);
    if (bytes <= 1.5 * KIB * KIB) break;
  }
  return { path: out, bytes: statSync(out).size, crf: attempts[attempts.length - 1].crf };
}

async function encodeGif() {
  const out = join(ASSETS_DIR, 'demo.gif');
  const attempts = [];
  const presets = [];
  for (const colors of [opts.colors, 96, 64]) presets.push({ width: opts.gifWidth, colors });
  for (const width of [900, 860]) presets.push({ width, colors: 96 });

  for (const preset of presets) {
    const graph = `[0:v]scale=${preset.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${preset.colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[v]`;
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(opts.fps), '-i', join(framesDir, '%04d.png'),
      '-filter_complex', graph, '-map', '[v]', '-loop', '0',
      out,
    ], { label: `gif encode (${preset.width}px, ${preset.colors} colors)` });
    const bytes = statSync(out).size;
    attempts.push({ ...preset, bytes });
    log(`  gif ${preset.width}px/${preset.colors}c: ${(bytes / KIB).toFixed(0)} KB`);
    if (bytes <= 3 * KIB * KIB) return { path: out, bytes, ...preset };
  }
  return { path: out, bytes: statSync(out).size, ...attempts[attempts.length - 1] };
}

// ---------------------------------------------------------------------------
// self-check: blank/black frames, flicker, loop seam, legibility inputs
// ---------------------------------------------------------------------------

async function frameStats() {
  const report = join(opts.frames, 'stats.txt');
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(opts.fps), '-i', join(framesDir, '%04d.png'),
    '-vf', `scale=240:-1,signalstats,metadata=print:file=${report}`,
    '-f', 'null', '-',
  ], { label: 'frame statistics' });
  const text = readFileSync(report, 'utf8');
  const rows = [];
  for (const block of text.split('frame:').slice(1)) {
    const index = Number(block.trim().split(/\s+/u)[0]);
    const pick = (key) => {
      const match = block.match(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, 'u'));
      return match === null ? null : Number(match[1]);
    };
    rows.push({ index, yavg: pick('YAVG'), ymin: pick('YMIN'), ymax: pick('YMAX') });
  }
  return rows;
}

async function diffStats() {
  const report = join(opts.frames, 'diff.txt');
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(opts.fps), '-i', join(framesDir, '%04d.png'),
    '-vf', `scale=240:-1,tblend=all_mode=difference,signalstats,metadata=print:file=${report}`,
    '-f', 'null', '-',
  ], { label: 'inter-frame differences' });
  const text = readFileSync(report, 'utf8');
  const rows = [];
  for (const block of text.split('frame:').slice(1)) {
    const index = Number(block.trim().split(/\s+/u)[0]);
    const match = block.match(/lavfi\.signalstats\.YAVG=([\d.]+)/u);
    rows.push({ index, diff: match === null ? null : Number(match[1]) });
  }
  return rows;
}

async function seamDistance(firstFile, lastFile) {
  const report = join(opts.frames, 'seam.txt');
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', firstFile, '-i', lastFile,
    '-filter_complex', `[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=${report},format=gray[v]`,
    '-map', '[v]', '-frames:v', '1', '-f', 'null', '-',
  ], { label: 'loop seam' });
  const text = readFileSync(report, 'utf8');
  const match = text.match(/lavfi\.signalstats\.YAVG=([\d.]+)/u);
  return match === null ? null : Number(match[1]);
}

async function selfCheck({ gif, mp4, totalFrames, seam }) {
  mkdirSync(qcDir, { recursive: true });
  const picks = [6, 26, 45, 62, 80, totalFrames - 1].filter((index) => index >= 0 && index < totalFrames);
  const qcFrames = [];
  const qcIndex = {};
  for (const [order, index] of picks.entries()) {
    const name = `qc-${String(order + 1).padStart(2, '0')}.png`;
    copyFileSync(join(framesDir, `${pad(index)}.png`), join(qcDir, name));
    qcFrames.push(join(qcDir, name));
    qcIndex[name] = index;
  }
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', '1', '-i', join(qcDir, 'qc-%02d.png'),
    '-vf', 'scale=520:-1:flags=lanczos,tile=2x3', '-frames:v', '1',
    join(qcDir, 'contact-sheet.png'),
  ], { label: 'contact sheet' });

  const stats = await frameStats();
  const diffs = await diffStats();
  const blackFrames = stats.filter((row) => row.yavg !== null && row.yavg < 10).map((row) => row.index);
  const blankFrames = stats.filter((row) => row.ymax !== null && row.ymax < 40).map((row) => row.index);
  const diffsClean = diffs.filter((row) => row.diff !== null);
  const sorted = diffsClean.map((row) => row.diff).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const loudest = [...diffsClean].sort((a, b) => b.diff - a.diff).slice(0, 4);

  const gifProbe = await ffprobe(gif.path);
  const mp4Probe = await ffprobe(mp4.path);
  const pickStream = (probe) => (probe.streams ?? []).find((stream) => stream.codec_type === 'video') ?? {};
  const gifStream = pickStream(gifProbe);
  const mp4Stream = pickStream(mp4Probe);

  const report = {
    capturedAt: new Date().toISOString(),
    viewport: { width: opts.width, height: opts.height, dpr: opts.dpr, cropHeight: opts.cropHeight },
    frames: totalFrames,
    fps: opts.fps,
    durationSeconds: Number((totalFrames / opts.fps).toFixed(3)),
    gif: { bytes: gif.bytes, width: Number(gifStream.width ?? 0), height: Number(gifStream.height ?? 0), colors: gif.colors, paletteWidth: gif.width },
    mp4: { bytes: mp4.bytes, width: Number(mp4Stream.width ?? 0), height: Number(mp4Stream.height ?? 0), crf: mp4.crf },
    luminance: {
      min: Math.min(...stats.map((row) => row.yavg ?? 0)),
      max: Math.max(...stats.map((row) => row.yavg ?? 0)),
    },
    blackFrames,
    blankFrames,
    flicker: { medianDiff: median, loudest },
    loopSeam: seam,
    qcFrames,
    qcFrameIndex: qcIndex,
    contactSheet: join(qcDir, 'contact-sheet.png'),
  };
  writeFileSync(join(opts.frames, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function boot() {
  const authority = new URL(opts.gui).host;
  const cookie = mintAuthCookie(authority);
  const chromePath = resolveChromePath();
  chromeDir = mkdtempSync(join(tmpdir(), 'dsh-screencast-'));
  const launched = await launchChrome({ chromePath, userDataDir: chromeDir, headless: true });
  chromeProc = launched.proc;
  const connected = await connectBrowser(launched.port);
  cdp = connected.cdp;
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
  sessionId = attached.sessionId;
  for (const domain of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await cdp.send(domain, {}, sessionId);
  trackFrameContexts();
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.dpr, mobile: false }, sessionId);
  await cdp.send('Network.setCookie', {
    name: cookie.name, value: cookie.value, url: `${opts.gui}/`, path: '/',
    httpOnly: true, sameSite: 'Strict', expires: (Date.now() + 30 * 864e5) / 1000,
  }, sessionId);
  await cdp.send('Page.navigate', { url: `${opts.gui}/` }, sessionId);
  await waitUntil(async () => (await evaluate(`document.querySelector('[data-composer-input]') !== null`)), { timeout: 60_000, label: 'DSH shell' });
  log('  ✔ shell loaded');
  await openPreviewFixture();
  await sleep(1200);
  log('  ✔ preview fixture open');
}

async function focusComposer() {
  await evaluate(`(() => {
    const input = document.querySelector('[data-composer-input]');
    if (input === null) return false;
    input.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
}

async function pressBackspace() {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    }, sessionId);
  }
}

/** Put the UI back into the same state frame 0 should show. */
async function prepareStartState() {
  await dismissErrorToasts();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const chips = await chipRects();
    if (chips.length === 0) break;
    await focusComposer();
    await pressBackspace();
    await sleep(120);
  }
  const stillOn = await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true'`);
  if (stillOn === true) {
    await evaluate(`(() => { document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.click(); return true; })()`);
    await sleep(150);
  }
  await closeInspectPopover().catch(() => {});
  await sleep(250);
}

async function capture() {
  await boot();
  await evaluate(SANITIZE_SCRIPT);
  await evaluate(CURSOR_SCRIPT);
  await prepareStartState();

  const toggleRect = await rectOf(RENDERER_TOGGLE);
  const frameRect = await rectOf(INSPECT_FRAME);
  const chatRect = await rectOf('[data-conversation-scroll]');
  const composerRect = await rectOf('[data-composer-input]');
  const targetRect = await inFrameRect(opts.target);
  for (const [name, rect] of Object.entries({ toggleRect, frameRect, chatRect, composerRect, targetRect })) {
    if (rect === null) throw new EnvironmentError(`${name} not found — is the preview panel collapsed?`);
  }

  // Crop starts at the chat column: the left sidebar (workspace + session list)
  // never enters the frame at all.
  const clip = {
    x: Math.round(chatRect.x) + 1,
    y: 0,
    width: Math.round(opts.width - Math.round(chatRect.x) - 1),
    height: opts.cropHeight === null ? opts.height : Math.min(opts.cropHeight, opts.height),
  };
  log(`  crop ${clip.width}×${clip.height} css → ${clip.width * opts.dpr ** 2}×${clip.height * opts.dpr ** 2} px (dpr ${opts.dpr} × clip scale ${opts.dpr}) · frame at ${Math.round(frameRect.x)},${Math.round(frameRect.y)}`);

  const togglePt = centerOf(toggleRect);
  const targetPt = centerOf(targetRect);
  const startPt = { x: Math.round(frameRect.x + 26), y: Math.round(frameRect.y + 16) };
  const chipGuess = { x: Math.round(composerRect.x + 52), y: Math.round(composerRect.y + composerRect.height / 2) };

  const legToToggle = { t0: TL.toToggle[0], t1: TL.toToggle[1], from: startPt, to: togglePt };
  const legToTarget = { t0: TL.toTarget[0], t1: TL.toTarget[1], from: togglePt, to: targetPt };
  const legToChip = { t0: TL.toChip[0], t1: TL.toChip[1], from: targetPt, to: chipGuess };
  const legBack = { t0: TL.back[0], t1: TL.back[1], from: chipGuess, to: startPt };
  const legs = [legToToggle, legToTarget, legToChip, legBack];

  const events = [
    {
      at: TL.clickToggle,
      label: 'click 检查元素',
      run: async () => {
        await pulsePointer();
        await mouseClickAt(togglePt.x, togglePt.y);
        await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true'`)), { timeout: 5_000, label: 'inspect mode on' });
        // Inspect mode adds a guidance banner above the preview, pushing the
        // iframe down: re-measure so the pointer lands on the real element.
        await sleep(220);
        const shifted = centerOf(await inFrameRect(opts.target));
        targetPt.x = shifted.x;
        targetPt.y = shifted.y;
        debug(`target re-measured at ${targetPt.x},${targetPt.y}`);
      },
    },
    {
      at: TL.clickTarget,
      label: `click ${opts.target}`,
      run: async () => {
        // Measure once more right before the press: the banner text changes
        // height between "hover to inspect" and "element selected".
        const fresh = centerOf(await inFrameRect(opts.target));
        targetPt.x = fresh.x;
        targetPt.y = fresh.y;
        await movePointer(targetPt);
        await evaluate(`(() => { window.__demoCursor?.press(true); return true; })()`);
        await pulsePointer();
        await mouseClickAt(targetPt.x, targetPt.y);
        await evaluate(`(() => { window.__demoCursor?.press(false); return true; })()`);
        await waitUntil(async () => (await chipRects()).length > 0, { timeout: 8_000, label: 'reference chip in the composer' });
        const chips = await chipRects();
        const chip = chips[chips.length - 1];
        legToChip.to = centerOf(chip);
        legBack.from = centerOf(chip);
        log(`  ✔ chip captured (${Math.round(chip.width)}×${Math.round(chip.height)} css)`);
      },
    },
    {
      at: TL.closePopover,
      label: 'close inspect popover',
      run: async () => { await closeInspectPopover().catch(() => {}); },
    },
    {
      at: TL.reset,
      label: 'reset to frame 0',
      run: async () => {
        await prepareStartState();
        const state = await evaluate(`(() => ({
          chips: document.querySelectorAll('[data-composer-input] [title^="<"]').length,
          toggleOn: document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true',
        }))()`);
        if (state.chips !== 0 || state.toggleOn !== false) log(`    ! reset incomplete: ${JSON.stringify(state)}`);
      },
    },
  ];

  const totalFrames = Math.round(opts.duration * opts.fps);
  log('  recording…');
  await playTimeline({ clip, legs, events, totalFrames });
  return { clip, totalFrames };
}

async function main() {
  if (opts.still === true) {
    if (opts.widthExplicit === false) opts.width = opts.stillWidth;
    if (opts.heightExplicit === false) opts.height = opts.stillHeight;
    log('');
    log('still → assets/howto.png (+ tests/screens/hero-preview.png)');
    log(`  viewport ${opts.width}×${opts.height} @${opts.dpr}x`);
    const result = await captureStill();
    return { still: result };
  }
  if (existsSync(join(ASSETS_DIR, 'demo.gif'))) log('  · overwriting existing assets/demo.*');
  mkdirSync(ASSETS_DIR, { recursive: true });
  mkdirSync(opts.frames, { recursive: true });

  log('');
  log('screencast → assets/demo.gif + assets/demo.mp4');
  log(`  viewport ${opts.width}×${opts.height} @${opts.dpr}x · ${opts.fps} fps · ${opts.duration} s planned`);

  const captureFile = join(opts.frames, 'capture.json');
  let clip;
  let totalFrames = Math.round(opts.duration * opts.fps);
  if (opts.skipCapture === true && existsSync(captureFile)) {
    const cached = JSON.parse(readFileSync(captureFile, 'utf8'));
    clip = cached.clip;
    totalFrames = cached.totalFrames;
    const onDisk = readdirSync(framesDir).filter((name) => name.endsWith('.png')).length;
    if (onDisk !== totalFrames) throw new EnvironmentError(`--skip-capture expects ${totalFrames} frames in ${framesDir}, found ${onDisk}`);
    log(`  · reusing ${totalFrames} frames (crop ${clip.width}×${clip.height})`);
  } else {
    rmSync(framesDir, { recursive: true, force: true });
    rmSync(qcDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    const result = await capture();
    clip = result.clip;
    totalFrames = result.totalFrames;
    writeFileSync(captureFile, `${JSON.stringify({ clip, totalFrames, target: opts.target, fps: opts.fps, dpr: opts.dpr }, null, 2)}\n`);
  }

  let gif = null;
  let mp4 = null;
  let report = null;
  if (opts.skipEncode === false) {
    log('  encoding…');
    mp4 = await encodeMp4();
    gif = await encodeGif();
    const seam = await seamDistance(join(framesDir, `0000.png`), join(framesDir, `${pad(totalFrames - 1)}.png`));
    report = await selfCheck({ gif, mp4, totalFrames, seam });
  }

  if (report !== null) {
    const mb = (bytes) => `${(bytes / KIB / KIB).toFixed(2)} MB`;
    log('');
    log(`✔ assets/demo.gif  ${report.gif.width}×${report.gif.height}  ${mb(report.gif.bytes)}  ${report.frames} frames  ${report.durationSeconds}s @${report.fps} fps`);
    log(`✔ assets/demo.mp4  ${report.mp4.width}×${report.mp4.height}  ${mb(report.mp4.bytes)}  crf ${report.mp4.crf}`);
    log(`  palette ${report.gif.colors} colors at ${report.gif.paletteWidth}px wide (source crop ${clip.width}px → ${(report.gif.paletteWidth / clip.width).toFixed(2)}×)`);
    log(`  luminance ${report.luminance.min.toFixed(1)}–${report.luminance.max.toFixed(1)} · black frames ${report.blackFrames.length} · blank frames ${report.blankFrames.length}`);
    log(`  flicker median ${report.flicker.medianDiff.toFixed(2)} · loudest ${report.flicker.loudest.map((row) => `${row.index}:${row.diff.toFixed(1)}`).join(' ')}`);
    log(`  loop seam ${report.loopSeam === null ? 'n/a' : report.loopSeam.toFixed(2)} (lower is better; 0 = identical first/last frame)`);
    log(`  qc frames ${report.qcFrames.map((file) => file.replace(`${REPO_ROOT}/`, '')).join(', ')}`);
  }
  return { gif, mp4, report };
}

// ---------------------------------------------------------------------------
// still mode: the same staging, frozen after the click, with code-drawn callouts
// ---------------------------------------------------------------------------

const CALLOUT = {
  color: '#2F6FED',
  dot: 14,          // radius, css px  (56 px across at 2x)
  line: 3,          // stroke, css px  (6 px at 2x)
  font: 15,
  gap: 10,          // callout tip → target edge
  // dot offsets from the anchor rect
  one: { dx: -46, dy: 98, tipDx: -10, tipDy: 10 },  // below-left of the toggle button
  two: { dx: -96, dy: 0, tipDx: 10, tipDy: 0 },     // left of the outlined element
  three: { dx: 54, dy: 126, tipDx: 12, tipDy: 12 }, // under the composer, pointing up-left at the chip
};

function calloutSvg(items) {
  const line = (a, b) => `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${CALLOUT.color}" stroke-width="${CALLOUT.line}" stroke-linecap="round"/>`;
  const dot = (n, c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${CALLOUT.dot}" fill="${CALLOUT.color}"/><text x="${c.x.toFixed(1)}" y="${(c.y + 1).toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-family="Inter, -apple-system, 'Helvetica Neue', Arial, sans-serif" font-size="${CALLOUT.font}" font-weight="600" fill="#FFFFFF">${n}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483647" width="100%" height="100%">${items.map((it) => line(it.dot, it.tip)).join('')}${items.map((it) => dot(it.n, it.dot)).join('')}</svg>`;
}

async function drawCallouts(toggle, target, chip) {
  const items = [
    {
      n: 1,
      dot: { x: toggle.x + toggle.width / 2 + CALLOUT.one.dx, y: toggle.y + toggle.height + CALLOUT.one.dy },
      tip: { x: toggle.x + toggle.width / 2 + CALLOUT.one.tipDx, y: toggle.y + toggle.height + CALLOUT.one.tipDy },
    },
    {
      n: 2,
      dot: { x: target.x + CALLOUT.two.dx, y: target.y + target.height / 2 + CALLOUT.two.dy },
      tip: { x: target.x - CALLOUT.gap, y: target.y + target.height / 2 + CALLOUT.two.tipDy },
    },
    {
      n: 3,
      dot: { x: chip.x + chip.width + CALLOUT.three.dx, y: chip.y + chip.height + CALLOUT.three.dy },
      tip: { x: chip.x + chip.width + CALLOUT.three.tipDx, y: chip.y + chip.height + CALLOUT.three.tipDy },
    },
  ];
  await evaluate(`(() => {
    document.getElementById('__demo_callouts')?.remove();
    const host = document.createElement('div');
    host.id = '__demo_callouts';
    host.innerHTML = ${JSON.stringify(calloutSvg(items))};
    document.body.appendChild(host);
    return true;
  })()`);
  return items;
}

function centerOf2(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function captureStill() {
  await boot();
  await evaluate(SANITIZE_SCRIPT);
  await evaluate(CURSOR_SCRIPT);
  await prepareStartState();

  const toggleRect = await rectOf(RENDERER_TOGGLE);
  const frameRect = await rectOf(INSPECT_FRAME);
  const chatRect = await rectOf('[data-conversation-scroll]');
  for (const [name, rect] of Object.entries({ toggleRect, frameRect, chatRect })) {
    if (rect === null) throw new EnvironmentError(`${name} not found — is the preview panel collapsed?`);
  }

  // Crop from the chat column to the right edge: the sidebar never enters frame.
  const clip = {
    x: Math.round(chatRect.x) + 1,
    y: 0,
    width: Math.round(opts.width - Math.round(chatRect.x) - 1),
    height: opts.stillCropHeight === null ? opts.height : Math.min(opts.stillCropHeight, opts.height),
  };

  const togglePt = centerOf2(toggleRect);
  await movePointer(togglePt);
  await pulsePointer();
  await mouseClickAt(togglePt.x, togglePt.y);
  await waitUntil(async () => (await evaluate(`document.querySelector(${JSON.stringify(RENDERER_TOGGLE)})?.getAttribute('data-on') === 'true'`)), { timeout: 8_000, label: 'inspect mode on' });
  await sleep(260);

  // Inspect mode inserts the guidance banner, which pushes the iframe down:
  // measure the target only now.
  const targetRect = await inFrameRect(opts.target);
  const targetPt = centerOf2(targetRect);
  await movePointer(targetPt);
  await sleep(260);

  await evaluate(`(() => { window.__demoCursor?.press(true); return true; })()`);
  await pulsePointer();
  await mouseClickAt(targetPt.x, targetPt.y);
  await evaluate(`(() => { window.__demoCursor?.press(false); return true; })()`);
  await waitUntil(async () => (await chipRects()).length > 0, { timeout: 8_000, label: 'reference chip in the composer' });
  const chips = await chipRects();
  const chip = chips[chips.length - 1];
  await sleep(300);
  await closeInspectPopover().catch(() => {});
  await sleep(220);

  // Static diagram: no synthetic pointer in the picture, the callouts carry the story.
  await evaluate(`(() => { const el = document.getElementById('__demo_cursor__'); if (el) el.style.display = 'none'; return true; })()`);
  await movePointer(targetPt);
  await sleep(160);

  // Everything settles into its final geometry after selection, so re-measure
  // all three anchors right before drawing.
  const toggleFinal = await rectOf(RENDERER_TOGGLE);
  const targetFinal = await inFrameRect(opts.target);
  const chipsFinal = await chipRects();
  const chipFinal = chipsFinal[chipsFinal.length - 1];
  for (const [name, rect] of Object.entries({ toggleFinal, targetFinal, chipFinal })) {
    if (rect === null || rect === undefined) throw new EnvironmentError(`${name} not measurable for the callouts`);
  }

  const rawDir = join(opts.frames, 'still');
  mkdirSync(rawDir, { recursive: true });
  const rawNeat = join(rawDir, 'plain.png');
  const rawAnnotated = join(rawDir, 'annotated.png');

  await flushPaint();
  const plain = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: opts.dpr } }, sessionId);
  writeFileSync(rawNeat, Buffer.from(plain.data, 'base64'));

  await drawCallouts(toggleFinal, targetFinal, chipFinal);
  await flushPaint();
  const annotated = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { ...clip, scale: opts.dpr } }, sessionId);
  writeFileSync(rawAnnotated, Buffer.from(annotated.data, 'base64'));

  // Deliver at 1800 px wide (capture is 2x, so this is a 0.74x lanczos pass that
  // keeps 11 px body text crisp), plus a 50% preview for review.
  const width = 1800;
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error', '-i', rawAnnotated,
    '-vf', `scale=${width}:-1:flags=lanczos`,
    '-compression_level', '100',
    opts.stillOutput,
  ], { label: 'still downscale (1800 px)' });
  const previewPath = join(REPO_ROOT, 'tests', 'screens', 'hero-preview.png');
  mkdirSync(dirname(previewPath), { recursive: true });
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error', '-i', opts.stillOutput,
    '-vf', `scale=${Math.round(width / 2)}:-1:flags=lanczos`,
    previewPath,
  ], { label: 'still preview (50%)' });

  const stillBytes = statSync(opts.stillOutput).size;
  const previewBytes = statSync(previewPath).size;
  const round = (rect) => `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}`;
  log(`  anchors: toggle ${round(toggleFinal)} · target ${round(targetFinal)} · chip ${round(chipFinal)} · crop ${clip.width}×${clip.height} @ ${clip.x},${clip.y}`);
  const meta = (await ffprobe(opts.stillOutput)).streams[0];
  log('');
  log(`✔ ${opts.stillOutput.replace(`${REPO_ROOT}/`, '')}  ${meta.width}×${meta.height}  ${(stillBytes / KIB).toFixed(0)} KB`);
  log(`✔ ${previewPath.replace(`${REPO_ROOT}/`, '')}  ${(previewBytes / KIB).toFixed(0)} KB`);
  log(`  crop ${clip.width}×${clip.height} css @${opts.dpr}x · tooltip in frame reads ${opts.target} ${Math.round(targetFinal.width)}×${Math.round(targetFinal.height)}`);
  log(`  raw: ${rawNeat.replace(`${REPO_ROOT}/`, '')}, ${rawAnnotated.replace(`${REPO_ROOT}/`, '')}`);
  if (stillBytes > 600 * KIB) log(`  ! over the 600 KB budget (${(stillBytes / KIB).toFixed(0)} KB) — drop --still-width or quantise`);
  return { stillBytes, previewBytes };
}

function cleanup() {
  if (opts.keepChrome === false) {
    try { chromeProc?.kill('SIGKILL'); } catch { /* already gone */ }
    try { if (chromeDir !== undefined) rmSync(chromeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main()
  .then((result) => { cleanup(); log(''); process.exit(0); })
  .catch((error) => {
    cleanup();
    const kind = error instanceof EnvironmentError ? 'environment' : error instanceof StepFailure ? 'step' : 'unexpected';
    console.error(`\nscreencast failed (${kind}): ${error?.message ?? error}`);
    if (opts.verbose && error?.stack) console.error(error.stack);
    process.exit(1);
  });
