# demo-recording — README 首屏循环动效（6.8 s GIF）+ 静态主图（howto.png）

给首屏做一条能无限循环的短录屏，6.8 s 讲完一条完整链路：**开「检查元素」→ 悬停 `div.topbar` 出描边 + tooltip → 单击 → 输入框里出现 `<div.topbar>` 折叠引用 chip → 复位重来**。

- 产物：`assets/demo.gif`（960×788，620 KB，102 帧 / 6.8 s / 15 fps / loop=0）、`assets/demo.mp4`（1440×1182，196 KB，h264 yuv420p crf20，给 Release 页和高分屏）
- 流水线：`tools/screencast.mjs`（raw CDP over 内置 WebSocket，零 npm 依赖；headless Chrome 1280×820 @DPR2，采到的原帧 3996×3280）
- 复现：`node tools/screencast.mjs`（全流程 ≈40 s）｜`--skip-capture` 只重编码（复用 `tests/screencast/frames/`）｜`--skip-encode` 只采帧
- 报告：`tests/screencast/report.json`；抽检帧：`tests/screencast/qc/qc-01..06.png`、`qc/contact-sheet.png`
- 采帧是**定格动画**不是实时录屏：第 i 帧先按虚拟时间 `t=i/15` 摆好合成光标 → 派发真实 `Input.dispatchMouseEvent`（让插件 hover 真的触发）→ flush 2 帧 rAF → `Page.captureScreenshot`。所以体积可预期、可重放、不掉帧。

## 1. 行业做法横向对比（6 s 素材的体积量级）

| 方案 | 代表工具 | 适用场景 | 体积量级 | CI 可复现 | 许可/费用 |
| --- | --- | --- | --- | --- | --- |
| 终端录制（矢量） | asciinema + svg-term-cli | 命令行演示，输出 SVG 动图，任意缩放不糊 | 几 KB–几十 KB | ✅ `asciinema rec` → svg-term | MIT，免费 |
| 终端录制（脚本化） | VHS (charmbracelet) | `.tape` 脚本描述输入节奏 → gif/mp4/webm | 100 KB–1 MB | ✅ 有官方 Docker 镜像 | MIT，免费 |
| UI 手动录制 | Kap（macOS）、ScreenToGif（Windows） | 临时演示、逐帧删帧改帧 | 1–8 MB | ❌ 手工 | MIT，免费 |
| UI 手动录制（商业） | CleanShot X、Screen Studio | 带自动缩放/平滑运镜的产品演示，出片即用 | 2–10 MB | ❌ 手工 | $29 一次性 / $89 起 |
| 浏览器代码化录屏 | Playwright `recordVideo`、CDP `Page.startScreencast` + ffmpeg | 需要每次发版自动重录的 UI 演示 | 几百 KB–几 MB | ✅ 本仓库这条路 | Apache-2.0 / MIT |
| GIF 编码/后处理 | gifski（质量最好）、gifsicle（lossy/瘦身）、ffmpeg `palettegen/paletteuse` | 上表任一路径的收尾 | 同素材比朴素调色板小 20–50% | ✅ 都是 CLI | MIT / GPL-2.0 / LGPL |

**结论**：终端类项目用 VHS 一条 .tape 最省事；**浏览器 UI 演示且要跟版本走**，就是 Playwright/CDP 采帧 + ffmpeg 编码（本项目选型）；Kap/Screen Studio 适合一次性营销素材，胜在运镜和手工精修，但换版要重录。本机只有 ffmpeg（无 gifski/gifsicle/magick），所以 GIF 用 `palettegen=max_colors=128:stats_mode=diff` + `paletteuse=dither=bayer:bayer_scale=3` 单图两遍完成。

## 2. 质量数据（实测，见 `report.json`）

| 指标 | demo.gif | demo.mp4 |
| --- | --- | --- |
| 体积 | 634 431 B（620 KB，预算 3 MB 的 21%） | 200 934 B（196 KB，预算 1.5 MB 的 13%） |
| 尺寸 | 960×788（预算 900–1000 px） | 1440×1182 |
| 帧数 / 时长 / fps | 102 帧 / 6.8 s / 15 fps | 同源 102 帧 / 6.800 s / 15 fps |
| 调色板 | 128 色（源裁切 999 px → 0.96×） | yuv420p crf 20 preset slow |
| 亮度 YAVG | 218.3–225.4（无黑帧、无空帧） | — |
| 闪烁（帧间差中位数） | 0.00；最大 9.9（第 87 帧＝复位）、8.6（第 20 帧＝点开关）、7.1（第 30 帧＝描边出现） | — |
| 循环首尾帧差 | **0.00**（第 0 帧与第 101 帧逐字节相同） | — |

