# 截图脱敏与配图生成（README 视觉素材）

README 目前只有 **一组视觉素材**：

| 文件 | 用途 | 尺寸 / 大小 |
| --- | --- | --- |
| `assets/demo.gif` | 首屏循环动效（检查元素 → 悬停描边 → 单击 → 输入框出现折叠 chip） | 见文件 |
| `assets/howto.png` | 静态主图：一张图讲完 ①开关 ②悬停定位 ③折叠 chip | 2400×1504 / ~360–600 KB |

文件命名与 README 引用保持一致；URL 统一带 `?v=20261123`（raw/camo 缓存破坏）。

## 生成方式

```bash
node tools/shots.mjs --hero
```

`--hero` 会自己起一个临时 headless Chrome、铸 auth cookie、打开
`fixtures/apple-square.html` 的预览、抓到「检查元素已开启 + `div.topbar`
悬停描边与 tooltip 可见 + 输入框里一个 `<div.topbar>` chip」的状态，然后：

1. `Emulation.setDeviceMetricsOverride {width:1500, height:800, deviceScaleFactor:2}`
2. `Page.captureScreenshot`（**不带 clip**）拿 `3000×1600` 设备像素原图；
3. 页面内 canvas 按 **整数设备像素** 裁剪 `1200×752` CSS 区域（left 钉在
   `1500-1200`，即去掉左侧栏；top 对齐预览面板 header 行，避开 tab 栏和会话标题）；
4. 同一 canvas 1:1 画 ①②③ 三组编号圆点 + 引导线 + 箭头（`#2F6FED`，线宽 6@2x，
   圆点直径 56@2x，白字，无阴影/发光）；
5. 另存 50% 预览 `tests/screens/hero-preview.png`，主图写
   `assets/howto.png`，再用 `ffmpeg -compression_level 100 -pred mixed` 做**无损**重编码
   压到 600 KB 以内。

中间件 `tests/screens/hero-base.png` 是未画批注的底图，便于日后重画。全程不做任何
缩放/插值（除 50% 预览与 ffmpeg 的无损重编码）。

## 脱敏机制

- **左侧栏**：裁切从 `x = 1500 - 1200 = 300` CSS 开始，工作区列表、会话历史、
  收藏等全部在裁切区外。
- **会话标题 / tab 栏**：裁切 top 对齐预览面板的 header 行（文件名那一行），
  tab 栏与左上角会话标题不进入画面。
- **面包屑路径**：截图前把预览面板路径 span 的文本改成裸文件名
  `apple-square.html` 并左对齐，不出现 `/Users/...`、`~/.dsh`、profile 路径。
- **工作区名**：若页面上出现「选择工作区」按钮，截图前 `visibility:hidden`。
- **临时状态**：`思考…` / `深度求索中` / `加载技能` / 模型限流报错等基础设施
  文案会在截图前从聊天区隐藏（只隐藏这些状态块，消息气泡保留）。
- **固定兜底**：`REDACT_PAGE_SCRIPT` 会替换 `/Users/...`、用户名、模型名、
  已知工作区名、邮箱、手机号；不依赖人工逐张涂改。

## 检查清单（逐项已核对）

- [x] 无左侧边栏、无工作区列表/会话历史
- [x] 无会话标题、无账号/头像信息
- [x] 无 `/Users/care/...` 或任何绝对路径；面包屑只显示 `apple-square.html`
- [x] 无 token / 邮箱 / 手机号 / 真实姓名与地址
- [x] 演示 HTML 已中性化：`dsh-phone`→`demo-app`、`ONE DESKTOP`→`ASTER DESKTOP`、
      `One`→`Aster`（副本 `fixtures/apple-square.html`，原文件未动）
- [x] 界面为浅色主题（`prefers-color-scheme: light` 模拟），与 README 整体风格一致
- [x] 聊天区出现的文案是本插件演示脚本自己写入的中性句子，不含项目/个人信息
- [x] ① 指向预览头部「检查元素 / 退出检查」按钮；② 指向 `div.topbar` 的描边 +
      tooltip `div.topbar 618×48`；③ 指向输入框里的折叠 chip `<div.topbar>`
- [x] 2x 设备像素、整数裁切、文字锐利；单张 ≤600 KB

## 残留风险

- 聊天区里的演示句子由脚本发送，属于本仓库的演示内容（非真实用户对话）。
- `div.topbar 618×48` 的盒子尺寸随生成时的视口宽度变化；换机器重生成可能不是
  618×48，README 说明里写的是「实测盒子，随视口宽度变化」。
- `assets/demo.gif` 是循环动效录屏，由另一条录制流程产出（本文件只管静态主图）；
  录屏时同样遵守上面的边界，但 GIF 无法逐帧像 PNG 一样复核。
- 该生成方式依赖本机 Chrome + ffmpeg；缺 ffmpeg 时跳过无损重编码（文件略大但内容一样）。
