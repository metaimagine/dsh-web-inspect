# dsh-market 的「SEO」：搜索/排序机制与可执行清单

> 回答「在 DSH 里搜插件时，什么决定 `dsh-web-inspect` 出现、排第几」。
> 全文分「已验证事实（带证据）」与「推断」；最后是已落地/待执行清单。
> 调查时间：2026-11-22。环境：本地 `dsh web`（app 0.2.2-rc.1）、
> `~/.dsh/profiles/web/node_modules/dshmarket`（v1.x，已安装），公网数据：npm registry、
> `dsh-plugin-catalog` 索引、awesome-dsh-plugin 仓库。

## 0. 一句话结论

只有**一份**索引（npm 包 `dsh-plugin-catalog` 里的 `index.json`，由 awesome-dsh-plugin 的
`data/plugins/*.yml` 生成）。dsh-market（「插件市场」插件）和宿主 Discover（「发现 → 索引源」）
**各自实现搜索算法**，但都读这同一份索引。能影响命中的字段只有：`name`、`title`（`owner/name`）、
`description.en/zh`、`category`/`labels`；`keywords`/`author` 字段虽然搜索端支持，但当前索引
**一条都没有填**（0/6487）。所以 SEO 的重点是 **awesome YAML 的 description（≤160 字符、
关键词前置）**，其次才是 npm/GitHub 的元数据。

## 1. 已验证事实

### 1.1 两条检索路径

| 路径 | 组件 | 搜索实现 | 索引来源 |
|---|---|---|---|
| 「插件市场」页（Tab） | dsh-market 插件 | 自研 relevance 打分（见 1.2） | 内置 npm 包 `dsh-plugin-catalog`（读 npm tarball） |
| 「发现（Discover）」页 + `plugin_market` 工具 | 宿主 `dsh-plugin-market` | MiniSearch（见 1.3） | 用户配置的索引源 URL（默认空） |

两条路径的数据是同一份 `dsh-plugin-catalog/index.json` —— 「发现」页需要用户在
**插件 → 发现 → 索引源** 添加 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`
（`~/.dsh/profiles/web/node_modules/dshmarket/README.zh.md:16`；该 README 明确说「同一份目录也是
一份插件市场索引」）。

### 1.2 dsh-market 插件市场的打分（`dshmarket/client/client.js`）

- 字段权重（`client.js:3694-3698`，用于 `pluginRelevance` `:3740-3766`）：
  `name`/`npm` **700**、`owner` **400**、偏好语言 `description` **280**、
  其它语言 `description` **240**、`category`（含本地化标题）**180**。
  **`keywords` 不参与**（评分函数不读该字段）。
- 字段内分档（`client.js:3707-3720`）：字段完全等于查询 = `weight + 300`；短语命中 = `+200`；
  多词查询全部词在同一字段 = `+150`；整词 +16；前缀不加分。
- 归一化（`client.js:3622-3626` `searchText`）：NFKC、小写、汉字/拉丁边界插空格、标点折空格。
- 同义词（`client.js:3727-3737`）：仅同义词命中的得分 = `floor(weight/10)`，永远低于字面命中。
- 过滤/排序（`client.js:3783-3812`）：有查询时 relevance 0 直接过滤；排序按
  relevance 降序 → 用户选择 sort（`comparePlugins :3776-3793`，downloads/stars/added）→ 索引原顺序。
  默认 UI 排序 `downloads-desc`（`client.js:12327-12330`）只影响「不输入查询的浏览」。
- 索引读取：`dshmarket/lib/catalog-npm.js:1-20` 注释——catalog 原托管 GitHub Pages
  `plugins.json`，因国内 GitHub 代理 403 改为发布 npm 包 `dsh-plugin-catalog`（读 `dist.tarball`），
  所以镜像/离线可用。

### 1.3 宿主 Discover 的检索（`$INST/dsh-plugin-market/lib/types/search.js`）

- MiniSearch 配置（`search.js:76-92`）：
  `fields: ['name','title','keywords','description','author','taxonomy']`，
  `searchOptions.boost = { name: 3, title: 3, keywords: 2 }`，
  `prefix: true`，`fuzzy: term => term.length >= 4 ? 0.2 : false`，`maxFuzzy: 2`，
  `combineWith: 'AND'`；`tokenize: searchTerms`（CJK 拆重叠双字），`processTerm: toLowerCase`。
- `taxonomy` = 该条目 `category` 与 `labels` 的中英标题数组（`search.js:92-100`）。
- 排序（`dsh-plugin-market/README.zh.md:62`）：`index` 按索引顺序；`relevance` 按文本匹配分；
  `published` 按发布时间；`key` 按声明排序键；同分保持索引顺序。
- 详情页会读「带图片的 Markdown 文档」（README 类），但**不进搜索字段**
  （`dsh-plugin-market/README.zh.md:12`）。
- 注意：`keywords`/`author` 在搜索配置里有权重，但当前索引条目这两个字段全为空，
  所以实际不产生分数（见 1.4）。

### 1.4 索引的真实数据（2026-11-22 抓取）

源：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`

