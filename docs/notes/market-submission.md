# awesome-dsh-plugin 投稿物料（2026-11-23 提 PR 用）

仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
规则：一个 PR 只加一个文件；README 由脚本生成，**不要手改**。
索引机制与关键词依据见 [`market-seo.md`](market-seo.md)：条目只有 `name/title/description/category`
进搜索，且 `description` 进索引时截到 160 字符 → **关键词前置**。

## 1. 目标文件

`data/plugins/metaimagine__dsh-web-inspect.yml`

```yaml
# dsh-plugin: dsh-web-inspect
url: https://github.com/metaimagine/dsh-web-inspect
name: metaimagine/dsh-web-inspect
category: ui
description:
  # 154 chars（≤160，索引截断前保留全部关键词：element inspector / DSH / right-sidebar /
  # HTML preview / selector / CSS / DevTools）
  en: "Element inspector for the DSH right-sidebar HTML preview: hover, click, and send its selector, box and CSS to your agent as a folded chip (like DevTools)."
  # 63 chars
  zh: "DSH 侧边栏 HTML 预览的元素检查器：悬停高亮、单击选中，把元素的选择器、盒模型与计算样式以折叠引用块发给 agent。"
icon: https://raw.githubusercontent.com/metaimagine/dsh-web-inspect/main/assets/howto.png?x=1
```

（`icon` 用主截图 202 KB；官方 schema 支持 remote URL 图标。`tarball` 不填——已发 npm，
安装走包名；Release 的不带版本号 tgz 是给 `latest/download` 用的备用安装方式。）

## 2. PR 标题 / 正文

标题：`Add metaimagine/dsh-web-inspect`

正文：

```markdown
Adds `dsh-web-inspect`, an element inspector for the DSH (DeepSeek Harness) web UI.

- In the right-sidebar HTML preview, hover highlights the element under the cursor with a
  `tag#id.class W×H` tooltip; click selects it.
- The selection is inserted into the session input as a folded reference chip (the same
  mechanism as the official quote feature), so the transcript stays readable while the model
  still receives the full context (selector, HTML snippet, box, computed styles, clues).
- The preview iframe stays opaque-origin (`sandbox="allow-scripts"`): the inspector runtime is
  injected into the srcdoc document and talks to the app only via `postMessage`, so previewed
  HTML cannot read the session, cookies, or DSH DOM; the app never reads `contentDocument`.
- Works as a renderer override, so it plugs into any workspace HTML file preview; no rebuild
  or restart needed after install (one page refresh).
- Repo declares `dsh.bundle` + `cordis.patch.yml` at the root.
- E2E: 31 checks green (sandbox contract, hover/select, chip insert, send/bubble fold,
  Esc exit, plain/quote regressions, legacy sentinel compatibility).

npm: https://www.npmjs.com/package/dsh-web-inspect (0.1.0)
GitHub: https://github.com/metaimagine/dsh-web-inspect
Screenshot: https://raw.githubusercontent.com/metaimagine/dsh-web-inspect/main/assets/howto.png?x=1
```

## 3. 提交前 checklist

- [x] npm 0.1.0 已发布（`npm view dsh-web-inspect` 可读）
- [x] `dsh-plugin` topic 已加；仓库含 `cordis.patch.yml` 与 `dsh.bundle`
- [x] 描述与代码一致、无夸大（31 项 E2E 可复现）
- [ ] 仓库创建满 24 h（`created_at = 2026-11-22T10:50:13Z` → **2026-11-23 18:50 +08** 之后）
- [ ] 分类选 `ui`（UI 增强）——插件市场/发现页「按分类」也能命中
- [ ] PR 只加这一个 yml 文件（不改 README/脚本生成物）

## 4. 提 PR 后如何验证被搜到

1. 索引生成需要 CI 跑完后更新 npm 包 `dsh-plugin-catalog`（或 GitHub Pages 索引）。
2. 「插件市场」页搜 `element`、`inspector`、`html preview`、`DevTools`、`元素`、`预览`。
3. 宿主「插件 → 发现 → 索引源」添加 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`
   后同样搜；`plugin_market` agent 工具也可查。
4. 若搜 `dsh-web-inspect` 全名：应该排第一（name 完全命中，两条检索都是最高档）。
5. 注意 npm 自身搜索索引收录新包可能滞后（官方：最长 2 周），与市场索引不是一回事。
