/** Preserve the original selftest under an isolated, deliberately unconfigured environment. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'lr-offline-check-'));
const config=path.join(temporary,'interfaces.json');
fs.writeFileSync(config,JSON.stringify({execution_mode:'dry_run',interfaces:{}}));
const env:NodeJS.ProcessEnv={...process.env,LR_RUNTIME_DIR:path.join(temporary,'runtime'),LR_DATA_ROOT:path.join(temporary,'agent'),LR_INTERFACES_CONFIG:config};
// An explicit empty value prevents app/.env from reloading a real key during offline checks.
env.DEEPSEEK_API_KEY='';
env.OPENROUTER_API_KEY='';
env.LR_MODEL_PROVIDER='deepseek';
env.LR_MODEL_ID='deepseek-flash';
env.DEEPSEEK_BASE_URL='https://api.deepseek.com';
try{
  const result=spawnSync(process.execPath,['--import','tsx','src/selftest.ts'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:'inherit'});
  process.exitCode=result.status??1;
}finally{
  fs.rmSync(temporary,{recursive:true,force:true});
}
