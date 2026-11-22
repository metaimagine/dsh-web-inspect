# agent 怎么"搜"到我们：DSH 工具/插件发现机制调研

> 目标：把用户意图 → agent 的检索行为拆开，回答「一个 agent 在把 `改这个按钮/看这段 HTML` 拆成子任务后，会去**哪里**、用**什么词**搜工具，我们 `dsh-web-inspect` 0.1.0 现在**能不能被搜到**」，并给可落地的元数据清单。
>
> 标注规则：**【实测】**＝有命令输出 / 文件行号 / API 返回；（无实测依据的机制推理）**【推断】**＝写明理由。
> 环境：本机 DSH `0.2.2-rc.1`（`dsh --version`），profile `web`，`~/.dsh/profiles/web`，first-party 包 330 个；公网：npm registry、GitHub Search API（未授权，10 req/min）。实测时间 2026-11-22 19:25–19:35（+08:00）。

---

## 0. 先看结论

1. **agent 侧根本不存在"插件搜索引擎"这个工具。** 27 个 `dsh-tool-*` 里没有任何 market/plugin-search 工具（【实测】`ls $INST | grep '^dsh-tool-'`，见 §1.5）；`plugin_market` 工具只有挂载了 `dsh-experimental-plugin-market-bundle` 的 profile 才有，**本 profile 没挂载**，所以我在会话里看不到它（【实测】§1.2）。市场搜索（dshmarket）是 **GUI 面**，注册给 agent 的工具数是 0（【实测】§1.3）。
2. **agent 唯一自动"看见"的目录是 `<available_skills>`**：每轮由 `dsh-tool-skill` 以 user message 注入，一行 `` - `name`: description ``（【实测】§1.1）。一个**插件想进这个目录，只能自己注册一个 skill 条目**（first-party 的 `dsh-skill-badge` 就是这么干的，20 行代码）。
3. **市场索引里我们还不存在**：`data/plugins/metaimagine__dsh-web-inspect.yml` → **404**（【实测】§2.1）。所以两条市场路径（dshmarket 页 / `plugin_market` 工具）现在都搜不到我们。
4. **npm 搜索对我们完全无效**：13 条查询全部 **ABSENT**，连包名精确查询 `dsh-web-inspect` 在 size=250 里也是 **ABSENT**（【实测】§3）。npm 只适合"已知名字的精确安装"，不是发现渠道。
5. **GitHub 是唯一已经能搜到我们的渠道**：`dsh element inspector` → **rank 2/4**；`dsh web inspect` → **rank 5/20**；但 `dsh html preview`、`dsh plugin inspector`、`html preview inspector plugin` 全部 **ABSENT**（【实测】§4）。差距就出在**名字里的词**和 **topics**：三个竞品仓库名里带 `dsh-html-preview`，我们的是 `dsh-web-inspect`。

**如果只能改三处**（详细理由见 §6.4）：
1. **把 awesome-dsh-plugin 的 YAML 提上去**（现在 404）——这是"被市场搜到"的唯一入口，且索引里 `description` 是仅次于 `name` 的权重字段。
2. **GitHub topics 从 3 个补到 10 个**（现在只有 `dsh`/`dsh-plugin`/`inspector`；缺 `element-inspector`、`html-preview`、`css`、`devtools`、`dom`、`selector`、`web-ui`）＋仓库 description 保持 `Element inspector` 前置（已实测该词命中 rank 2）。
3. **README 首段加"何时用/何时不用"条件句 + npm description 词序前置**：agent 读 README 判断该不该用，读的是前 5 行。

---

## 1. 机制侧：这个环境里 agent 能"看见"什么、怎么搜

### 1.1 真·自动注入的目录：`<available_skills>`

【实测】`$INST/dsh-tool-skill/lib/index.js`：
- `:974-978` 组装 `<system-reminder>…<available_skills>…</available_skills>…`，`A skill is a reusable set of task-specific instructions.`；
- `:944` `const skills = snapshot.skills.filter(isModelInvocable)` —— 只列模型可调用的；
- `renderCatalogEntries`（`:1028`）每个条目**只有一行**：`` - `name`: description ``（name 用反引号包住，后跟冒号与单行 description，description 做文本转义）；
- 目录变化时用 `renderCatalogUpdate`（`:996-1008`）整体替换（`The available skill catalog changed. This complete catalog replaces…`）。

这套东西的来源（【实测】`$INST/dsh-skill-filesystem/README.zh.md` 根目录 rank 表）：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `<dshHome>/skills` |
| 500 | user-agents | `<agentsHome>/skills` |
| 600 | **bundled** | `$DSH_BUNDLED_SKILL_DIR` / 包自带的 provider |

