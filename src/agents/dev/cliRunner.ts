import { execFile, ChildProcess } from 'child_process';
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
 */
export function runClaudeCLI(prompt: string, timeoutMs = 300_000): Promise<CLIResult> {
  return new Promise((resolve) => {
    logger.info('Claude CLI実行開始', { promptLength: prompt.length });

    const child: ChildProcess = execFile('npx', [
      '-y', '@anthropic-ai/claude-code',
      '-p',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      prompt,
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.claude.apiKey,
      },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (error, stdout, stderr) => {
      if (error) {
        // タイムアウト時は子プロセスを確実にkill（孤児プロセス防止）
        if (child.pid && error.message?.includes('TIMEOUT')) {
          try { process.kill(child.pid, 'SIGKILL'); } catch { /* already dead */ }
        }
        logger.warn('Claude CLI実行エラー', { err: error.message.slice(0, 300) });
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
  });
}
