# MV demo · 搜索框打字 → 缓慢放大（5 秒 · 无音频 · 中英双语）

这是一个**可复现的演示**，证明那套实现形式能用：**一条时间轴 → 一个纯函数 `renderFrame(t)` → 逐帧出图**。
画面里没有任何素材文件、没有剪辑、没有配音：搜索框、光标、字形、纸张质感全部由代码绘制。

```
t=0.5s ─ 1.45s   打字：为什么我们要使用 ai
t=1.45s          中英字幕淡入
t=1.55s ─ 3.1s   继续打字：why should we use ai
t=2.3s ─ 5.0s    搜索框缓慢放大（1.0x → 4.6x），画面像被推近纸面
t=5.0s           结束
```

## 跑起来

```bash
node tools/server.mjs --open      # 预览 → http://localhost:5173/
```

预览页快捷键：`空格` 暂停 · `←/→` 跳 1 秒 · `,/.` 逐帧 · `Home` 回到开头 · `?t=3.2` 直接定位。

## 出图与验证

```bash
# 12 个关键时刻的接触表（自带动画感的一眼总览）
node tools/shot.mjs --sheet --times 0.55,0.95,1.50,1.95,2.45,2.90,3.30,3.80,4.20,4.55,4.80,4.95 \
                    --cols 3 --cell 640x360 --out out/sheet.png

# 全片 PNG 序列（300 帧 @1920x1080）+ 每帧 sha256 清单
node tools/shot.mjs --seq --out out/frames

# 合成 MP4（需要 ffmpeg，见下）
node tools/shot.mjs --video --out out/demo_1080p60.mp4

# 确定性验证：同一时刻跑两遍，逐像素比对
node tools/shot.mjs --verify --times 0.3,1.2,2.0,3.0,4.0,4.9 --repeat 2
```

`--seq` 会产出 `out/frames/manifest.json`：每一帧的 `t`、文件名、RGBA 的 sha256，以及该帧的状态（已打字内容、缩放倍率、实际用到的字体族）。**这个清单就是"可复现"的证据**。

`--video` 自己找 ffmpeg，顺序是：`--ffmpeg` 参数 → 环境变量 `MV_FFMPEG` → `tools/bin/ffmpeg.exe` → 系统 PATH。找不到就报一句清楚的错，不会静默换一个。编码后还会用 `ffprobe` **回读成品**核对帧数与时长，而不是只信编码器的日志。

## 关于 ffmpeg（可选）

只有 `--video` 需要它，出接触表和帧序列不需要。两种装法：

```powershell
# A. 系统安装
winget install --id Gyan.FFmpeg -e     # 装完重开终端

# B. 便携版放进项目（不动 PATH，项目自包含）
#    把 ffmpeg.exe 与 ffprobe.exe 放到 tools/bin/
```

`tools/bin/`、`out/frames/`、`out/*.mp4` 都在 `.gitignore` 里：ffmpeg 是本地工具（约 100 MB，且是 GPL build），成片与帧序列是产物，不该进 git 历史。

实测（本机 ffmpeg 9.0.2 essentials）：

| 项 | 值 |
| --- | --- |
| 输入 → 输出 | 300 张 PNG（**184 MB**）→ **MP4 5.55 MB** |
| 编码 | H.264 High，1920x1080，60 fps，yuv420p，`+faststart` |
| 校验 | 时长 5.000 s、300 帧，回读一致，全片可完整解码 |

## 目录

```
config.json          主题、文案、时间轴、配色、字体——换主题只改这个文件
src/render.mjs       全部画面：纯函数 renderFrame(t)，零跨帧状态，无素材依赖
index.html           预览外壳 + 导出用的取像素接口（window.__mv）
tools/shot.mjs       出图 CLI：接触表 / 序列 / 确定性验证
tools/cdp.mjs        启动本机 Chromium 并说 CDP（Node 24 自带 WebSocket/fetch）
tools/png.mjs        自带 PNG 编码器（只用 Node 内置 zlib）
tools/server.mjs     预览用的静态服务器，无打包器
out/                 产物（接触表、帧序列、验证报告）
```

## 为什么这样设计

- **纯函数**：`renderFrame(t, ctx, cfg, state)` 不读上一帧、不读挂钟、不做 I/O。所以同一 `t` 必然同一像素（实测两次独立运行逐像素一致）。
- **主题在配置里**：换主题只动 `config.json`。`render.mjs` 里没有一处写死的秒数、颜色或文案。
- **随机也是确定的**：噪声用 `rnd(seed, 整数键)` 无状态哈希，键带帧号。没有 `Math.random()`。
- **中英混排显式处理**：中文走 CJK 字体族、拉丁走拉丁字体族，逐字符测量，并把**实际用到的字体族**回传给验证步骤——避免"静默回退到系统字体导致跨机器不一致"。
- **时间轴数据化**：`config.json → timeline` 里的 `segments` 只描述"从第几秒到第几秒打出哪些字"；字幕、水印、进度条、缩放区间各自独立成段，互不耦合。

## 本机限制（诚实的部分）

- **Chromium 需要放宽沙箱权限才能启动**：它的 mojo IPC 要开命名管道，默认沙箱会以 `0x5 拒绝访问` 失败。这不是工程代码的问题，是环境边界。
- **导出通道不是 GPU 后处理链**：画面用 2D 渐变、阴影、噪点实现质感，像素经 `canvas.getImageData()` 回读原始 RGBA，再由 Node 侧自写 PNG 编码。所以这里**逐像素完全可复现**（同一 `t` 跑两遍哈希相同），没有原仓库那种"同帧两次渲染差 1/255"的非确定性。
- **中文文案里的换行/空格靠显式分段**：`segments` 的拼接就是最终字符串，所以每段结尾该不该带空格必须写对（第一版就踩过 `使用 aiwhy should` 粘在一起）。这是数据层的坑，不是渲染层的。

## 下一步（若继续做长片）

1. 加音频层：`tools/analyze_audio.py` 那类离线分析 → `features.json`，运行期只查表；卡片改用节拍网格 `T/H/B/Bt`。
2. 引入"事件层 / 拍网层"分离：事件（唱字、名词落地、鼓点）与网格各自一张表。
3. 单段镜头拆成独立文件 + 注册表，每段带自己的 `at / dur / palette / enter`，失败只告警不中断。
4. 接触表 + 回归对比（`compare_sheets`）作为固定评审流程：每改一版出一套图，肉眼比差异。
