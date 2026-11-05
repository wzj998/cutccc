"""Offline Qwen3-TTS VoiceDesign worker; no GPU imports before invocation."""
import argparse
import json
import os
import re
from pathlib import Path

def split_text(text, maximum=160):
    pieces=[]
    for sentence in re.split(r'(?<=[。！？!?；;\n])', text):
        while len(sentence)>maximum:
            boundary=max(sentence.rfind(mark,0,maximum+1) for mark in '，,、 ')
            boundary=boundary+1 if boundary>=maximum//2 else maximum
            if sentence[:boundary].strip():pieces.append(sentence[:boundary].strip())
            sentence=sentence[boundary:]
        if sentence.strip():pieces.append(sentence.strip())
    return pieces

def emit(stage, **data):
    print(json.dumps(dict(stage=stage,**data),ensure_ascii=False),flush=True)

def check_runtime(model_dir):
    if not (model_dir/'config.json').is_file():raise ValueError('找不到语音模型配置，请检查模型目录。')
    config=json.loads((model_dir/'config.json').read_text(encoding='utf-8'))
    if config.get('tts_model_type')!='voice_design':raise ValueError('请选择 Qwen3-TTS VoiceDesign 模型目录。')
    if not any(model_dir.glob('*.safetensors')):raise ValueError('语音模型权重不完整。')
    import torch
    import qwen_tts
    if not torch.cuda.is_available():raise RuntimeError('本地语音合成需要可用的 NVIDIA CUDA 环境。')
    if not torch.cuda.is_bf16_supported():raise RuntimeError('语音模型需要支持 BF16 的 NVIDIA 显卡。')
    return {'ready':True,'provider':'Qwen3-TTS VoiceDesign'}

def generate(model_dir, request_file, output):
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    request=json.loads(request_file.read_text(encoding='utf-8'))
    output.mkdir(parents=True,exist_ok=False)
    pieces=split_text(request['text'])
    if not pieces or len(request['text'])>1000:raise ValueError('配音文字无效。')
    emit('speech_loading',chunks=len(pieces))
    torch.set_num_threads(8)
    model=Qwen3TTSModel.from_pretrained(str(model_dir),device_map='cuda:0',dtype=torch.bfloat16,attn_implementation='sdpa')
    parts=[];cues=[];cursor=0;sample_rate=None
    for index,text in enumerate(pieces):
        emit('speech_generating',index=index,chunks=len(pieces))
        torch.manual_seed(42);torch.cuda.manual_seed_all(42)
        with torch.inference_mode():
            wavs,sr=model.generate_voice_design(text=text,language=request['language'],instruct=request['instruction'],max_new_tokens=2048)
        audio=np.asarray(wavs[0],dtype=np.float32).reshape(-1)
        if not len(audio) or not np.isfinite(audio).all() or float(np.max(np.abs(audio)))<.0001:raise RuntimeError('模型没有生成有效的人声音频。')
        if sample_rate and sample_rate!=sr:raise RuntimeError('语音采样率不一致。')
        sample_rate=sr
        if parts:
            silence=np.zeros(round(sr*.12),dtype=np.float32);parts.append(silence);cursor+=len(silence)
        start=cursor/sr;parts.append(audio);cursor+=len(audio)
        cues.append({'start':start,'end':cursor/sr,'text':text})
    sf.write(output/'raw.wav',np.concatenate(parts),sample_rate,subtype='PCM_16')
    (output/'result.json').write_text(json.dumps({'sample_rate':sample_rate,'duration':cursor/sample_rate,'cues':cues},ensure_ascii=False,indent=2),encoding='utf-8')
    emit('speech_complete',duration=cursor/sample_rate)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--models-dir',type=Path,required=True)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--request',type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',TOKENIZERS_PARALLELISM='false')
    check=check_runtime(args.models_dir)
    if args.check:print(json.dumps(check),flush=True);return
    if not args.request or not args.output:parser.error('--request and --output are required')
    generate(args.models_dir,args.request,args.output)

if __name__=='__main__':
    try:main()
    except Exception as error:
        import sys
        print('本地语音合成失败：'+str(error),file=sys.stderr);sys.exit(1)
