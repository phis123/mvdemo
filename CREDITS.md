# 来源与署名 / Credits

## 本演示的架构参考

本演示（搜索框打字 → 缓慢放大）在**渲染架构与工程做法**上参考并学习了下面这个开源项目：

- **[Nyankomintsu/world-execute-me-lyric-mv](https://github.com/Nyankomintsu/world-execute-me-lyric-mv)**
  Mili《world.execute(me);》的非官方同人歌词 MV 渲染工程（**代码 MIT**）。

具体借鉴的**设计思路**（不是代码）：

- 每帧由 `renderFrame(t)` 决定，且是对 `t` 的纯函数、零跨帧状态、不读挂钟、不做 I/O；
- 主题与引擎分离：配色、字体、文案、时间轴放在配置里，代码只留机制；
- 片长与排版数据化（时间轴是一张表，不是一个播放器状态）；
- 确定性与可复现性要被**验证**而不是宣称（同 `t` 两次渲染逐像素比对）；
- 用静帧接触表（contact sheet）做人与程序之间的评审回路。

## 边界声明

本仓库**不包含**上述项目的任何内容：

- 没有它的任何代码文件、也没有逐段移植；
- 没有它的角色剪影（那 8 张图是 `CC BY-NC-SA 4.0`，本演示一张未用）；
- 没有它的封面图、字体包、音频或歌词；
- 因此本仓库不是它的衍生作品，也不受其 `CC BY-NC-SA` 条款约束。

如果确实要用到那 8 张角色剪影或它的其它素材，请遵守其
[CREDITS.md](https://github.com/Nyankomintsu/world-execute-me-lyric-mv/blob/main/CREDITS.md) 中的授权：
`CC BY-NC-SA 4.0`（署名、非商业、以相同方式共享），并注明为 AI 生成。

## 本仓库自身的内容

`src/`、`tools/`、`index.html`、`config.json`、`README.md` 以及 `out/` 下的成片与图片，
均为本演示自行编写与渲染，与本仓库的许可证一致（见 LICENSE，若尚未添加则默认保留所有权利）。

画面里的全部元素——搜索框、光标、字形、纸张质感、噪声——都由代码绘制，
字体使用本机已安装的系统字体（Noto Sans SC / Segoe UI / Cascadia Mono），未分发任何字体文件。