**关键机制：插件可以注册自己的 skill provider，从而把一行描述塞进每个会话的 `<available_skills>`。**
【实测】`$INST/dsh-skill-badge/lib/index.js` 全文（53 行）：

```js
const CANDIDATE = { name: "dsh-badge", description: "Add the official “powered by dsh” badge …", invocation: { modelInvocable: true, userInvocable: true }, provider: PROVIDER_NAME, source: "bundled", resourceBase: RESOURCE_BASE, rank: BUNDLED_SKILL_RANK, locator: SKILL_BODY_URL }
const provider = { name: PROVIDER_NAME, list: () => Promise.resolve([CANDIDATE]), async get(_c) { … readFile(SKILL_BODY_URL, "utf8") } }
export const inject = ["skills"]
export function apply(ctx) { ctx.skills.registerProvider(() => provider) }
```
配套 `cordis.patch.yml` 只有一行 `- insert: [{ id: skill-badge, name: '@deepseek-ai/dsh-skill-badge' }]`。

→ 【推断，依据上述两个实测】`dsh-web-inspect` 的 host half 现在是 `export function apply() {}`（【实测】`lib/index.js:25-29`（`export function apply() {}` 在 :29），注释写明 "Nothing to register host-side"）。**如果我们加 `inject: ['skills']` + 一个 provider，就能让每个会话的目录里出现一行**，例如：
`- \`dsh-web-inspect\`: 用户指着右侧栏 HTML 预览里的某个元素要改样式/要选择器时，让用户在预览里点「检查元素」，选中结果会以折叠引用块进入输入框（含 selector/盒模型/计算样式）。`
这是**唯一**能让 agent 在没有任何搜索动作前就知道我们存在的机制。代价：host half 需要 `skills` 服务；预设没有 skill 能力时该行会等待而不是报错（【实测】`plugin_market` 的同款注释 `dsh-plugin-market/lib/types/tools.js:45-52`：`ctx.inject(['pluginMarket'], …)` "a preset can keep this row without the tool appearing"）。

### 1.2 `plugin_market` 工具：存在，但本 profile 没有

【实测】`$INST/dsh-plugin-market/lib/types/tools.js:54` 注册 `plugin_market`，`action: list_indexes | list_plugins | list_versions`；`:60-63` 的 `query` 参数原文：
> "words to match **fuzzily against bundle names, titles, descriptions, authors, keywords, categories, and labels** in every language; results are ordered by best match."

【实测】它只在 `pluginMarket` 服务存在时注册（`apply(ctx){ ctx.inject(['pluginMarket'], …) }`），而该服务来自 `dsh-experimental-plugin-market-bundle` 的 patch。本机 profile 的 bundles 列表（`~/.dsh/profiles/web/package.json`）是：`dsh-base, dsh-web-app, dsh-experimental-auto-review, dsh-experimental-agent-team-profile, dsh-mobile, dsh-one, dshmarket, dsh-trust-check, billion-context, dsh-context, dsh-mnemon, dsh-motion, dsh-web-inspect` —— **没有 plugin-market bundle**；我本会话的工具列表里也确实没有 `plugin_market`。

→ 【实测+推断】默认用户装 DSH 后，**agent 没有"搜插件市场"这个动作**；除非用户手动加了索引源并挂载该 bundle。所以"提高被搜到的概率"的主战场不在 `plugin_market`。

### 1.3 dshmarket（GUI「插件市场」）的检索：字段与权重（无 agent 工具）

【实测】`grep -rn "ctx.tools.register" ~/.dsh/profiles/web/node_modules/dshmarket --include=*.js` → 无命中；`package.json` 的 `dsh` 只有 `bundle.patch` 与 `client`。**它不向 agent 暴露任何工具**。

【实测】`~/.dsh/profiles/web/node_modules/dshmarket/client/client.js`：
- `:3694-3698` 权重常量：`WEIGHT_NAME = 700`、`WEIGHT_OWNER = 400`、`WEIGHT_PREFERRED_DESCRIPTION = 280`、`WEIGHT_OTHER_DESCRIPTION = 240`、`WEIGHT_CATEGORY = 180`；
- `:3740-3766` `pluginRelevance()` 参与打分的字段**只有 4 类**：`plugin.name` / `plugin.npm`（700）、`plugin.owner`（400）、`description[lang]`（首选语言 280，其它语言 240）、`category` id 与本地化 category label（180）；
- **`keywords` 不参与**：该函数体内没有任何 `keywords` 读取（我逐行看过 3740-3766）；
- **README/Markdown 文档不参与**（同上，函数只碰 description）；
- `:3622` `searchText()`：NFKC、小写、汉字/拉丁边界插空格、标点折空格；
- `:3768` `comparePlugins()`：relevance 降序 → 用户选的 sort（downloads/stars/added）→ 索引原顺序。

