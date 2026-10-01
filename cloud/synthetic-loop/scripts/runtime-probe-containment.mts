// Isolated fake values only. Sentinels fail any unexpected PATH-based Codex/git
// attempt; no Codex executable, credentials or user configuration are accessed.
import assert from 'node:assert/strict';
import { mkdir,writeFile,readdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdioRuntimeCommand } from '../tunnel/runtime-environment.mts';
export async function prepareContainment(dir:string,server:string,key:string) {
  const guards=join(dir,'command-guards'),attempts=join(dir,'unexpected-commands');
  await mkdir(guards,{mode:0o700});await mkdir(attempts,{mode:0o700});
  assert(/^[a-zA-Z0-9/_.-]+$/.test(attempts));
  for(const name of ['codex','git','git-remote-https','zsh'])await writeFile(join(guards,name),`#!/bin/sh\nprintf blocked > '${attempts}/${name}'\nexit 97\n`,{mode:0o700});
  const serverEnv={PATH:'/usr/bin:/bin',HOME:dir,XDG_CONFIG_HOME:dir,NODE_ENV:'test',STATS_TUNNEL_RUN_DIR:dir,STATS_RUNTIME_USER_HOME:dir};
  return {
    command:stdioRuntimeCommand(process.execPath,server,serverEnv),
    env:{PATH:guards,HOME:dir,XDG_CONFIG_HOME:dir,CONTROL_PLANE_API_KEY:key,NODE_OPTIONS:'--require=/fixture-must-not-load.cjs',NODE_PATH:'/fixture-must-not-load',CODEX_HOME:'/fixture-must-not-read'},
    async assertPassed(){
      assert.deepEqual(await readdir(attempts),[],'Runtime must not attempt Codex/git/shell companions');
      assert.deepEqual(JSON.parse(await readFile(join(dir,'stdio-environment-verified.json'),'utf8')),{key_absent:true,ambient_hooks_absent:true});
    },
  };
}
