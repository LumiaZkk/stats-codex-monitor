import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function assertCleanEnvironment() {
  assert.equal(process.env.NODE_ENV,'test');
  for(const name of ['CONTROL_PLANE_API_KEY','OPENAI_API_KEY','OPENAI_ADMIN_KEY','NODE_OPTIONS','NODE_PATH','CODEX_HOME','TUNNEL_CLIENT_CODEX_APP_SERVER_COMMAND'])assert.equal(process.env[name],undefined,`${name} must be absent before importing the MCP server`);
  assert(process.env.HOME);
  await writeFile(join(process.env.HOME,'stdio-environment-verified.json'),'{"key_absent":true,"ambient_hooks_absent":true}\n',{mode:0o600,flag:'wx'});
}