- `format: 1`，`plugins` 共 **6,487** 条（这是「有 npm 包」的子集，全 catalog 12,519 条）。
- 每条字段：`name`、`title`(`owner/name`)、`description{en,zh,…}`、`homepage`、
  `repository{url,…}`、`metadata{category,keywords,labels,sortKeys}`、`versions[]`。
  **没有 `author` 字段**；`metadata.keywords` / `labels` / `sortKeys` 全部为空（0/6487）。
- `metadata.categories` 共 **23** 个分类，`ui` 的标题是 `{en:"UI Enhancements", zh:"UI 增强"}`。
  条目 `metadata.category` 就是搜索里的 `category` 维度。
- 索引条目的 `description` 由 awesome 的 `data/plugins/*.yml` 生成（yml schema 见 1.5）。
  队友独立阅读生成器 `market-index.mjs`（`awesome-dsh-plugin` 仓库）报告：
  生成时把 yml 描述截到 **160 字符**、**不含 keywords/author**；站点
  `build-site.mjs` 渲染详情页（含 README），`template.html` 的站内搜索是单一子串匹配
  （owner/short + 本地化 yml 描述 + 类目标签，无分词、无排名，默认 `dl` 排序）。
  *（这条属队友复核，Lead 未能拉取生成器源码交叉验证；不影响「description 前置关键词」的结论。）*

### 1.5 awesome-dsh-plugin 投稿 schema

文件：`data/plugins/<owner>__<repo>.yml`；一个 PR 只加一个文件；README 由脚本生成，不要手改。
示例（raw 抓取 `data/plugins/0-0-user__dsh-plan-note.yml`）：

```yaml
url: https://github.com/0-0-user/dsh-plan-note
name: 0-0-user/dsh-plan-note
category: workflow           # 必须是站点已声明分类 id
description:
  en: "..."                  # 英文（截断到 160 字符进索引）
  zh: "..."                  # 中文
icon: https://raw.githubusercontent.com/.../icon.png   # 可选
```

仓库另有 `data/downloads.json`（npm 近 30 天下载）、`data/added-dates.json`、
`data/capabilities.json`，进入卡片展示与排序打平项，不改查询 relevance。

### 1.6 npm 与 GitHub

- `dsh-web-inspect@0.1.0` 已发布；`npm view` 可读。
- 发布约 35 分钟后，`npm search dsh-web-inspect` / registry 搜索 API
  `https://registry.npmjs.org/-/v1/search?text=dsh-web-inspect` 仍查不到本包 —— npm 搜索索引
  与包元数据分离，新包入库有延迟（npm 官方文档：搜索索引包含 README，新包最长 2 周收录，
  docs.npmjs.com/searching-for-and-choosing-packages-to-download）。
- npm 搜索排序按 popularity / quality / maintenance 加权（搜索 API 返回 `score.detail`），
  0 下载新包排名天然低；`description`/`keywords` 只决定是否命中。
- 已发布版本的元数据是**发布时快照**：改本地 `description`/`keywords` 要发新版本
  （0.1.1）才反映到 npm 页面。
- 进 market 索引的前提是**已在 npm 发布**（6487 条均为 npm 包）；只发 GitHub 的条目
  通常不进索引（卡片/安装支持 GitHub URL，但搜索索引以 npm 目录为主）。
- GitHub：仓库 `metaimagine/dsh-web-inspect` 已有 `dsh-plugin` topic；
  topics 当前 `[dsh, dsh-plugin, inspector]`；仓库 `created_at = 2026-11-22T10:50:13Z`，
  awesome 的 24h 门槛 = **2026-11-23T10:50:13Z（北京时间 18:50）**。

## 2. 推断（未直接验证）

1. 对 `dsh-web-inspect` 来说，**索引里唯一能靠 SEO 影响的强字段是 `description.en/zh`**：
   `name`/`title` 只有 `dsh-web-inspect`（含 web/inspect 词），`owner` 是 `metaimagine`
   不含语义词；所以用户搜 `element inspector`、`inspector`、`html preview`、`sidebar`、
   `devtools`、`元素`、`检查`、`预览`、`侧边栏` 时，只能靠 description 命中。
