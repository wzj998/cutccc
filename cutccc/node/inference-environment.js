import path from 'node:path';
import {fileURLToPath} from 'node:url';

// npm installs need to find the bundled Python package from any working directory.
export const packageRoot=fileURLToPath(new URL('../../',import.meta.url));
export function inferenceEnvironment(env=process.env) {
  return {...env,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1',
    PYTHONPATH:[packageRoot,env.PYTHONPATH].filter(Boolean).join(path.delimiter)};
}
