# cutccc

本地视频剪辑与中英原文字幕工作台。**Node.js 负责主服务，Python 负责模型推理**。网页 UI、本地 HTTP API 和 MCP 使用同一份工程，可裁剪、重排、编辑字幕、叠加少量旁白，并导出 MP4 和 SRT。

工程、素材、缓存与成片保存在配置的数据目录。语音模型下载后在本机离线运行。

## 架构

| 部分 | 实现 | 职责 |
| --- | --- | --- |
| 网页 | HTML / CSS / JavaScript | 素材预览、剪辑、字幕、旁白设置 |
| 主服务与 MCP | Node.js 22+，内置模块 | HTTP、流式导入、工程 JSON、版本检查、任务队列、日志、媒体 Range 请求 |
| 视频处理 | Node.js 启动 FFmpeg / ffprobe | 检查素材、缩略图、裁剪拼接、旁白混音、字幕烧录、导出 |
| 模型推理 | 独立 Python 进程 | Qwen3-ASR 识别、Qwen3-ForcedAligner 时间对齐 |

Node 服务没有 npm 运行时依赖。剪辑和导出需要 Node.js 与 FFmpeg；生成自动字幕还需 Python、CUDA 环境和本地模型。TTS 音频可由独立 Python 推理工具生成后作为旁白导入，当前服务不直接提供 TTS 模型接口。

主服务代码位于 `cutccc/node/`。Python 保留 `pipeline.py`、`audio.py`、`subtitles.py`、`models.py`，以及命令兼容入口，不再提供 Python HTTP 服务或 Python 剪辑任务队列。

## 启动工作台

安装 Node.js **22 或以上**，并确保 `ffmpeg`、`ffprobe` 在 PATH 中。然后运行：

```powershell
git clone https://github.com/wzj998/cutccc.git
cd cutccc
npm start
```

打开 **http://127.0.0.1:18765/**。Windows 也可双击 `studio.cmd`。

```powershell
node cutccc/node/cli.js serve --port 18765 --data-dir E:/video-work/studio --models-dir E:/models --inference-python E:/inference/.venv/Scripts/python.exe
```

默认数据目录为 `~/.local/share/cutccc`，模型目录为 `~/.cache/cutccc/models`。可通过 `CUTCCC_DATA_DIR`、`CUTCCC_MODELS_DIR` 和 `CUTCCC_INFERENCE_PYTHON` 配置。未指定推理环境时，Node 调用 PATH 中的 `python`。

项目工程、原片与导出结果可能很大，建议把 `--data-dir` 放在代码仓库外。

## 网页操作

