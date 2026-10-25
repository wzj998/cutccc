# cutccc

本地视频剪辑与中文字幕工作台。通过 **网页 UI、本地 HTTP API 或 MCP** 导入视频、分段裁剪、重排拼接、编辑字幕，并导出 MP4 和 SRT。三个入口共用同一份项目。

下载好模型后，转写在本机离线进行，音视频不会上传。识别和对齐模型先后加载，降低同时占用的显存。不需要提供原文，也不会按照字数平均分配字幕时间。

语音识别使用 **Qwen3-ASR-1.7B**，时间轴使用 **Qwen3-ForcedAligner-0.6B**。原有命令行转字幕功能保留。当前是单轨基础剪辑，不包含独立背景音乐轨道、转场、说话人分离或字幕翻译。

## 网页剪辑快速开始

```powershell
git clone https://github.com/wzj998/cutccc.git
cd cutccc
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[web,mcp]"
cutccc serve
```

上面是 Windows PowerShell 示例。Linux 的激活命令为 `source .venv/bin/activate`；也可以直接用虚拟环境内的 Python 执行 `-m cutccc serve`。

打开 **http://127.0.0.1:18765/**。剪辑和导出只需 FFmpeg / ffprobe，不需要显卡或语音模型；自动生成字幕还需安装下文的推理依赖并下载模型。

网页支持：

- 导入一个或多个视频，素材复制到本地项目目录，原文件保留。
- 预览视频，在时间线上定位；设置入点 / 出点，在播放头处分割。
- 拖动片段或用按钮调整顺序、重复使用素材、删除片段。
- 自动生成中文字幕，修改每条字幕的文字和起止时间。
- 保存项目，导出 H.264 / AAC MP4，选择是否将字幕嵌入画面，同时下载重排后的 SRT。
- 查看后台任务进度、失败日志和导出结果。

快捷键：空格播放 / 暂停，`I` 设置入点，`O` 设置出点，`S` 分割，`Ctrl/Cmd + S` 保存。

```bash
cutccc serve --port 18765 --data-dir ./private/studio --models-dir ./models
```

项目默认存放在 `~/.local/share/cutccc`，也可设置 `CUTCCC_DATA_DIR`。模型目录与命令行共用。已有独立推理环境时，可通过 `--inference-python /path/to/python` 或 `CUTCCC_INFERENCE_PYTHON` 指定，其中也需安装 cutccc 和推理依赖。

服务固定监听回环地址，不提供公网访问或用户账号体系。浏览器外站请求会被拒绝，本地程序可直接调用 API。同一个数据目录只允许一个服务实例；服务内识别与导出任务串行执行。重启后保留项目和任务记录，中断任务会标记失败，需要重新提交。

## 本地 API

服务启动后，访问 **http://127.0.0.1:18765/api-docs** 查看本地文档；**`/openapi.json`** 提供机器可读接口定义。网页及文档的静态文件都随 Python 包提供，不依赖 CDN。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务与模型文件状态 |
| GET / POST | `/api/projects` | 列出 / 创建项目 |
| GET / PATCH | `/api/projects/{id}` | 读取 / 保存剪辑方案 |
| POST | `/api/projects/{id}/sources/upload` | multipart 文件上传，字段 `file` |
| POST | `/api/projects/{id}/sources/import` | 导入本机路径，JSON 字段 `path` |
| POST | `/api/projects/{id}/transcribe` | 生成某素材字幕，字段 `source_id` |
| POST | `/api/projects/{id}/export` | 导出快照，字段 `burn_subtitles` |
| GET | `/api/projects/{id}/jobs` | 项目任务列表 |
| GET | `/api/jobs/{id}` | 任务状态与结果 URL |
| GET | `/api/jobs/{id}/video` | 下载导出的 MP4 |
| GET | `/api/jobs/{id}/subtitles` | 下载导出的 SRT |
| GET | `/api/jobs/{id}/log` | 查看处理日志 |

创建项目：

```bash
curl -X POST http://127.0.0.1:18765/api/projects -H "Content-Type: application/json" -d '{"title":"我的剪辑"}'
```

导入素材后读取项目，使用返回的真实 `revision` 与素材 `id` 保存剪辑：

