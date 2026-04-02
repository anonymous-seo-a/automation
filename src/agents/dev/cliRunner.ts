import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface CLIResult {
  success: boolean;
  output: string;
}

/**
 * Claude CLIを非対話モード (-p) で実行する。
 * CLIがファイル読み書き・ビルドチェックまで自律実行する。
 * プロンプトはstdin経由で渡す（コマンドライン引数長制限を回避）。
 */
export function runClaudeCLI(
  prompt: string,
  model: 'sonnet' | 'opus' = 'sonnet',
  timeoutMs = 300_000,
): Promise<CLIResult> {
  return new Promise((resolve) => {
    logger.info('Claude CLI実行開始', { promptLength: prompt.length, model });

    const child: ChildProcess = spawn('npx', [
      '-y', '@anthropic-ai/claude-code',
      '-p',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6',
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.claude.apiKey,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // タイムアウト管理
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      logger.warn('Claude CLI タイムアウト', { timeoutMs });
      resolve({
        success: false,
        output: (stdout + '\n' + stderr).trim().slice(-3000),
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn('Claude CLI実行エラー', { code, err: (stderr || stdout).slice(0, 300) });
        resolve({
          success: false,
          output: (stdout + '\n' + stderr).trim().slice(-3000),
        });
      } else {
        logger.info('Claude CLI実行完了', { outputLength: stdout.length });
        resolve({
          success: true,
          output: stdout.trim(),
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('Claude CLI起動失敗', { err: err.message });
      resolve({
        success: false,
        output: err.message,
      });
    });

    // プロンプトをstdinに書き込んで閉じる
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
