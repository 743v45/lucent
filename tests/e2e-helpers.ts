/**
 * E2E 测试共享基础设施
 *
 * 提供后端启动/停止、临时目录管理、端口分配等共享工具
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ==================== 测试目录管理 ====================

export interface TestEnv {
  configDir: string;
  logDir: string;
  configPath: string;
  proxyPort: number;
  webPort: number;
}

/**
 * 创建隔离的测试环境（临时目录 + 随机端口）
 */
export function createTestEnv(prefix: string): TestEnv {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const configDir = join(tmpdir(), `lucent-test-${id}`);
  const logDir = join(configDir, 'logs');
  const configPath = join(configDir, 'config.json');
  // 随机端口：30000-60000 范围内
  const proxyPort = 30000 + Math.floor(Math.random() * 30000);
  const webPort = proxyPort + 1;

  return { configDir, logDir, configPath, proxyPort, webPort };
}

/**
 * 清理并重建测试目录
 */
export async function cleanTestDir(env: TestEnv): Promise<void> {
  if (existsSync(env.configDir)) {
    await rm(env.configDir, { recursive: true, force: true });
  }
  await mkdir(env.configDir, { recursive: true });
  await mkdir(env.logDir, { recursive: true });
}

/**
 * 删除测试目录
 */
export async function removeTestDir(env: TestEnv): Promise<void> {
  if (existsSync(env.configDir)) {
    await rm(env.configDir, { recursive: true, force: true });
  }
}

/**
 * 写入测试配置文件
 */
export async function writeTestConfig(env: TestEnv, config: Record<string, unknown>): Promise<void> {
  await writeFile(env.configPath, JSON.stringify(config, null, 2));
}

// ==================== 后端进程管理 ====================

let backendProcess: ChildProcess | null = null;

/**
 * 启动后端服务
 */
export async function startBackend(env: TestEnv): Promise<void> {
  // 杀掉残留进程
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'server/index.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LUCENT_CONFIG_DIR: env.configDir,
        LUCENT_HOST: '127.0.0.1',
        LUCENT_PROXY_PORT: String(env.proxyPort),
        LUCENT_WEB_PORT: String(env.webPort),
        LUCENT_LOG_DIR: env.logDir,
      },
    });

    let output = '';
    proc.stderr?.on('data', (data) => { output += data.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Server startup timeout. Output: ${output}`));
    }, 20000);

    proc.stdout?.on('data', (data) => {
      output += data.toString();
      if (output.includes('Lucent') || output.includes('代理')) {
        clearTimeout(timeout);
        backendProcess = proc;
        resolve();
      }
    });

    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    proc.on('exit', (code) => {
      if (code && code !== 0) { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); }
    });
  });
}

/**
 * 停止后端服务
 */
export async function stopBackend(): Promise<void> {
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    backendProcess = null;
  }
}

// ==================== 日志读取 ====================

/**
 * 读取最新的 JSONL 日志文件
 */
export async function readLatestLog(logDir: string): Promise<Array<Record<string, unknown>> | null> {
  const files = await readdir(logDir);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse();
  if (jsonlFiles.length === 0) return null;

  const content = await readFile(join(logDir, jsonlFiles[0]), 'utf-8');
  return content.split(/\n---\n?/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return {}; }
  });
}