- 导入视频；素材复制到工程目录，原文件保留。
- 在预览中设置入点 / 出点、分割片段、重排、重复使用或删除片段。
- 按 `Delete` 删除选中片段，删除按钮使用 `⌦ / Del` 提示；编辑文字时不会删除片段，`Backspace` 不作为片段删除快捷键。
- `Ctrl+Z` / `⌘Z` 撤销剪辑、旁白、字幕、样式和工程名编辑；`Ctrl+Shift+Z` / `⌘Shift+Z` 或 `Ctrl+Y` 重做。顶部也有按钮。连续输入合并为一次撤销，保存不会清空历史；重新载入、导入素材或切换工程会重置本次打开的历史。
- 时间轴工具栏和字幕面板顶部均有“＋ 新增字幕到时间轴”，面板按钮随滚动保持可见；新增后直接打开内容和样式编辑。当前有字幕时自动寻找后面的空白，且不超出选中片段的出点。
- 点击预览右上角“全屏”、双击画面或按 `F` 进入全屏；保留字幕和播放控制，按 `Esc` 或 `F` 退出。
- 预览画面可缩放至适应窗口的25%–400%，并按住画面上下左右拖动，超出预览区的部分隐藏；点击“适应”恢复100%并居中。普通与全屏预览共用缩放及位置，仅影响预览，不改变工程或导出画面。
- 全屏底部进度条支持点击、拖动和方向键跳转，按成片时间跨片段定位；拖动结束后保持暂停，停在松手的位置。
- 拖动时间杆上方手柄或刻度区可定位，松手后保持暂停；影片块区域的竖线不拦截鼠标，拖动影片块仍可调整顺序。
- 全屏播放按钮和进度条在鼠标移至屏幕底部时显示，移开或点击画面其他区域时隐藏；拖动期间保持可见，键盘 `Tab` 可调出控制栏。
- 将时间轴缩放条拉到最左端可显示完整成片；刻度和最小缩放随片长及窗口宽度自动调整。
- 时间轴缩放以播放头为锚点；播放头在可视区外时会移回可视区。时间轴、普通预览和全屏预览的加减号均可点击缩放。
- 影片块底部显示真实原音轨的峰值 / RMS 波形，随片段裁切、重复、重排、缩放和滚动对齐；无音轨及静音有明确标记。首次由 FFmpeg 提取，之后复用工程目录内的波形缓存，仅绘制可视范围，不改变工程和导出。
- 时间轴“音频显示”可切换波形、频谱图或同时显示。频谱采用80 Hz–8 kHz对数频率轴（下低上高），颜色越亮代表该频段能量越强；它是声音频率分布，不是自动人声判定。低缩放使用概览，放大后按需加载20秒细节分块，本地缓存位于工程目录的 `spectrograms/`，仅影响显示。
- 每条字幕可单独设置字体、字号、颜色、粗体、斜体、描边、九宫格位置和边距。点击字幕的“样式”可定位预览；勾选多条可批量修改单个属性，列表可切换到整个工程跨素材选择。
- 点击时间轴上的字幕块，可定位到该次出现的位置，并滚动到右侧原素材字幕列表的对应行直接编辑文字；点击该行“样式”可打开样式编辑。旁白、跨片段和重复使用的字幕均支持。重叠字幕分行显示，字幕块也支持 `Enter` / 空格打开。
- 时间轴字幕支持 `Ctrl/⌘` 点击多选、`Shift` 连选和空白处框选。拖动任一已选字幕可整体调整显示时间，保留时长及相对间隔，限制在成片范围内；一次拖动对应一次撤销，`Esc` 取消。旁白字幕移动不会移动旁白语音。
- 字幕拖动接近视频切点时会吸附，按住 `Alt` 可暂时关闭吸附。右侧每条字幕同时标注成片显示时间与原素材起止时间，旁白素材从0秒开始不等于它在成片0秒出现。
- 时间轴偏移记录在字幕的可选 `shift` 字段（秒），原素材起止时间保留。编辑面板同时显示成片时间与偏移；偏移随工程保存，并应用到预览、ASS、SRT及视频导出。同一素材字幕的重复实例共用该偏移。
- “应用到工程全部字幕”复制第一条所选字幕的完整样式；“恢复默认”仅重置所选字幕。样式随工程保存，预览和导出使用同一套位置及字号比例。
- 旁白素材的字幕跟随旁白在成片中的入点，可与现场对话同时显示在不同位置。导出提供烧录样式的视频、带样式的 ASS，以及不包含样式的纯文本 SRT。
- 自动识别中英文人声并保留原文，修改每句文字和原素材时间；可选择纯中文或纯英文模式。
- 对比原声及语音频段降噪版本，完整扫描音频并对疑似人声短句复听；任务中可下载原文 SRT、转写文字及未识别 / 待复核清单。
- 保存工程，导出 H.264 / AAC MP4，可选择烧录字幕，并下载重新排列后的 SRT。
- 在“片段”面板添加、调整或删除旁白，单独试听其音频。
- 旁白提供“仅移除语音”和“移除语音及字幕”两个操作。仅移除语音会保留字幕时间与样式（音量为0），导出不混入该语音，也不会因此压低现场原声；可通过“恢复语音”重新开启。
- 在任务面板查看进度、失败日志和完成的输出。