```json
{
  "revision": 2,
  "clips": [
    {"source_id": "SOURCE_ID", "start": 2.0, "end": 8.0},
    {"source_id": "SOURCE_ID", "start": 12.0, "end": 20.0}
  ],
  "subtitles": {
    "SOURCE_ID": [{"start": 2.2, "end": 4.0, "text": "示例字幕"}]
  }
}
```

`clips` 的数组顺序决定输出顺序。时间均为秒；字幕使用**原素材时间**，导出时按片段重排。如果裁剪穿过一句字幕，保留交集时间和原字幕文字，请按需要修改残句。

保存时版本过期返回 `409`，避免不同入口互相覆盖。后台识别也不会覆盖处理期间手动修改的字幕。导出采用提交时的项目快照；后续修改不会改变正在导出的内容。任务返回 `queued/running/completed/failed`，只有完成的任务提供可下载结果。

## MCP

MCP 通过 stdio 启动，并桥接到已运行的本地 HTTP 服务，不额外创建一套项目数据库：

```bash
cutccc mcp --api-url http://127.0.0.1:18765
```

通用 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "cutccc": {
      "command": "/absolute/path/to/venv/python",
      "args": ["-m", "cutccc", "mcp", "--api-url", "http://127.0.0.1:18765"]
    }
  }
}
```

将 `command` 替换为安装了 cutccc 的 Python **绝对路径**，Windows 通常为虚拟环境中的 `Scripts/python.exe`。保持 `cutccc serve` 运行。

提供 9 个工具：`service_status`、`list_projects`、`create_project`、`import_video`、`get_project`、`update_edit`、`transcribe_source`、`export_video`、`get_job`，以及 `cutccc://status` 资源。先读取项目版本，再修改并保存；长任务用 `get_job` 轮询。MCP 的导出结果包含可访问的完整下载 URL。

当前适配官方 MCP Python SDK 1.x 维护线（依赖上界 `<2`），通过真实 stdio 客户端初始化、工具调用及资源读取测试。

## 自动字幕的环境要求

- 推荐 Python **3.12**；包声明支持 Python 3.10 及以上，完整推理环境已在 3.12 上验证。
- NVIDIA 显卡、可用驱动、支持 CUDA 的 PyTorch；当前推理使用 BF16，需要支持该精度的 GPU，例如 Ampere 或更新架构。
- FFmpeg 在 `PATH` 中，运行 `ffmpeg -version` 应能显示版本。
- 两个模型的权重合计约 **6.5 GB**，另需空间安装 Python 依赖和 PyTorch。
- 一次清晰短音频验证中，RTX 3060 12GB 可运行，模型峰值显存分配约 4.4 GiB；这不是所有输入的资源上限。

当前字幕识别没有 CPU / Apple Silicon 推理路径。无需安装 FlashAttention，默认使用 PyTorch SDPA；不使用自动字幕时，网页剪辑和 FFmpeg 导出可在 CPU 上运行。

## 安装语音推理依赖

在已经激活的 cutccc 虚拟环境中执行以下命令，无需重新克隆仓库。

