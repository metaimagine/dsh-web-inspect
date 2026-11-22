/**
 * dsh-web-inspect — host half (no-build ESM Cordis plugin).
 *
 * Two jobs:
 *
 * 1. Register the bundled **skill provider** (`ctx.skills`) so the plugin shows up
 *    in every agent session's `<available_skills>` catalog — the only channel an
 *    agent inspects without searching. The catalog line is the routing sentence;
 *    the full instructions are loaded on demand from `assets/dsh-web-inspect.md`.
 *
 * 2. Keep the browser half discoverable: `package.json`'s `dsh.client` manifest is
 *    what the web client loads. The browser half (`./client`) does the real work:
 *      - overrides the builtin `.html/.htm` document-preview renderer with an
 *        extension-priority implementation whose iframe stays sandboxed to an
 *        opaque origin (`sandbox="allow-scripts"`),
 *      - adds the 「检查元素」 toggle to `sidebar.right.tab.document.actions`,
 *      - injects a self-contained highlight/tooltip runtime into the preview
 *        document and receives the selected element over postMessage, then
 *        converts it into a Markdown context block,
 *      - appends that block to the current session input as a folded reference
 *        chip (no auto-send).
 *
 * The provider is intentionally dependency-free: it does not import
 * `@deepseek-ai/dsh-skill` (a linked plugin resolves modules from its own
 * directory, not from the DSH install tree), so `rank` is the plain number that
 * sits below every first-party root (project 100/200, custom 300, user 400/500,
 * bundled 600) and the skill name is unique anyway.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'dsh-web-inspect'

/** Services required before the host half can activate. */
export const inject = ['skills']

/** Provider name reported back on every candidate/definition. */
const PROVIDER_NAME = 'dsh-web-inspect'

/** Kebab-case skill id; must satisfy the registry's skill-name grammar. */
const SKILL_NAME = 'dsh-web-inspect'

/**
 * Precedence rank for the skill candidate. Lower wins duplicate names.
 * 700 = below bundled (600) and every user/project root, so a first-party skill
 * that happens to redefine this name always wins. The name is unique here.
 */
const SKILL_RANK = 700

/** Markdown body loaded by the `skill` tool on demand. */
const SKILL_BODY_URL = new URL('../assets/dsh-web-inspect.md', import.meta.url)

/** Base used to resolve relative links inside the body. */
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
}

/**
 * Routing sentence: this is the single line an agent reads in
 * `<available_skills>` before deciding whether to load the skill, so it must
 * state both what the plugin does and when it does not apply.
 * Length must stay <= 500 chars (the host catalog truncates at 500).
 */
const DESCRIPTION =
  'Element inspector for the DSH right-sidebar HTML preview: hover-highlight, ' +
  'click to select, and send that element\'s CSS selector, HTML snippet, size and ' +
  'key computed styles into the current session as a folded reference chip. ' +
  'Use when the user points at a specific element in a previewed HTML page and ' +
  'needs its selector, dimensions, styles or structure. Do not use for ' +
  'whole-page layout redesigns, Markdown or non-HTML previews, test runs, or ' +
  'quoting plain text or files.'

/** Catalog candidate (also the locator: the body URL is enough). */
const CANDIDATE = {
  name: SKILL_NAME,
  description: DESCRIPTION,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'custom',
  resourceBase: RESOURCE_BASE,
  rank: SKILL_RANK,
  locator: SKILL_BODY_URL,
}

/** Borrowed same-process skill provider registered into the current layer. */
const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: CANDIDATE.resourceBase,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/**
 * Activate the host half: register the skill provider for this plugin's layer.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => provider), 'dsh-web-inspect: skill provider')
}