→ 【实测结论】在 GUI 市场里：**搜哪些字段** = name/npm、owner、description、category/label；**是否只匹配名字前缀** = 否（是子串+整词加权，`searchText` 归一化后匹配）；**description 是否参与** = 是（280/240，仅次于 name）；**有没有排序权重** = 有，见上常量。

### 1.4 CLI：`dsh plugin` 没有 search/list，只有 pnpm 转发

【实测】`dsh plugin --help` 原文：
```
Usage: dsh plugin [options] [args...]
manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory
Arguments: args   pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)
Options: --profile <name>
```
→ **没有 `search`、没有 `list`、没有 `info`**。agent 想装插件只能 `add <精确包名|git url|tarball>`。这也意味着：CLI 的"检索"能力完全等于 **npm 解析能力**（见 §3）。【推断】所以 agent 在 bash 里更可能直接 `npm view <name>` / `npm search` / `curl registry`，而不是 `dsh plugin search`（不存在）。

### 1.5 first-party 330 包里没有"工具/插件检索"工具

【实测】`$INST` 下 `dsh-tool-*` 共 **27** 个：
`ask-user, bash, bash-persistent, call-timeout-policy, cordis, executor-native, executor-ptc, fs, fs-search, goal, jobs, present, pwsh, pwsh-persistent, ralph, schedule, session-query, skill, str-replace-editor, subagent, subagent-control, terminal, todo, web, workflow, working-directory, workspace-dependencies`

与"检索"沾边的只有：`dsh-tool-web`（web_search）、`dsh-tool-fs-search`（文件搜索）、`dsh-tool-skill`（加载 skill）、`dsh-skill*`（skill 注册表/提供方）。**没有任何 marketplace / plugin-search / capability-lookup 工具**（`ls $INST | grep -iE 'market|skill|search|plugin'` 里除了 `dsh-plugin-market*` 是 host 服务、`dsh-client-ui-*` 是 GUI 面，其余都不是 agent 工具）。

→ 结论【实测】：agent 拆完子任务后，**能"搜工具"的只有三条路**：① 看 `<available_skills>`（被动注入）；② `web_search`（公网，命中 GitHub/npm 网页）；③ `bash` 里打 npm registry / GitHub API。**第 3 条正是本文件其余章节在量的东西。**

---

## 2. 市场索引：真实来源与字段

### 2.1 索引从哪来

- 【实测】dshmarket 读 npm 包 `dsh-plugin-catalog` 的 `index.json`（`dshmarket/lib/catalog-npm.js` 注释：catalog 原托管 GitHub Pages，因国内 GitHub 代理 403 改为发布 npm 包并读 `dist.tarball`）。
- 【实测】`plugin_market` 工具读的是**用户配置的索引源 URL**（默认空）。
- 【实测】社区索引 = `awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/*.yml`，README 由脚本生成。
- 【实测】官网 `https://awesome-dsh-plugin.com/` 是**静态页**：1.76 MB HTML，内联了一份 JSON-LD `ItemList`（我 grep 到 `"position":7961` 这类条目，8000+ 条）；页面里有 `type="search"` 输入框但**没有可调用的 JSON 搜索 API**（grep `fetch('/api/…')` 无命中）→ 搜索是浏览器端对这份内联列表做过滤。【推断】agent 不可能"搜"这个站，除非它把 1.76 MB HTML 拉下来自己过滤——现实中不会发生。

**我们现在的状态**【实测】：
```
GET https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/plugins/metaimagine__dsh-web-inspect.yml → 404
GET https://registry.npmjs.org/dsh-web-inspect → versions: 0.0.0-stage, 0.1.0 (modified 2026-11-22T10:59:03.570Z)
```
→ **npm 有包、市场索引没有条目**。两条市场路径都搜不到。

### 2.2 一个索引条目的字段（谁能被搜到）

【实测】`$INST/dsh-plugin-market-index/README.md:29` 解析行为：成功结果会"drop members the format does not define, fills absent `metadata` groups, **`keywords`**, `labels`, `sortKeys`, and `engines` with empty values, orders each plugin's `versions`…"。

| 字段 | 谁在搜它 | 权重/作用 |
|---|---|---|
| `name`（`owner/repo`） | dshmarket + `plugin_market` | 700（最高） |
| `npm` | dshmarket（`plugin.npm`） | 700 |
| `title` | `plugin_market` | 与 name 同档（MiniSearch `boost.name/title = 3`） |
| `description.en` / `.zh` | 两者都搜 | 280（首选语言）/240（其它） |
| `category` + `labels` | 两者都搜 | 180（含本地化标题） |
| `keywords` | **仅 `plugin_market`** | dshmarket 不读（见 §1.3） |
| `author` | 仅 `plugin_market` | dshmarket 用 `owner`（400） |
| README / icon / versions | 都不进搜索 | 只影响详情页展示 |