抽检 6 帧（`report.json.qcFrameIndex`）：`qc-01`=6 起始态、`qc-02`=26 开关打开（多出提示条、按钮变「退出检查」）、`qc-03`=45 悬停 topbar（蓝色描边 + tooltip `div.topbar 519×48`）、`qc-04`=62 chip 落进输入框（气泡提示「已插入引用块」、发送键变蓝）、`qc-05`=80 光标移到 chip、`qc-06`=101 回到起始态（与 `qc-01` 逐字节相同）。**960 px 显示宽度下 11 px 正文、tooltip、chip 三处都清晰可读**。

## 3. 静态主图 `assets/howto.png`（同一个 staging，冻结在单击之后）

```bash
node tools/screencast.mjs --still --still-crop-height 640
```

同一套 boot/摆状态/脱敏/裁切流程，只是不在时间轴上跑帧：开「检查元素」→ 悬停 `div.topbar` → 单击等 chip 落进输入框 → 关掉 popover → 把合成光标藏掉（静态图不需要）→ 截一张。三处批注是**代码画的 SVG**（`CALLOUT` 常量 + `drawCallouts()`），不是手工 PNG 叠加：主色 `#2F6FED`、圆点直径 28 css（2x 下 56 px）白色数字、线宽 3 css（2x 下 6 px）圆头、端点距目标边缘 10–12 px、无阴影无发光。

| 指标 | 实测 |
| --- | --- |
| 成品 | 1800×945（宽高比 0.525，源裁切 1219×640 css @2x 后 0.74× lanczos） |
| 体积 | 298 168 B（291 KB，预算 600 KB 的 48%） |
| 三个锚点 | ① 预览头部「退出检查」按钮 `toggle 1372,45 90×24`；② 被描边的 `div.topbar` `target 854,331 618×48`；③ 输入框里的 chip `chip 310,455 107×24` |
| 脱敏 | 同 GIF：路径 → `…apple-square.html`、工作区名 → `demo-workspace`、模型名 → `Model` |

注意两点：**tooltip 里的尺寸跟 GIF 不一样**（静态图 `618×48`、GIF `519×48`），因为视口宽 1500 vs 1280，元素盒子是实测值——README 里已注明「尺寸随视口宽度变化」；截图里的 `div.topbar` 是**单击后的 peach 描边**（已选中），不是悬停时的蓝描边，因为这两个状态不会同时出现。

## 4. 已知局限

1. 依赖**正在运行的 DSH GUI**（`http://127.0.0.1:3080`）+ 目标工作区已装本插件；CI 里要先起 GUI 再跑，不是纯静态 fixture 渲染。
2. 打开「检查元素」后预览上方会插入一条提示栏，iframe 整体下移 ≈30 px——所以目标元素的坐标是**开开关之后重新量**的（代码里 `targetPt` 是可变的共享对象，光标腿按引用读取）。
3. 光标是按时间轴插值的合成叠层，不是真人手抖，缓动用 `1-(1-u)^4`（flick-and-settle：先甩过去再慢贴着目标落下）。15 fps 下快速移动段有轻微台阶感（要更顺就把 `--fps` 提到 24，体积约 +40%）。
4. 光标扫进预览区时会依次点亮途中的元素（`section#stage` 整块 → 缩到 `div.topbar`），约 8 帧；这是检查元素本身的行为、也顺便演示了「高亮跟随指针」，不是编码闪烁，但介意的话可以把入场路径压到 2–3 帧。
5. 原帧是 3996×3280（CSS 999×820 × DPR2 × clip scale 2），单帧大但只在临时目录里，`--gif-width` 缩到 960 后依然锐利；磁盘吃紧可把 `--dpr` 降到 1。
6. 左侧边栏靠裁切切掉，聊天列里的文案靠 DOM 脱敏（绝对路径→`…`、工作区名→`demo-workspace`、模型名→`Model`、「N 进行中」浮标和输入光标都隐藏）。**以后 UI 新增可见文案，要往脱敏脚本里补规则**，否则会漏。
7. 循环靠「最后一帧 == 第一帧」实现；中间有一次复位（chip 消失、回到空输入框），在循环里读作「再来一遍」，不是状态无感衔接。
8. 依赖本机 Chrome（`resolveChromePath()` 找系统安装），Linux CI 需要换 Playwright 自带 Chromium 的路径。
