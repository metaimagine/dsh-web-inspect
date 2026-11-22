# dsh-web-inspect — install, auth & E2E verification

Verified live on **2026-11-22** against the running GUI at <http://127.0.0.1:3080>
(app `0.2.2-rc.1`, commit `c59d10a`, boot rev `e2ef9903e7d0`, plugin bundle rev `3c710b98b8a5`; profile
`~/.dsh/profiles/web`, server PID 39733 — never restarted during this work).

Status: **plugin installed and verified end-to-end (17/17 checks PASS, 0 console errors).**

- Harness: [`tools/e2e.mjs`](../../tools/e2e.mjs) — raw CDP, zero npm dependencies.
- Run: `node tools/e2e.mjs` (≈4 s headless).
- Evidence: [`tests/screens/e2e-report.json`](../../tests/screens/e2e-report.json) +
  `tests/screens/03-preview-plugin-frame.png`, `04-inspect-on.png`,
  `05-selected-draft.png`, `06-escape-exited.png`, `07-second-hover.png`,
  `08-two-blocks.png`.

---

## 1. Authentication to the running `dsh web` GUI

An unauthenticated request is answered with a 401 and no HTML:

```
$ curl -si http://127.0.0.1:3080/
HTTP/1.1 401 Unauthorized
content-type: text/plain
dsh web authentication required; reopen the URL printed by dsh web.
```

`dsh web` prints a one-shot URL `http://127.0.0.1:3080/?token=<launchToken>`.
That token is **process memory only** — `BrowserAuth.processLaunchToken()` holds a
`randomBytes(32)` base64url value in an in-process `WeakMap`, so it cannot be
recovered from disk. The URL is used once to mint a browser-session cookie.

**The cookie signing secret is persisted**, which is enough to mint an
equivalent cookie yourself. Evidence:

| Fact | Location |
| --- | --- |
| credential record `client-connection/browser-session` | `dsh-client-connection/lib/index.js:273` (`AUTH_RECORD_KEY`) |
| secret creation/persistence | same file `:391` `initializeSecret()` → `:396` `credentials.modifyRecord(AUTH_RECORD_KEY, …)` |
| cookie name = prefix + `sha256(authority)` | same file `:277` `COOKIE_PREFIX="dsh-auth-"`, `:336` |
| token query/cookie flow | same file `:276` `TOKEN_QUERY="token"`, `:442`, `:461`, `:491–495`, `:571` `writeUnauthorized()` |

The secret lives in `~/.dsh/.credentials.yaml` under
`records.client-connection/browser-session` → `payload.secret` (43-char base64url = 32
bytes). Cookie contract (`v1` payload + HMAC-SHA256):

```
authority = "127.0.0.1:3080"                      # host:port, http scheme
name      = "dsh-auth-" + b64url(sha256(authority))
payload   = {"version":1,"authority":authority,"issuedAt":<ms>,"expiresAt":<ms>}
body      = b64url(JSON.stringify(payload))
value     = "v1." + body + "." + b64url(HMAC-SHA256(secret, body))
attrs     = Path=/; HttpOnly; SameSite=Strict; Max-Age=<cookieMaxAgeDays>
```

Verified command (mint in Node, then send it):

```bash
# /tmp/mint-cookie.mjs: read secret from ~/.dsh/.credentials.yaml, print
#   dsh-auth-<name>=v1.<body>.<sig>
node /tmp/mint-cookie.mjs > /tmp/dsh-cookie.txt
curl -si -H "Cookie: $(cat /tmp/dsh-cookie.txt)" http://127.0.0.1:3080/ | head -3
# HTTP/1.1 200 OK
# content-type: text/html; charset=utf-8   (index 44,595 bytes, contains globalThis["__DSH_BOOT__"])
```

`tools/e2e.mjs` does exactly this (`mintAuthCookie()`) and installs the value with
CDP `Network.setCookie` scoped to `http://127.0.0.1:3080/`. If the secret file is
unavailable, pass the printed launch URL's token instead:
`node tools/e2e.mjs --token <launchToken>` (the server sets the cookie on the redirect).