【推断，依据 `market-submission.md` 里记录的规则 + README "由脚本生成"】索引进 description 时会截断到 160 字符，所以**关键词必须前置**。

---

## 3. npm 侧实测：搜索对我们零命中

方法：`https://registry.npmjs.org/-/v1/search?text=<q>&size=25`（`npm search` 走同一个 API，实测结果一致）。判定：返回列表里有没有 `dsh-web-inspect`。

【实测】13 条查询，**全部 ABSENT**：

| 查询词 | total | 我们的名次 | 榜首（说明我们被谁挤掉） |
|---|---|---|---|
| `dsh plugin` | 344,599 | — | dsh-plugin-shop-catalog |
| `dsh element inspector` | 2,582,279 | — | @deepseek-ai/dsh-experimental-inspector-profile |
| `dsh inspector` | 40,115 | — | @deepseek-ai/dsh-experimental-inspector |
| `element inspector` | 2,581,380 | — | @mobilewright/inspector |
| `html preview inspector` | 318,347 | — | @eslint/config-inspector |
| `css selector inspector` | 218,080 | — | css-selector-inspector |
| `dsh devtools` | 46,579 | — | @zhangzhian/dsh-devtools-git |
| `dsh web inspect` | 342,237 | — | @deepseek-ai/dsh-experimental-client-ui-agent-team |
| `inspect element ai agent` | 2,599,013 | — | @deepseek-ai/dsh-experimental-client-ui-agent-team |
| `dsh dom inspector` | 141,032 | — | vite-plugin-vue-inspector |
| `dsh preview plugin` | 400,823 | — | @deepseek-ai/dsh-spill-policy |
| `dsh plugin ui` | 580,717 | — | dsh-plugin-ui-zoom |
| `deepseek harness plugin` | 359,936 | — | dsh-plugin-catalog |

更狠的一条【实测】：
- 精确包名 `text=dsh-web-inspect`，`size=25` → **ABSENT**；`size=250` → **仍 ABSENT**。榜首是 `@deepseek-ai/dsh-experimental-client-ui-agent-team`、`object-inspect`、`@deepseek-ai/dsh`。
- 关键词限定查询 `text=keywords:dsh-plugin inspector`（total 16,816）→ **ABSENT**；榜首 `dsh-builtin-toggles`、`dsh-agent-crew-tool-map-ui`。

【实测】`score.detail` 只有三个维度，没有"文本相关性"这一项：
```json
{"name":"@deepseek-ai/dsh-experimental-inspector-profile","score":{"final":116.41,"detail":{"popularity":1,"quality":1,"maintenance":1}}}
```

【推断】包名精确查询也搜不到的两个可能：① npm 搜索索引有滞后（我们 `time.modified = 10:59:03Z`，查询在 11:30Z 左右，发布约 30 分钟）；② npm 的 text-search 把 `dsh-web-inspect` 按词拆开并按 popularity/quality 排序，冷启动包被 2.5 万条 `has-tostringtag` 之类挤到 250 名之外。**两者都要按"不能依赖 npm 搜索"来设计**，并建议 **24 小时后复测一次**（命令见附录 A）。

---

## 4. GitHub 侧实测：能搜到，但只在"名字对得上"的查询里

方法：`https://api.github.com/search/repositories?q=<q>&per_page=10`（未授权，best-match 默认排序）。

【实测】

| 查询词 | total | 我们的名次 | 备注 |
|---|---|---|---|
| `dsh element inspector` | 4 | **2** | 第 1 是 `muyuanjin/dsh-element-inspector`（名字更准） |
| `dsh web inspect` | 20 | **5** | 前 4 里 2 个名字含 `inspect/or` |
| `folded reference chip`（description 里的短语） | 3 | **2** | 证明 **description 进默认文本搜索** |
| `dsh html preview` | 33 | — | 前 6 有 3 个仓库名就叫 `dsh-html-preview` |
| `dsh plugin inspector` | 26 | — | 前 5：CocoSgt/dsh-inspector、webkubor/dsh-env-inspector… |
| `html preview inspector plugin` | 2 | — | 完全不命中 |
| `element inspector agent` | 13 | — | 前 5 全是浏览器扩展/无关项目 |
| `folded reference chip in:readme` | 24,473 | — | **README 短语反而不命中**（见下） |
| `topic:element-inspector dsh` | 2 | — | 我们**没有**该 topic → 直接出局 |

