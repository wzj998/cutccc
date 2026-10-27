import path from 'node:path';
import {launch} from './processes.js';

export async function openFolder(folder, {platform=process.platform, spawnProcess=launch} = {}) {
  if (!path.isAbsolute(folder)) throw new Error('Export folder must be an absolute path');
  const command = {win32:'explorer.exe',darwin:'open',linux:'xdg-open'}[platform];
  if (!command) throw new Error('Opening folders is not supported on this system');
  // A visible file manager is explicitly requested by the user's button click. No shell is involved.
  const child = spawnProcess(command,[folder],{detached:true,stdio:'ignore',windowsHide:false});
  await new Promise((resolve,reject) => {child.once('error',reject);child.once('spawn',resolve);});
  child.unref();
}