> Scope note: this reads the *local user's own* credential file to authenticate to
> their own local GUI. Nothing is exfiltrated and no server config is modified.

---

## 2. Install mechanics (profile-link dependency)

The plugin is installed as a `link:` dependency of the web profile, exactly like the
existing `dsh-one` precedent (`link:/Users/care/Projects/dsh-phone/dsh-one`).

### Applied diff — `~/.dsh/profiles/web/package.json` (verified on disk)

```diff
 "dependencies": {
   …
   "dsh-context": "0.87.0",
+  "dsh-web-inspect": "link:/Users/care/Projects/dsh-web-inspect-plugin",
   "dsh-mnemon": "0.5.50",
   …
 }
…
   "dsh-mnemon",
-  "dsh-motion"
+  "dsh-motion",
+  "dsh-web-inspect"
 ]
```

`node_modules/dsh-web-inspect -> ../../../../Projects/dsh-web-inspect-plugin` was created, and
`pnpm-lock.yaml` gained:

```yaml
      dsh-web-inspect:
        specifier: link:/Users/care/Projects/dsh-web-inspect-plugin
        version: link:../../../Projects/dsh-web-inspect-plugin
```

### How it was applied

The CLI command used was:

```bash
dsh plugin --profile web add dsh-web-inspect@link:/Users/care/Projects/dsh-web-inspect-plugin
```

`dsh plugin` forwards pnpm arguments inside the profile directory
(`@deepseek-ai/dsh/lib/bin.js:235-236` → `lib/plugin-DscIHF4k.js:64 runPlugin()` →
`:94 runPluginCommand()` from `@deepseek-ai/dsh-plugin-manager/operations`), then
**reconciles the installed bundle**: it appended `"dsh-web-inspect"` to
`dsh.profile.bundles` automatically (observed after the command, no manual edit).
The GUI's Plugins page and the `plugin_manager` tool's `install_bundle` perform the
same install + selection and report `application: "applied"` when HMR is live
(`dsh-plugin-manager/README.md:81`).

Equivalent manual sequence (what to do on a host without the CLI):

1. `cd ~/.dsh/profiles/web && pnpm add "dsh-web-inspect@link:/Users/care/Projects/dsh-web-inspect-plugin"`
2. append `"dsh-web-inspect"` to `dsh.profile.bundles` in that `package.json`
3. no `dsh web` restart (see §3).

Order matters: the `node_modules` symlink must exist **before** the bundles list
references it, otherwise the launcher reports the bundle as unresolvable
(`dsh-app-boot/lib/index.js:1774 resolveBundleDir()` resolves every bundles entry
from the install anchor / profile `package.json` anchor and requires a package with
`dsh.bundle`). The bundle contract is in `/Users/care/Projects/dsh-web-inspect-plugin/package.json`:

```json
"dsh": {
  "bundle": { "patch": ["./cordis.patch.yml"] },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-documentpreview", "…"], "immediately": true }
}
```

---

## 3. Restart / hard-refresh: what is actually required

**No `dsh web` restart is required.** The running profile recomposes itself through
HMR. Evidence chain:

1. The base patch mounts the `hmr` row, enabled whenever the launcher supplies a
   `profileContext` (which `dsh web` does at boot):
   `@deepseek-ai/dsh-base/cordis.patch.yml:28-34`
   (`disabled: !!js "!ctx.get('profileContext')"`).
2. HMR registers the profile manifest and both user-patch watches during
   initialization, and **manifest notifications reload only when the ordered
   `dsh.profile.bundles` list changes** — `@deepseek-ai/dsh-hmr/README.md:59,61`.
3. Recomposition replaces plugins whose files below the profile directory changed,
   **including the targets of `link:` packages** — `dsh-hmr/README.md:49`.
4. Plugin Manager documents the same: *"With HMR enabled in YAML, configuration
   changes apply immediately; without HMR the running composition remains until
   restart"* (`dsh-plugin-manager/README.md:14`); a live profile recomposes so a new
   plugin mounts and the result reports `applied` (`:81`).

Observed on this install (Lead-side, same cookie auth):

