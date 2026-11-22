#!/usr/bin/env node
/**
 * Headless-Chrome runner for the dsh-web-inspect engine self-test.
 *
 *   node tests/run-engine-selftest.mjs
 *   node tests/run-engine-selftest.mjs --chrome "/path/to/Google Chrome"
 *   node tests/run-engine-selftest.mjs --keep          (keep the temp profile)
 *
 * It loads tests/engine-selftest.html in headless Chrome with
 * --allow-file-access-from-files (the test inspects a file:// iframe) and
 * --virtual-time-budget (so async assertions complete before --dump-dom),
 * then parses the `<pre id="result">` block the page writes.
 *
 * Exit codes: 0 = all assertions passed, 1 = failing assertions, 2 = runner/browser error.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(HERE, 'engine-selftest.html');
const LIB = path.join(ROOT, 'lib', 'inspector.js');
const VIRTUAL_TIME_BUDGET_MS = 20000;
const WALL_TIMEOUT_MS = 60000;
const require = createRequire(import.meta.url);

function log(line) {
  process.stdout.write(line + '\n');
}

function failRun(message, extra) {
  process.stderr.write('SELFTEST RUNNER ERROR: ' + message + '\n');
  if (extra) process.stderr.write(String(extra).trimEnd() + '\n');
  process.exit(2);
}

/**
 * The plugin embeds lib/inspector.js as the body of a factory function inside
 * window.__ModuleLoader__.load({factory}) — no top-level `export`, and `module`
 * is not in scope there. The package is `"type": "module"`, so Node also loads
 * the file as an ES module whose only handoff is globalThis. Verify both shapes.
 */
async function checkModuleLoading() {
  const checks = [];
  const src = readFileSync(LIB, 'utf8');
  const hasApi = (api) => !!api &&
    typeof api.createInspector === 'function' && typeof api.describeElement === 'function' &&
    typeof api.formatContextMarkdown === 'function' && typeof api.cssPath === 'function';

  /* (a) factory-body / classic-script shape: no module/exports in scope */
  try {
    const scriptLike = new Function(src);
    delete globalThis.__DSH_INSPECT_ENGINE__;
    scriptLike();
    checks.push(['loader path: script body -> globalThis.__DSH_INSPECT_ENGINE__', hasApi(globalThis.__DSH_INSPECT_ENGINE__)]);
  } catch (err) {
    checks.push(['loader path: script body -> globalThis.__DSH_INSPECT_ENGINE__', false, err.message]);
  }

  /* (b) ESM side-effect import under "type": "module" (global is the handoff) */
  try {
    delete globalThis.__DSH_INSPECT_ENGINE__;
    await import(pathToFileURL(LIB).href + '?selftest=' + Date.now());
    checks.push(['loader path: ESM side-effect import -> globalThis', hasApi(globalThis.__DSH_INSPECT_ENGINE__)]);
  } catch (err) {
    checks.push(['loader path: ESM side-effect import -> globalThis', false, err.message]);
  }

  /* (c) the text must stay safe to inline into a factory body */
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const hasTopLevelEsm = /(^|\n)\s*(?:import|export)\s/.test(withoutComments);
  checks.push(['file has no top-level import/export (safe as factory body)', !hasTopLevelEsm]);
  return checks;
}

async function reportModuleLoading() {
  log('module loading checks');
  let ok = true;
  for (const [name, passed, detail] of await checkModuleLoading()) {
    if (!passed) ok = false;
    log('  ' + (passed ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' | ' + detail : ''));
  }
  log('');
  return ok;
}


function findChrome(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  const appDirs = ['/Applications', path.join(homedir(), 'Applications')];
  for (const dir of appDirs) {
    candidates.push(path.join(dir, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
    candidates.push(path.join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    candidates.push(path.join(dir, 'Google Chrome Canary.app', 'Contents', 'MacOS', 'Google Chrome Canary'));
  }
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  );
  const playwrightCache = path.join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(playwrightCache)) {
    for (const entry of readdirSync(playwrightCache)) {
      candidates.push(path.join(playwrightCache, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      candidates.push(path.join(playwrightCache, entry, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
      candidates.push(path.join(playwrightCache, entry, 'chrome-linux', 'chrome'));
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function extractResult(dom) {
  const match = dom.match(/<pre\b[^>]*\bid="result"[^>]*>([\s\S]*?)<\/pre>/i);
  return match ? decodeEntities(match[1]) : null;
}

function runChrome(chromePath, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ stdout: '', stderr: String(err), timedOut: false, spawnError: err });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, WALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, spawnError: err });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, code, signal });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const chromeArg = argv.find((arg) => arg.startsWith('--chrome='));
  const explicit = chromeArg ? chromeArg.slice('--chrome='.length) : null;

  if (!existsSync(PAGE)) failRun('missing test page: ' + PAGE);
  const chrome = findChrome(explicit);
  if (!chrome) {
    failRun(
      'no Chrome/Chromium executable found',
      'Set CHROME_BIN or pass --chrome=/path/to/chrome.',
    );
  }

  const profileDir = mkdtempSync(path.join(tmpdir(), 'dsh-web-inspect-selftest-'));
  const pageUrl = pathToFileURL(PAGE).href;
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--allow-file-access-from-files',
    '--user-data-dir=' + profileDir,
    '--window-size=1280,800',
    '--virtual-time-budget=' + VIRTUAL_TIME_BUDGET_MS,
    '--dump-dom',
    pageUrl,
  ];

  log('dsh-web-inspect engine self-test');
  log('');

  if (!reportModuleLoading()) {
    failRun('lib/inspector.js failed the module-loading compatibility checks');
  }

  log('  chrome : ' + chrome);
  log('  page   : ' + pageUrl);
  log('  profile: ' + profileDir);
  log('');

  const result = await runChrome(chrome, args);
  const cleanup = () => {
    if (keep) return;
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  if (result.spawnError) {
    cleanup();
    failRun('failed to spawn Chrome: ' + result.spawnError.message);
  }
  if (result.timedOut) {
    cleanup();
    failRun('Chrome timed out after ' + WALL_TIMEOUT_MS + 'ms', result.stderr.slice(-4000));
  }
  const text = extractResult(result.stdout);
  if (text == null) {
    cleanup();
    failRun(
      'could not find <pre id="result"> in --dump-dom output (chrome exit ' + result.code + ')',
      'stdout tail:\n' + result.stdout.slice(-4000) + '\nstderr tail:\n' + result.stderr.slice(-4000),
    );
  }

  log(text.trimEnd());
  log('');
  log('---');

  const summary = text.match(/SUMMARY:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
  if (!summary) {
    cleanup();
    failRun('test page finished without a SUMMARY line', text.slice(-4000));
  }
  cleanup();

  const passed = Number(summary[1]);
  const failed = Number(summary[2]);
  log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0 || passed === 0) {
    log('SELFTEST FAIL');
    process.exit(1);
  }
  log('SELFTEST PASS');
  process.exit(0);
}

main().catch((err) => failRun('unexpected runner failure: ' + (err && err.stack ? err.stack : err)));