快捷键：空格播放 / 暂停，`F` 全屏，`I` 入点，`O` 出点，`S` 分割，`Ctrl/Cmd + S` 保存。

当前最多64个视频片段、32段旁白。旁白使用导入素材的完整音轨，按成片时间定位；导出时混入，播放期间原声降为30%。网页素材预览播放素材原声，旁白可单独试听，完整混音效果见导出结果。音频旁白可先封装为带静态画面的 MP4 导入，再将它从视频时间线移除、作为旁白使用。当前没有独立背景音乐轨道、转场或说话人分离。

## 工程兼容与任务恢复

工程继续使用 `projects/<id>/project.json` 和相对 `media/` 路径，保留原来的 ID、`revision`、`sources`、`clips`、`subtitles` 和任务输出结构。迁移前停止使用同一数据目录的旧 Python 服务，再用 Node 服务的 `--data-dir` 指向原目录。

Node 服务对数据目录加单实例锁；任务串行执行。保存时版本过期返回 `409`。识别期间手动修改字幕，生成结果会保留在任务目录，不覆盖人工修改。导出使用提交时的工程快照，之后的编辑不会改变正在导出的内容。重启后，未完成任务被标记为失败，工程和已有结果保留。关闭服务时只终止由该服务启动的工作进程树。

旧命令 `python -m cutccc serve` 和 `python -m cutccc mcp` 仍可使用，它们转发到随 Python 包分发的 Node 入口。

## 本地 API

服务启动后查看 **http://127.0.0.1:18765/api-docs**；**`/openapi.json`** 提供请求结构。网页和 API 文档均随包提供。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 主服务、推理运行时与模型状态 |
| GET / POST | `/api/projects` | 列出 / 创建项目 |
| GET / PATCH | `/api/projects/{id}` | 读取 / 保存工程 |
| POST | `/api/projects/{id}/sources/import` | 导入本机路径，字段 `path` |
| POST | `/api/projects/{id}/sources/upload` | 流式上传一个文件，multipart 字段 `file` |
| DELETE | `/api/projects/{id}/sources/{source_id}` | 按 revision 移除未使用素材引用，保留磁盘文件供备份恢复 |
| GET | `/api/projects/{id}/sources/{source_id}/media` | 媒体预览，支持 Range / HEAD |
| GET | `/api/projects/{id}/sources/{source_id}/poster` | 缩略图 |
| GET | `/api/projects/{id}/sources/{source_id}/waveform` | 原素材音频峰值与 RMS 波形，自动缓存 |
| GET | `/api/projects/{id}/sources/{source_id}/spectrogram` | 频谱 PNG；`tile=overview`（默认）或从0开始的20秒分块编号 |
| POST | `/api/projects/{id}/transcribe` | 排队识别字幕，字段 `source_id` |
| POST | `/api/projects/{id}/export` | 排队导出，字段 `burn_subtitles` |
| GET | `/api/projects/{id}/jobs` | 项目任务列表 |
| GET | `/api/jobs/{id}` | 任务状态与结果 URL |
| GET | `/api/jobs/{id}/video` | 下载导出的 MP4 |
| GET | `/api/jobs/{id}/subtitles` | 下载导出的 SRT |
| GET | `/api/jobs/{id}/styled-subtitles` | 下载保留逐条样式的 ASS |
| GET | `/api/jobs/{id}/log` | 处理日志 |
| GET | `/api/jobs/{id}/review` | 下载识别复核清单（原素材时间） |
| GET | `/api/jobs/{id}/transcript` | 下载原文转写 |

服务监听 `127.0.0.1`，拒绝外站 Origin，不提供公网访问或用户账号体系。

导入素材后，使用返回的真实 `revision` 与素材 `id` 保存：

```json
{
  "revision": 2,
  "clips": [{"source_id":"SOURCE_ID","start":2,"end":8}],
  "subtitles": {
    "SOURCE_ID":[{"start":2.2,"end":4,"text":"示例字幕"}]
  },
  "voiceovers": []
}
```