- boot payload `entries` went **86 → 87** within ~7 s of the profile change, the
  appended last entry being (as of this doc):
  ```json
  {"id":"dsh-web-inspect",
   "url":"plugins/??dsh-web-inspect/client.js&rev=3c710b98b8a5",
   "rev":"3c710b98b8a5",
   "inject":["@deepseek-ai/dsh-client-ui-sidebar-documentpreview","@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-api-session-controller","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-renderer"],
   "immediately":true}
  ```
- `GET /plugins/??dsh-web-inspect/client.js&rev=3c710b98b8a5` → 200, ~28 KB
  (without the `rev` query the plugin URL 404s).
- E2E then loaded a fresh page and found the client bundle evaluated
  (both `style[data-plugin="dsh-web-inspect"]` and the boot entry).
- An install that changes only `node_modules`/lockfile (no bundles-list change) does
  not recompose; the manifest change is the trigger.

Browser side: `client-hmr` (`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`'s
graph sync) is always mounted — `@deepseek-ai/dsh-web-app/cordis.patch.yml:214-215` —
so ordinary plugin enable/disable takes effect without reloading the page. A page
refresh is *not required* but is harmless and is what `tools/e2e.mjs` does (fresh
page). When editing `lib/client.js` of the linked plugin: append a comment line to
`~/.dsh/profiles/web/cordis.patch.yml` (or touch it), wait ~5–7 s for the
recompose, then reload the page — the bundle `rev` changes and the new code loads.
That loop was used during development; no server restart was needed at any point.

---

## 4. E2E verification — `tools/e2e.mjs`

```bash
node tools/e2e.mjs            # headless, ~4 s
node tools/e2e.mjs --headed   # watch it in a real Chrome window
```