按 [PyTorch 官方安装选择器](https://pytorch.org/get-started/locally/) 安装适合驱动的 CUDA 版本。下面是本项目验证过的 CUDA 12.8 组合，要求驱动支持相应运行时：

```bash
python -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
python -m pip install -e ".[inference,web,mcp]"
```

FFmpeg 可从 [官方网站](https://ffmpeg.org/download.html) 获取，或使用系统包管理器安装。
Windows 不方便激活环境时，可直接用 `.venv\Scripts\python.exe` 代替上述 `python`。

## 下载模型

```bash
cutccc download
```

默认目录为 `~/.cache/cutccc/models`，从官方 Qwen Hugging Face 仓库下载。只有这个步骤需要访问网络；下载中断后可重新运行。

已有模型时可以指定目录，无需重复下载：

```bash
cutccc download --models-dir ./models
cutccc transcribe ./video.mp4 --models-dir ./models
```

目录结构：

```text
models/
  Qwen3-ASR-1.7B/
    config.json
    model.safetensors.index.json
    model-00001-of-00002.safetensors
    model-00002-of-00002.safetensors
    ...
  Qwen3-ForcedAligner-0.6B/
    config.json
    model.safetensors
    ...
```

也可设置环境变量 `CUTCCC_MODELS_DIR`。模型应包含官方配置、分词器和全部权重文件。

## 生成字幕

```bash
cutccc transcribe ./video.mp4
cutccc transcribe ./audio.wav --output ./outputs/demo
python -m cutccc transcribe ./video.mp4
```

Windows 安装完成后，可将视频拖到根目录的 **`transcribe.cmd`** 上。该入口使用本仓库的 `.venv` 环境。

默认在输入文件旁创建 `<文件名>-subtitles/`：

| 文件 | 内容 |
| --- | --- |
| `subtitles.srt` | 可导入播放器、剪辑软件或 Subtitle Edit 的字幕 |
| `transcript.txt` | 原始识别文字 |
| `result.json` | 模型、逐字时间戳、字幕条目、耗时与显存统计 |
| `asr-raw.json` | 各音频分段的原始识别结果 |
| `alignment-raw.json` | 原始对齐结果，便于检查时间轴问题 |
| `audio-16k.wav` | 从输入文件提取的单声道音频 |

为保护已有结果，**输出目录必须不存在**；再次处理时指定新的 `--output`。失败时保留中间文件用于诊断。

可使用 [Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) 打开 SRT 和原视频校对。cutccc 不捆绑该软件，也不修改其设置。

## 工作方式与边界

1. FFmpeg 提取 16kHz 单声道音频。
2. 在约 25 秒附近的低能量位置切块，不丢弃样本。
3. Qwen3-ASR 在没有参考文案的情况下识别中文。
4. 释放识别模型，再加载对齐模型，估计每个字 / 词在音频中的起止时间。
5. 按标点、停顿、长度整理字幕，并检查时间顺序、重叠和范围。

低能量切块不是完整 VAD。噪声、多人重叠、口音及生僻词可能导致错误；请校对重要内容。字幕通常限制在 22 字 / 6 秒内，但不会为了满足长度限制而拆开单个对齐单位或虚构时间。没有可靠时间跨度时会报错并保留中间结果。

推理分块进行，但当前版本会把整段音频载入内存；超长文件可能需要较多内存。模型加载与处理时间不含 Python 启动及依赖导入时间，显存指标只统计 PyTorch 分配 / 预留的部分。

## 开发与验证

```bash
python -m pip install -e ".[test]"
python -m unittest discover -s tests -v
```

自动测试不下载模型、不使用 GPU，覆盖文字与标点保留、切块连续性、时间格式、无效时间轴拒绝、模型完整性检查以及输出覆盖保护。GitHub Actions 在 Linux / Windows 上运行这些测试并构建 Python 包。

网页 / API / MCP 测试还覆盖项目持久化、冲突保护、识别期间手动编辑保护、导出快照、媒体 Range 请求和真实 MCP stdio 调用。安装了 FFmpeg 时，使用临时生成的红蓝视频验证片段重排、无音轨输入、字幕换算和完整解码。Linux CI 安装 FFmpeg 运行这些导出测试。

网页预览依赖浏览器支持的视频编码；无法预览的素材仍可尝试通过 FFmpeg 导出。导出使用首段素材画幅（长边最多 1920），保持各素材比例并补边，统一为 30 fps；片段长度会量化到视频帧。Linux 烧录中文字幕建议安装 `fonts-noto-cjk`。当前没有自动清理素材和任务文件的功能，管理本地数据目录时请保留需要的项目。

真实模型验证需要额外安装推理依赖和本地模型：

```bash
cutccc transcribe ./sample.mp4 --models-dir ./models --output ./outputs/smoke-test
```

请使用自行准备、获授权的输入。模型、输入视频、输出字幕、个人配置和运行日志不提交到仓库；`.gitignore` 已覆盖常见路径与格式。测试用例只保留通用合成数据。

## 许可证与模型

cutccc 代码采用 [MIT License](LICENSE)。模型和依赖遵循各自许可证，不随本仓库分发。

- [Qwen3-ASR 官方项目](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen3-ASR-1.7B 模型](https://huggingface.co/Qwen/Qwen3-ASR-1.7B)
- [Qwen3-ForcedAligner-0.6B 模型](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B)