2. 搜 `dsh-web-inspect` 全名：name 完全等于查询 → 两条路径都应该排第一（dshmarket：
   `700+300` 最高档；Discover：boost 3 的 name 命中）。这条不依赖 SEO，只要求索引里有我们。
3. 浏览列表（无查询）按 downloads-desc 排，新包会沉底；不要为浏览列表刷量，也没必要。
4. `package.json` 的 `keywords` 对当前两条市场检索都**不生效**（索引不填 keywords），
   但对 npm 搜索匹配可能有用（npm 是否用 keywords 参与匹配属官方实现，未在本机验证），
   且对未来索引生成器可能生效；保留相关词、不堆砌即可。
5. `README` 不进入任何市场搜索，只影响：npm 包页、awesome 详情页、GitHub 仓库页的可读性与
   转化（star/安装），属于长期运营项，不是 SEO 排名项。

## 3. 已落地 / 待执行清单

| # | 位置 | 改什么 | 状态 |
|---|---|---|---|
| 1 | `docs/notes/market-submission.md` | YAML `description.en` 前置 `Element inspector` / `HTML preview` / `sidebar` / `DevTools`，≤160 字符；`zh` 前置 `元素检查器`/`侧边栏`/`预览`；`category: ui` | ✅ 已改 |
| 2 | `package.json` `description` | 英文一句，含 `element inspector`、`right-sidebar HTML preview`、`selector/computed styles`、`folded reference chip`、`DSH` | ✅ 已改（本地；下次 publish 生效） |
| 3 | `package.json` `keywords` | 15 个相关词（dsh, dsh-plugin, deepseek-harness, element-inspector, inspector, devtools, html, html-preview, css, sidebar, preview, sandbox, postmessage, ai-coding-agent, web-client-plugin） | ✅ 已改（本地） |
| 4 | npm 版本 | 发 `0.1.1` 让新 description/keywords/README 进 npm 页面（用户执行；0.1.0 已发布） | ⏳ 待发布 |
| 5 | GitHub repo description | 建议：`Element inspector for the DSH web UI: click any element in the right-sidebar HTML preview and send its CSS selector + styles to your AI session as a folded chip.` | ⏳ 用户设置 |
| 6 | GitHub topics | `dsh`, `dsh-plugin`, `deepseek-harness`, `element-inspector`, `devtools`, `html`, `css`, `sidebar`, `ai-coding-agent`, `web-client-plugin` | ⏳ 用户设置 |
| 7 | awesome YAML | 待 24h（2026-11-23 18:50+08）后提 PR，只加 `data/plugins/metaimagine__dsh-web-inspect.yml` | ⏳ 用户执行 |
| 8 | README | 英文主 + `README.zh-CN.md`（GitHub/npm 索引 README），H1 用包名，首段含 DSH plugin / element inspector / right-sidebar HTML preview | ✅ 已重写 |
| 9 | 诚实性 | 不编造下载量/性能数字；E2E 数字可复现（31 checks） | ✅ |

## 4. 本次已落地文件

- `README.md`（英文产品化：hero/徽章/安装命令/主图/Why/How it works/Install/Quickstart/
  3 个案例/对比表/FAQ/Limitations/Development/License）；新增 `README.zh-CN.md`（中文同构、互链）。
- `assets/` 5 张截图（`hero-sent-bubble.png`、`hover-highlight.png`、`chip-popover.png`、
  `bubble-fold.png`、`opaque-origin.png`），每张 < 300 KB；README 用绝对 raw URL 引用
  （npm 包不含 assets）。
- `package.json`：`description` + `keywords`（version 未改）。
- `docs/notes/market-submission.md`：YAML + PR 正文 + checklist 更新（见该文件）。

**未做（按任务边界/需用户执行）**：git commit/push、npm publish、GitHub repo description/topics、
awesome PR（需 24h + 0.1.0 已发布）。

## 5. 复现命令

