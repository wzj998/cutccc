import {capture} from './processes.js';
import {APIError} from './editing.js';
import path from 'node:path';

// A native dialog returns paths to the local service; no file data passes through the browser.
export function localPickerCommand(platform = process.platform) {
  if (platform !== 'win32') throw new APIError('当前系统请使用“输入本机路径”直接引用视频。', 501);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$picker = New-Object System.Windows.Forms.OpenFileDialog
$picker.Title = '导入本机视频（直接引用原片）'
$picker.Filter = '视频文件|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v;*.mts;*.m2ts|所有文件|*.*'
$picker.Multiselect = $true
$picker.CheckFileExists = $true
$picker.AutoUpgradeEnabled = $false
$picker.InitialDirectory = [Environment]::GetFolderPath('MyVideos')
try {
  if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    ConvertTo-Json -InputObject @($picker.FileNames) -Compress
  } else { '[]' }
} finally { $picker.Dispose() }
`;
  return {command:'powershell.exe',args:['-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
}

export async function pickLocalFiles({platform=process.platform,run=capture} = {}) {
  const {command,args} = localPickerCommand(platform);
  const result = await run(command,args,{timeout:10*60*1000,maxBytes:1024*1024,windowsHide:true});
  let paths;
  try { paths = JSON.parse(result.stdout.replace(/^\uFEFF/,'').trim()); }
  catch { throw new APIError('无法读取本机文件选择结果，请使用“输入本机路径”。',503); }
  if (!Array.isArray(paths) || paths.length > 64 || paths.some(file=>typeof file!=='string'||!path.isAbsolute(file)))
    throw new APIError('Invalid local file selection',400);
  return {paths:[...new Set(paths)],cancelled:paths.length===0};
}