我们仓库当前元数据【实测】`GET /repos/metaimagine/dsh-web-inspect`：
```json
description: "Element inspector for the DSH right-sidebar HTML preview: hover-highlight, click-select, insert the element context as a folded reference chip."
topics: ["dsh","dsh-plugin","inspector"]
stars: 0, created: 2026-11-22T10:50:13Z, pushed: 2026-11-22T11:04:59Z
```

→ 三条【实测】结论：
1. **词在 description 里就够，词在 README 里不够**（`in:readme` 那条 24k 结果里我们不在前 10；而同一短语在 description 里排第 2）。【推断】README 索引滞后或默认搜索不覆盖 README 全文，**不要指望 README 的 SEO**。
2. **topics 是"过滤器"而不是"文本"**：`topic:element-inspector dsh` 只有 2 条且没有我们——topic 只在用 `topic:` 限定符时才生效，普通自由文本查询里不吃 topic 的词。【推断】依据：我们 3 个 topics 里含 `inspector`，但 `dsh plugin inspector` 查询照样不命中。
3. **名字 > 描述**：`dsh html preview` 我们 ABSENT，而 3 个叫 `dsh-html-preview` 的仓库占据前排 → 名字里的短语是硬通货，description 只能补位。

---

## 5. 意图 → 查询词侧写（重点）

### 5.1 用户会说的话（22 条，中英各半）vs agent 实际会敲的词

> 表里「搜得到吗」按实测渠道记：`M`=市场（当前索引无我们→必然 M:✗）、`npm`、`GH`。「缺什么」= 要补的字段/措辞。

| # | 用户原话 | agent 推断的查询词 | 搜得到吗 | 缺什么字段/措辞 |
|---|---|---|---|---|
| 1 | 帮我把**这个卡片**圆角改大一点 | `dsh plugin element picker` / `ui element select plugin` | M:✗ npm:✗ GH:✗ | name 无 `picker`；topic 无 `element-picker` |
| 2 | 这个按钮的 padding 不对，你自己看 | `dsh inspect element tool` | M:✗ npm:✗ GH:**2/4** | 基本盘已有（description 的 Element inspector） |
| 3 | 我要这个块的 CSS 选择器 | `css selector from page plugin` / `dsh css selector` | M:✗ npm:✗ GH:✗ | 缺 `css`、`selector` 关键词 |
| 4 | 看下我这段 HTML 的结构哪里嵌套错了 | `html structure inspector` | M:✗ npm:✗ GH:✗ | 缺 `html-structure` 措辞 |
| 5 | 把预览里这个 div 的宽高告诉我 | `element size box model plugin` | M:✗ npm:✗ GH:✗ | 缺 `box-model`/`computed-style` 词 |
| 6 | 我在右侧栏预览页面，想标一下这块 | `dsh sidebar preview annotate` | M:✗ npm:✗ GH:✗ | 缺 `sidebar`/`preview`/`annotate` |
| 7 | 引用页面里这一段内容给你 | `quote element from preview plugin` / `folded chip` | M:✗ npm:✗ GH:✗（`folded reference chip` 只有自由短语命中 2/3） | 缺 `quote`/`reference` 词；chip 是内部术语 |
| 8 | 这个 class 的样式是哪来的 | `computed style inspector` | M:✗ npm:✗ GH:✗ | 缺 `computed-style` |
| 9 | 帮我改这个 SVG 的填充色 | `svg element inspector plugin` | M:✗ npm:✗ GH:✗ | 无 `svg` 词 |
| 10 | 我不想再手抄 CSS 了 | `devtools inspect for ai agent` | M:✗ npm:✗ GH:✗ | 缺 `devtools`（topic 也没有） |
| 11 | 这个表格的行高不对 | `table row height css plugin` | M:✗ npm:✗ GH:✗ | 属于长尾，靠 `css`+`element` 兜 |
| 12 | 点一下页面元素就发给模型，有这种插件吗 | `click element send to agent plugin` | M:✗ npm:✗ GH:✗ | 缺"click to send"这类动作词 |
| 13 | Make **this** card rounder | `dsh element inspector` | M:✗ npm:✗ GH:**2/4** | ✅ 已覆盖 |
| 14 | Give me the selector for this block | `css selector inspector` | M:✗ npm:✗ GH:✗ | 缺 `selector` 关键词/topic |
| 15 | Inspect the DOM of my preview | `dom inspector plugin` | M:✗ npm:✗ GH:✗ | 缺 `dom` |
| 16 | Why is this element 320px wide? | `element width inspector` | M:✗ npm:✗ GH:✗ | 缺 `size`/`box-model` |
| 17 | Let the agent see the page I'm previewing | `html preview inspector plugin` | M:✗ npm:✗ GH:**0/2** | 缺 `html-preview` 组合词（名字里没有） |
| 18 | I want to point at an element instead of describing it | `point and click element for llm` | M:✗ npm:✗ GH:✗ | 缺 `point-and-click`/`llm` 措辞 |
| 19 | Send this section's HTML to the chat | `send html element to chat plugin` | M:✗ npm:✗ GH:✗ | 缺 `send`/`chat` 动作词 |
| 20 | 有没有类似 Chrome 审查元素的东西 | `chrome devtools like inspector dsh` | M:✗ npm:✗ GH:✗ | 缺 `chrome-devtools` 类比词（README 有，搜索不吃） |
| 21 | 预览里的 flex 布局错了 | `flex layout debug preview plugin` | M:✗ npm:✗ GH:✗ | 长尾，不追 |
| 22 | 这个 z-index 谁压谁 | `z-index stacking inspector` | M:✗ npm:✗ GH:✗ | 长尾，不追 |

