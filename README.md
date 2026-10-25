# cutccc

本地中文视频 / 音频转字幕。使用 **Qwen3-ASR-1.7B** 识别文字，再用 **Qwen3-ForcedAligner-0.6B** 生成时间轴，输出 SRT、转写文本和逐字时间戳。

下载好模型后，转写在本机离线进行，音视频不会上传。识别和对齐模型先后加载，降低同时占用的显存。不需要提供原文，也不会按照字数平均分配字幕时间。

> 当前是命令行工具，优先验证 Windows + NVIDIA CUDA。不是视频剪辑器，暂不提供 GUI、说话人分离、字幕翻译或自动剪辑。

## 环境

- 推荐 Python **3.12**；包声明支持 Python 3.10 及以上，完整推理环境已在 3.12 上验证。
- NVIDIA 显卡、可用驱动、支持 CUDA 的 PyTorch；当前推理使用 BF16，需要支持该精度的 GPU，例如 Ampere 或更新架构。
- FFmpeg 在 `PATH` 中，运行 `ffmpeg -version` 应能显示版本。
- 两个模型的权重合计约 **6.5 GB**，另需空间安装 Python 依赖和 PyTorch。
- 一次清晰短音频验证中，RTX 3060 12GB 可运行，模型峰值显存分配约 4.4 GiB；这不是所有输入的资源上限。

当前没有 CPU / Apple Silicon 推理路径。无需安装 FlashAttention，默认使用 PyTorch SDPA。

## 安装

```bash
git clone https://github.com/wzj998/cutccc.git
cd cutccc
python -m venv .venv
```

激活环境：

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```bash
# Linux
source .venv/bin/activate
```

按 [PyTorch 官方安装选择器](https://pytorch.org/get-started/locally/) 安装适合驱动的 CUDA 版本。下面是本项目验证过的 CUDA 12.8 组合，要求驱动支持相应运行时：

```bash
python -m pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
python -m pip install -e ".[inference]"
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
