import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';
import { v4 as uuidv4 } from 'uuid';

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export async function runInSandbox(
  code: string,
  language: 'node' | 'python' | 'bash' = 'node'
): Promise<SandboxResult> {
  const runId = uuidv4();
  const dir = path.join(config.sandbox.dir, runId);
  await fs.mkdir(dir, { recursive: true });

  const ext = language === 'node' ? 'js' : language === 'python' ? 'py' : 'sh';
  const filePath = path.join(dir, `run.${ext}`);
  await fs.writeFile(filePath, code, 'utf-8');

  const cmd =
    language === 'node' ? `node "${filePath}"` :
    language === 'python' ? `python3 "${filePath}"` :
    `bash "${filePath}"`;

  return new Promise((resolve) => {
    exec(cmd, {
      timeout: config.sandbox.timeoutMs,
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'sandbox' },
    }, async (error, stdout, stderr) => {
      // クリーンアップ
      try { await fs.rm(dir, { recursive: true }); } catch { /* ignore */ }

      resolve({
        success: !error,
        stdout: stdout.toString().slice(0, 5000),
        stderr: stderr.toString().slice(0, 5000),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      });
    });
  });
}