【推断，理由：实测的 query→rank 数据 + 竞品名称分布】agent 的查询词有几条稳定规律：
- **先搜"能力名词 + 框架名"**（`element inspector`, `html preview inspector`），很少搜动词（`annotate`/`quote`）；
- **会把用户的口语名词换成 UI 术语**（卡片→`card`，样式→`css`，选中→`picker`/`selector`）；
- **DSH 场景一定带 `dsh`**（因为是在 DSH 里找插件）；但"带 dsh"反而是我们最弱的区间（§3 全灭）。
- 命中我们的查询**只有一种形状**：`dsh` + `element inspector`（或 `dsh web inspect`）。也就是说我们目前只能被"知道要搜 inspector 这个词"的 agent 搜到。

### 5.2 实测命中的只有这两类

- 【实测】GH `dsh element inspector` → 2/4；GH `dsh web inspect` → 5/20。
- 【实测】npm 侧：**0 命中**（13 条 + 精确名 + keywords 限定）。
- 【实测】市场侧：**0 命中**（条目不存在，YAML 404）。

---

## 6. 结论：该写什么词（可执行清单）

### 6.1 优先级排序的 18 条"agent 真实会输入的查询词"

排序依据：实测命中（GH 已命中的排最前，因为它已被证明能把我们排上来）→ 竞品占位强度 → 词在用户口语里的出现频率。
字段缩写：`pkg.kw`=`package.json.keywords`、`pkg.desc`=`package.json.description`、`gh.desc`=GitHub repo description、`gh.topics`、`yaml.desc`=市场 YAML `description.en|zh`、`readme`=README 标题/首段。

| # | 查询词 | 落在哪 | 现状 | 说明 |
|---|---|---|---|---|
| 1 | `dsh element inspector` | `pkg.desc` 开头 + `gh.desc` 开头 + `yaml.desc.en` 开头 + `readme` H1 副标题 | ✅ 已有 | 唯一已实测命中（GH 2/4），**不要动它** |
| 2 | `element inspector` | 同上（去掉 dsh 也成立） | ✅ | 同上 |
| 3 | `dsh inspector` | `pkg.kw` 已有 `inspector`；`gh.topics` 已有 | ⚠️ 被官方 `@deepseek-ai/dsh-experimental-inspector` 压制（npm 榜首） | 补 `gh.desc` 里 `inspector` 与 `preview` 的同句出现 |
| 4 | `html preview inspector` | `pkg.kw` +`html-preview`（已有）`inspector`（已有）+ `gh.topics` +`html-preview` | ⚠️ 两词都有但从不"相邻" | 让 `html preview` 与 `inspector` 在 `pkg.desc`/`gh.desc` **同一句**出现 |
| 5 | `element picker` | `pkg.kw` +`element-picker`；`gh.topics` +`element-picker` | ❌ | 竞品 `ztlovelsw/dsh-ui-picker` 已占 `picker` |
| 6 | `css selector` | `pkg.kw` +`css-selector`、`selector`；`gh.topics` +`css`、`selector` | ⚠️ 只有 `css` | 用户会说"要个选择器" |
| 7 | `devtools` | `pkg.kw` 已有；`gh.topics` +`devtools` | ⚠️ | 类比词，是 agent 最爱的桥 |
| 8 | `inspect element` | `pkg.kw` +`inspect-element`；`readme` 首段 | ❌ | 英文动词式，和用户口语一致 |
| 9 | `dom` / `dom inspector` | `pkg.kw` +`dom`；`gh.topics` +`dom` | ❌ | |
| 10 | `computed style` | `pkg.kw` +`computed-style`；`pkg.desc`/`yaml.desc` 提一次 | ❌ | 我们确实发这个（`lib/client.js` 的 context 含 computed styles） |
| 11 | `box model` / `width height` | `pkg.kw` +`box-model`；`yaml.desc` 提 `W×H` | ❌ | 预览 tooltip 真显示 `W×H` |
| 12 | `sidebar` / `right sidebar` | `pkg.kw` 已有 `sidebar`；`gh.topics` +`sidebar` | ✅/⚠️ | 定位词 |
| 13 | `html preview` | `pkg.kw` 已有；`gh.topics` +`html-preview` | ⚠️ 名字里没有 → GH `dsh html preview` 33 条里我们不在前 10 | topics 是这里唯一的补救 |
| 14 | `web ui` / `web-client` | `pkg.kw` 已有 `web-client-plugin`；`gh.topics` +`web-ui` | ⚠️ | |
| 15 | `annotate` / `reference` | `yaml.desc.zh/en` 用"引用块/reference chip"表述 | ❌ | 用户说"标注/引用" |
| 16 | `quote element` | `readme` 条件句里写 "quote element"（官方叫 Quote text） | ❌ | 借官方术语 |
| 17 | `chrome devtools like` | `readme` 首段（已有 "same gesture as Chrome DevTools"） | ✅ README 有但**搜索不吃** | 只对人有用，别当 SEO |
| 18 | `click to send` / `send to agent` | `pkg.desc` 里 "click to select … to the current AI session" 已有近似 | ⚠️ | 动作词，别硬塞 |