`clips` 数组决定成片顺序；剪辑和字幕都使用**原素材秒数**。导出时字幕与片段求交集并换算成成片时间。切穿一句字幕会保留文字及时间交集，可手动校对残句。

旁白字段示例：`"voiceovers":[{"source_id":"VOICE_SOURCE_ID","start":3,"volume":1}]`。旁白 `start` 使用**成片秒数**，必须完整落在成片内，音量范围0–2倍。省略该字段时保留已有旁白，传空数组清空。

字幕条目可附加可选 `style` 对象，例如 `{"start":0,"end":3,"text":"旁白","style":{"position":"top-center","color":"#ffcc55","fontSize":32,"bold":true}}`。未设置的属性使用默认值；字号及描边以1080高画布为基准等比缩放，边距为画面百分比。可用字体、九宫格位置与数值范围见 `/openapi.json` 的 `SubtitleStyle`。给旁白源设置字幕后，导出会按旁白的成片入点映射时间。

任务状态为 `queued/running/completed/failed`；处理完成后提供对应的下载文件。

识别请求接受可选的 `language`：`auto`（默认，中文及英文保留原文）、`Chinese`、`English`。混合录音使用 `auto`；单一语种模式适用于对应语种录音。识别结果的 `review_count` 和 `review_url` 提供待复核区间；识别任务的 `subtitles_url` 使用原素材时间，导出任务的同名链接使用成片时间。

## MCP

MCP stdio 入口也由 Node 提供，连接已运行的 HTTP 服务：

```powershell
node cutccc/node/cli.js mcp --api-url http://127.0.0.1:18765
```

```json
{
  "mcpServers": {
    "cutccc": {
      "command":"node",
      "args":["/absolute/path/to/cutccc/node/cli.js","mcp","--api-url","http://127.0.0.1:18765"]
    }
  }
}
```

提供9个工具：`service_status`、`list_projects`、`create_project`、`import_video`、`get_project`、`update_edit`、`transcribe_source`、`export_video`、`get_job`；提供 `cutccc://status` 资源。MCP、网页和 API 操作同一工程，长任务通过 `get_job` 轮询。

## Python 推理环境

推荐 Python **3.12**，包支持3.10以上。自动字幕使用 **Qwen3-ASR-1.7B** 和 **Qwen3-ForcedAligner-0.6B**，需要 NVIDIA CUDA 与 BF16 支持，例如 Ampere 或更新显卡。人声检测使用 `silero-vad`，其检测模型随该 Python 依赖安装，在本机 CPU 上运行。

