#!/usr/bin/env node
/**
 * bin/cli.js — thin wrapper
 *
 * 后端是纯 TS（靠 tsx 运行、无编译产物），故 package.json 的 bin 不能直接指向 cli.ts。
 * 这里用 `node --import tsx` 加载 cli.ts，让 `lucent` / `node bin/cli.js` 真正可执行，
 * argv 透传给 cli.ts（commander 在 cli.ts 里 parse）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliTs = join(here, 'cli.ts');

const child = spawn(
  process.execPath,
  ['--import', 'tsx', cliTs, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env },
);

child.on('error', (err) => {
  console.error('[lucent] CLI 启动失败:', err.message);
  process.exit(1);
});
child.on('exit', (code) => {
  process.exit(code ?? 1);
});