### 6.2 README 里必须出现的条件句模板（agent 读 README 判断"该不该用"）

放在 H1 之后、`## Why` 之前，用一个 `## When to use` / `## 什么时候用` 块（中英两份镜像）：

1. 用户指着右侧栏 HTML 预览里的**某个具体元素**（"这个卡片/按钮/那块"），且需要它的 **selector / 尺寸 / 计算样式** → 用本插件。
2. 用户抱怨"改完对不上"，因为**口头描述元素**容易错（要手抄 class、量尺寸）→ 用本插件让他点一下。
3. 用户想把页面里的**某一段 HTML / 某个组件**作为引用发给 agent，并要求**不要自动发送**、只作为引用块进输入框 → 用本插件（与官方 Quote text 同款折叠 chip）。
4. 用户在做 **CSS 调试/布局排查**（flex、z-index、padding、边框、圆角、背景色），且页面就在预览里 → 用本插件取盒模型与计算样式。
5. 用户要**对比多个元素**（"这两个卡片为什么不一样"）→ 用本插件逐个点选，各自生成引用块。
6. **不要用**：用户要改的是 DSH **自身 UI**（插件行、设置页）而不是预览里的 HTML → 不要用（那是 `dsh-element-inspector` 那类"判断元素属于宿主还是插件"的工具）。
7. **不要用**：用户只是要读/写磁盘上的 `.html` 文件内容、或要跑构建 → 不要用（用 fs/终端工具）。
8. **不要用**：预览没开、或用户在别的面板里操作 → 本插件只在右侧栏文档预览 tab 生效。

### 6.3 反面清单（会误导 agent / 与实际能力不符 / 看似 SEO 实则无用）

**不许写的词（能力不符，写了会把 agent 引到错误期待）**
- `screenshot` / `element-screenshot`（我们**不截图**；`dsh-element-inspector` 才做 screenshot 与 hide）；
- `edit` / `live-edit` / `hot-reload`（插件**不改页面**，只把上下文塞进输入框）；
- `CDP` / `chrome-debug-protocol` / `debugger`（官方 `@deepseek-ai/dsh-experimental-inspector` 是 CDP hub，写这个会撞车并且不符）；
- `host-ui` / `plugin-ui-inspector` / `hide-element`（那是 `dsh-element-inspector` 的领域）；
- `test` / `e2e` / `automation`（我们不是测试工具）；
- `ai-agent-tool` 这类泛词（会跟 `dsh-find-plugin` 等"agent 找插件"的插件混淆）。

**看似 SEO、实际无效的动作**
- 【实测】往 `package.json.keywords` 里堆词：npm 搜索对我们 13 条查询全灭、连包名都不在前 250 —— **keywords 目前不产生任何检索收益**（唯一例外：`plugin_market` 的 `query` 会搜 keywords，而本 profile 没挂该工具）。保留 keywords 是给"将来挂载了市场"的场景，不要指望它带来发现。
- 【实测】往 README 里堆关键词：`in:readme` 精确短语查询我们排不进前 10 → README 不参与默认文本搜索。
- 【实测】只加 GitHub topics 不做别的：topics 只在 `topic:` 限定查询里生效（`topic:element-inspector dsh` 只有 2 条且无我们）。
- 【推断】在 README 里写"Chrome DevTools 同款手势"这类**类比**：对人有用，对检索无用（实测该短语不命中我们）。
- 【推断】给 npm 包加 `@scope`：会更难被 `dsh` 前缀查询命中（官方包全在 `@deepseek-ai/` 下，把我们挤下去）。