在独立 Python 环境中安装：

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
.venv/Scripts/python.exe -m pip install -e ".[inference]"
.venv/Scripts/python.exe -m cutccc download --models-dir E:/models
```

这保留了本项目已验证的 CUDA 12.8 组合。使用与当前显卡驱动匹配的 PyTorch 构建。两个模型权重合计约6.5GB；一次短音频验证中，RTX 3060 12GB 的模型峰值显存约4.4GiB，长输入的占用会不同。

推理进程由 Node 启动：

```text
<inference-python> -u -m cutccc transcribe <source> --models-dir <models> --output <new-output-folder> --language auto
```

Python 标准输出逐行输出 JSON 事件 `detecting_speech`、`loading_asr`、`transcribed`、`loading_aligner`、`aligned`、`complete`；标准错误写入日志。Node 将事件转换为任务进度，成功后读取 `result.json`，检查工程版本并保存字幕。错误退出或中断会使任务失败，保留中间文件。

推理先在完整音频上扫描，避免仅依赖人声检测而漏掉轻声或电台声，再对原声及降噪版本检测的人声短句复听。默认由模型自动识别语种，英文不翻译为中文；中文、英文混合段按原文保存。处理完 ASR 后释放模型，再加载对齐模型。时间来自模型对齐，不按文字长度均分。

疑似遗漏、语种 / 文本冲突、无可靠时间戳的文字都会写入 `review.json` 与 `review.txt`。无时间跨度的词只在相邻短语已有测量时间时并入该短语，否则保留在报告；不会编造时间戳。局部无法对齐不会使整段识别失败。没有识别出文字时会输出空 SRT 和复核报告。

报告属于自动查漏，不代表已人工确认所有人声。重叠说话、低信噪比、强失真仍可能漏检或识别错误；纯人声检测也可能把噪声误判为疑似人声。可结合报告中的时间区间及原声 / 降噪候选进行校对。

独立命令也保留：

```powershell
.venv/Scripts/python.exe -m cutccc transcribe video.mp4 --models-dir E:/models --output E:/video-work/subtitles
node cutccc/node/cli.js transcribe video.mp4 --models-dir E:/models --inference-python E:/inference/.venv/Scripts/python.exe
```

输出目录必须尚不存在。输出包括 `subtitles.srt`、`transcript.txt`、`result.json`、`review.txt`、`review.json`、原始识别 / 对齐 JSON、人声检测结果及原声 / 降噪16kHz WAV。Windows `transcribe.cmd` 继续使用仓库的 `.venv`。

## 导出与兼容预览

导出默认 **1080p、30fps、均衡画质**，可选择 30 / 60fps、480p / 720p / 1080p / 1440p / 2160p / 原素材分辨率，以及省空间 / 均衡 / 高画质。保持首段画幅比例，不放大低分辨率素材；不足画幅补边。分辨率档位按长边限制，适用于横屏和竖屏。时间轴切点仍按 30fps 量化，60fps 导出保持相同时长和字幕时间，不使用运动补帧。

均衡档在 1080p60 使用约 4.5Mbps 视频目标码率及 128kbps AAC，配合质量控制和峰值码率上限；CPU 编码使用 CRF 与码率上限。导出窗口显示参考大小，实际大小随画面复杂度、编码器变化。HTTP / MCP 导出接受 `fps`、`resolution`、`quality`，任务记录保存这些选项。H.264 / AAC 输出可烧录中文字幕；Windows 使用 Microsoft YaHei，Linux 建议安装 `fonts-noto-cjk`。

默认 CPU 解码和 libx264 编码。支持 NVIDIA 的 FFmpeg 可在启动前设置：

```powershell
$env:CUTCCC_EXPORT_ENCODER='h264_nvenc'
$env:CUTCCC_EXPORT_HWACCEL='cuda'
npm start
```

两项可独立设置。硬件不可用时任务报错并保留日志，可清除设置后重新导出。

对浏览器不支持的原片，可在工程 `media` 目录放置 `<source_id>.preview.mp4`。代理需保留完整原片时间轴和画面比例；网页优先播放它，识别与导出继续读取原片。当前代理由外部生成。

## 验证与开发

```powershell
npm test
npm run check
python -m pip install -e ".[test]" build
python -m unittest discover -s tests -v
python -m build
```

Node 测试覆盖工程保存 / 冲突、目录锁、重启恢复、流式上传、媒体 Range、Python 工作进程事件，以及真实 FFmpeg 的静音素材、字幕换算、旁白时机、原声降低 / 恢复和完整解码。Python 测试覆盖音频切块、对齐文字、字幕时间、模型完整性、输出保护、兼容命令入口，并通过真实 MCP SDK 测试 Node stdio 服务。

GitHub Actions 在 Linux / Windows 上运行两侧测试并构建 Python 包。模型、视频、个人工程、字幕、缓存和日志不提交到仓库；测试使用临时生成的通用素材。

## 许可证

代码采用 [MIT License](LICENSE)。模型与依赖遵循各自许可证，不随项目分发。

- [Qwen3-ASR 官方项目](https://github.com/QwenLM/Qwen3-ASR)
- [Silero VAD 人声检测](https://github.com/snakers4/silero-vad)
- [Qwen3-ASR-1.7B 模型](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [Qwen3-ForcedAligner-0.6B 模型](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B)