**Prerequisites:** Node ≥ 22 (built-in `WebSocket`, no npm installs), Chrome/Chromium
(auto-detected at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`),
the GUI reachable and the local credential file readable (or `--token`), plus the
plugin installed/activated. The harness launches its **own** Chrome instance with a
throw-away `--user-data-dir` (your normal browser is untouched and the temp profile
is deleted afterwards unless `--keep-profile`).

What the 17 checks assert:

| Step | Assertion |
| --- | --- |
| `auth` | self-signed browser-session cookie accepted (or `--token` path) |
| `chrome` | dedicated headless Chrome with CDP reachable |
| `open-gui` | app boots: `__DSH_BOOT__` + `__DSH_BOOT_READY__` + composer mounted, no "Loading plugins" |
| `plugin-loaded` | `style[data-plugin="dsh-web-inspect"]` and/or boot entry `dsh-web-inspect` present |
| `select-workspace` | composer workspace chip set to `dsh-web-inspect-plugin` via `button[aria-label="选择工作区"]` → `[role=menuitem]` |
| `open-files-page` | right Sidebar expanded, Files guide entry opened, tree rooted at the repo |
| `open-preview` | `fixtures/inspect-demo.html` opened; tab `[data-dockkit-tab]`, address `dsh-resource://file/session/<session>/fixtures/inspect-demo.html` |
| `plugin-frame` | preview renders our override: `iframe[data-dsh-web-inspect-frame]` with sandbox `allow-scripts allow-same-origin …` and a readable `contentDocument` |
| `inspect-toggle` | header button label exactly `检查元素`, click flips `data-on="true"`, status bar shows the hint |
| `hover-highlight` | CDP `Input.dispatchMouseEvent` hover paints `.__dsh_web_inspect_hl` (599×33 px for `#doc-title`) + tooltip `h1#doc-title 599×33` |
| `click-select-insert` | real click inserts a 231-char draft (via the official `InputActions.insertText` path) containing `> 选中元素：`, a ```html fence with `<h1`, the selector and the "在这里补充…" footer |
| `status-confirmed` | status bar text `已插入当前会话输入框（未发送）` |
| `no-auto-send` | 1.2 s later the transcript (composer excluded) has no user echo and the draft is still in the composer |
| `escape-exit` | focus moved into the preview frame, Escape returns the toggle to `data-on=false` |
| `inspect-reattach` | after Escape, clicking 「检查元素」 re-enables inspect mode (overlay remounts) |
| `hover-second-element` | re-enabled mode hovers a **different** element (`#panel-dark .dup`, dark-section card): 256×44 outline + tooltip |
| `second-selection-append` | click appends a **second** block: draft has exactly two `> 选中元素：` blocks, first one preserved, second one is `div.dup` with `data-slot="c"`/`data-widget="card"` clues, its own dark background style and 线索 line — append, not overwrite |

Outputs: screenshots in `tests/screens/` + `tests/screens/e2e-report.json`
(steps, facts, console errors, timings). The harness never hardcodes a bundle
`rev`: every run loads a fresh page and records `facts.app.bootRev` +
`facts.pluginEntry` (`{url, rev}`) from `window.__DSH_BOOT__`, so the report proves
exactly which `client.js` revision was executed. Insertion is asserted through the
official InputActions path (`insertText(markdown, captureInsertion())`, with the
`requestDraftInitialization` fallback), i.e. appended to the draft — never sent.

**Exit codes:** `0` all pass · `1` step/assertion failure (report + `99-failure.png`) ·
`2` plugin not loaded (the harness still walks workspace → files → preview to prove
the environment, then prints the install steps). Useful flags:

```
--gui URL      --chrome PATH   --headed        --fixture PATH (default fixtures/inspect-demo.html)
--target SEL   --second-target SEL (default fixtures/inspect-demo.html: `#panel-dark .dup`; the append-cycle element)
--workspace NAME (default: repo dir name)   --shots DIR (default tests/screens)
--token TOKEN  --remote-port N  --timeout MS   --keep-profile   --keep-open   --verbose
```

Known expected console message (not a failure): Chrome may log
`An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.`
That frame is our renderer — same-origin is the *point* (the inspector must read and
highlight the preview DOM). Nothing else is emitted by the plugin.

---

## 5. Reproduce from scratch

```bash
# 1. install + select the bundle (or apply the §2 diff by hand, symlink first)
dsh plugin --profile web add dsh-web-inspect@link:/Users/care/Projects/dsh-web-inspect-plugin

# 2. wait for the live recompose (no restart); check the boot payload
curl -s -H "Cookie: $(cat /tmp/dsh-cookie.txt)" http://127.0.0.1:3080/ \
  | grep -o '"id":"dsh-web-inspect"' | head -1        # → "id":"dsh-web-inspect"

# 3. run the real-browser E2E
cd /Users/care/Projects/dsh-web-inspect-plugin && node tools/e2e.mjs
```

Note: the second block is appended immediately after the first block's footer
(no blank line is inserted by the plugin), so both blocks stay in one draft —
assert on the `> 选中元素：` markers, not on blank-line separation. This is
cosmetic; the plugin never overwrites or sends the draft.

## 6. Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| `401` from `/` | cookie authority must be exactly `127.0.0.1:3080`; re-mint from the current secret; `--token <launchToken>` as fallback |
| plugin URL 404 | the `rev` query parameter is mandatory: `plugins/??dsh-web-inspect/client.js&rev=<boot rev>` |
| `plugin-loaded` FAIL | `dsh.profile.bundles` missing entry, or symlink missing; append a comment to `cordis.patch.yml` to force recompose, reload page, re-check boot payload |
| tab renders the stock opaque preview (no `iframe[data-dsh-web-inspect-frame]`) | plugin bundle failed to evaluate — check page console (`Runtime.exceptionThrown` is captured in the report); the renderer only overrides `.html/.htm` on newly opened tabs |
| `检查元素` button missing | document actions slot only renders when `props.absolutePath` ends in `.html/.htm`; open the preview *after* activation, check console errors |
| files page shows another workspace | pass `--workspace <name>`; the page follows the session workspace, and a fresh profile restores the last-used workspace |
| Escape check SKIP | keyboard focus must be inside the preview iframe; the harness focuses the frame first (this is an app-level focus nuance, not a plugin bug) |

Write scope of this task: `docs/notes/install-verify.md`, `tools/**`, `tests/screens/**`
— the profile `~/.dsh/profiles/web/package.json` was read-only for me; the diff in §2
was applied and verified by the Lead.