### 6.4 如果只能改三处

1. **提 awesome-dsh-plugin 的 YAML PR**（`data/plugins/metaimagine__dsh-web-inspect.yml`，现在 **404**）。这是"被市场搜到"的唯一入口；条目里 `description` 是 name 之外的最高权重字段（280/240），且会被截到 160 字符 → **关键词前置**，`Element inspector` 打头。（物料见 `docs/notes/market-submission.md`。）
2. **GitHub topics 3 → 10**：`dsh`, `dsh-plugin`, `inspector`, `element-inspector`, `inspect-element`, `html-preview`, `css`, `selector`, `devtools`, `dom`（+ 可选 `sidebar`, `web-ui`）。理由：`topic:` 查询是唯一能绕开"名字里没这个词"的过滤器，而我们现在在这条路上直接出局（`topic:element-inspector dsh` 2 条无我们）。
3. **`pkg.desc` / `gh.desc` / `yaml.desc` 三处让 `element inspector` 与 `html preview` 在**同一句**里相邻出现，并把 README 首段换成 §6.2 的条件句**。理由：实测命中只发生在 `dsh element inspector`；而 `html preview inspector` 类查询全灭的根因是这两个词在我们的元数据里从不相邻。

**（可选、非元数据）第四条杠杆**：给 host half 加一个 `skill` provider（§1.1 的 `dsh-skill-badge` 模式），把一行"何时用我"塞进每个会话的 `<available_skills>`。这是**唯一能让 agent 不做任何搜索就知道我们**的机制，但属于代码改动，不在本次"改元数据"范围内。

---

## 附录 A：复现命令

```bash
# npm 侧名次
curl -s "https://registry.npmjs.org/-/v1/search?text=dsh%20element%20inspector&size=25" \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const i=j.objects.findIndex(o=>o.package.name==="dsh-web-inspect");console.log(i<0?"ABSENT":i+1)})'

# GitHub 侧名次（未授权 10 req/min，务必 sleep 7）
curl -s "https://api.github.com/search/repositories?q=dsh+element+inspector&per_page=10" \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.items.map(i=>i.full_name).join("\n"))})'

# 我们是否已进市场索引
curl -s -o /dev/null -w "%{http_code}\n" \
 https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/data/plugins/metaimagine__dsh-web-inspect.yml

# 24h 后复测 npm 包名可见性（索引滞后验证）
curl -s "https://registry.npmjs.org/-/v1/search?text=dsh-web-inspect&size=250" \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const i=j.objects.findIndex(o=>o.package.name==="dsh-web-inspect");console.log(i<0?"STILL ABSENT":i+1)})'
```

## 附录 B：证据等级索引

- **实测（命令/行号/API）**：§1.1（`dsh-tool-skill/lib/index.js:955,974-978,1027`；`dsh-skill-filesystem/README.zh.md` rank 表；`dsh-skill-badge/lib/index.js` 全文）、§1.2（`dsh-plugin-market/lib/types/tools.js:54,60-63`；profile `package.json` bundles）、§1.3（`dshmarket/client/client.js:3694-3698,3740-3766,3622,3768`；无 `ctx.tools.register`）、§1.4（`dsh plugin --help` 输出）、§1.5（27 个 `dsh-tool-*` 列表）、§2.1（YAML 404、npm versions、awesome 站 1.76 MB 内联 JSON-LD）、§2.2（`dsh-plugin-market-index/README.md:29`）、§3（13 条 + 精确名 + keywords 查询的 API 返回、`score.detail`）、§4（6 条 GH 查询 + `in:readme`/`topic:` 对照 + repo 元数据）。
- **推断（已标理由）**：skill provider 能让我们进 `<available_skills>`（依据 badge bundle 的实测实现 + 我们 host half 现状）、npm 索引滞后 vs 排序压制（两种可能都要防）、README 不参与默认搜索（`in:readme` 反证 + 索引滞后可能）、topics 仅作过滤器（自由文本查询不命中）、市场 description 160 字符截断（依据 `market-submission.md` 记录）、`@scope` 更难命中。

---

**TL;DR 给 Lead**：agent 没有插件搜索工具（默认 profile 未挂 `plugin_market`；dshmarket 只服务 GUI，0 个 agent 工具）。它唯一自动看见的是每会话注入的 `<available_skills>`，插件可用 `ctx.skills.registerProvider` 挂进去。实测：npm 全灭（13 条查询，连包名都不在前 250）、市场 YAML 仍 404、只有 GitHub 命中（`dsh element inspector` 2/4）。三处必改：提 awesome YAML、topics 补到 10、三处 description 让 element inspector 与 html preview 相邻。