```bash
# 索引数据：条目字段、keywords/author 是否填充
curl -s https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json | node -e '
const c=JSON.parse(require("fs").readFileSync(0,"utf8"));
const p=c.plugins;
console.log("format",c.format,"count",p.length,
  "keywords:",p.filter(x=>x.metadata?.keywords?.length).length,
  "author:",p.filter(x=>x.author).length,
  "fields:",Object.keys(p[0]).join(","));
console.log("category ui:",JSON.stringify(c.metadata?.categories?.ui));'

# dshmarket 搜索权重
grep -n "WEIGHT_\|pluginRelevance\|fieldRelevance\|searchText" \
  ~/.dsh/profiles/web/node_modules/dshmarket/client/client.js | head

# 宿主 Discover 的 MiniSearch 配置
grep -n "fields:\|boost:\|prefix:\|fuzzy:\|combineWith" \
  ~/.dsh/npm/node_modules 2>/dev/null || \
grep -n "fields:\|boost:\|prefix:\|fuzzy:\|combineWith" \
  ~/.local/share/fnm/node-versions/*/installation/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market/lib/types/search.js

# npm 搜索是否收录（发布后；可能滞后数小时~2 周）
npm view dsh-web-inspect version
curl -s "https://registry.npmjs.org/-/v1/search?text=dsh-web-inspect&size=250" | node -e '
const j=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(!!(j.objects||[]).find(o=>o.package.name==="dsh-web-inspect"));'
```

## 6. 面向 agent 的可发现性（2026-11-22 追加）

出发点：这个插件的「买家」可能是 agent —— 用户说「把这页这个按钮改大点」，agent 拆出子任务
「需要拿到页面元素的 selector/CSS」，再去检索工具/插件。所以除了人读的 README，还要让 agent
**检索得到、且一眼能判断该不该用**。

### 6.1 已做的设计决定（每件针对 agent 的哪个动作）

| # | 做了什麼 | 针对 agent 的哪个动作 | 位置 |
|---|---|---|---|
| 1 | 「When to use this」条件句路由块 | 拆解意图后做 **tool selection**（这个工具适不适合当前子任务） | `README.md`（Quickstart 之后） |
| 2 | 「When NOT to use this」5 条反例 | 防止**误触发**（整页改版/跑测试/非 HTML 预览/引用文本/JS 调试） | 同上 |
| 3 | 中英同义词对照表 | **intent→capability 映射**：把用户口语（"inspect element"/"检查元素"）映射到能力名 | `README.md` / `README.zh-CN.md` |
| 4 | `docs/capabilities.json` 结构化能力卡 | agent 直接抓 **tool card**：`id/summary/inputs/outputs/trigger_phrases/not_for/install/requires`，无需解析 README | 仓库根 `docs/capabilities.json` |
| 5 | `llms.txt`（≤30 行） | agent 的 **fetch fallback / 快速摘要**（llms.txt 惯例，一页纸） | 仓库根 |
| 6 | `keywords` 补齐同义词（15 个，含 `inspect-element`/`element-picker`/`dom-inspector`/`css-selector`） | **npm / 目录索引的召回**（虽 dshmarket 检索不读 keywords，npm 侧可检索、未来索引生成器可能用） | `package.json` |
| 7 | README「机器可读文档」小节（指向 `llms.txt` + `capabilities.json` + `npm view`） | **发现「发现文件」**（agent 从 README 一步抓到结构化文件） | `README.md` |
| 8 | awesome YAML 的 `description.en/zh` 关键词前置（上一轮） | 市场索引条目在 **description 字段命中**（dshmarket 240/280 权重、Discover description 字段） | `docs/notes/market-submission.md` |

### 6.2 没有做的「花活儿」及原因

| 没做 | 原因 |
|---|---|
| 假 benchmark / 编造下载量、性能数字 | 不可复现、违反诚实性；真实数据是 31 项 E2E，已注明可复现命令 |
| 堆无关关键词（`react`、`vscode`、`mcp`、`browser-extension` 等） | 稀释相关性（dshmarket 靠 description 字面命中；无关词不增加命中还提高噪音），且与插件真实能力不符 |
| 虚构 MCP / tool-call schema、`tool.json` | 本插件不是 MCP 工具，能力是 UI 手势 + chip 插入；虚构 schema 会让 agent 误用（以为可以直接调用「inspect」） |
| `llms-full.txt` 长文 / 多语言多份复制 | llms.txt 惯例就是一页；细节在 README 与 `docs/notes/*`，多份副本会互相过期 |
| 把 `llms.txt`/`capabilities.json` 塞进 npm tarball | 边界只允许改文档与 description/keywords；npm 包 files 白名单未动，agent 走 GitHub raw URL |
| 伪造市场收录/排名 | 是否被搜到取决于 awesome PR 合并 + 索引重新生成，不是文案能保证的 |

### 6.3 本次验证方式

- `node -e "JSON.parse(require('fs').readFileSync('docs/capabilities.json','utf8'))"` 通过；
- `llms.txt` 行数与关键字段检查；
- `package.json` keywords 长度 = 15（≤15），无重复；
- README/README.zh-CN 本地链接全部存在、`#when-to-use-this` 锚点小节存在；
- `git status` 确认 `lib/`、`cordis.patch.yml` 未改动。
