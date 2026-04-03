import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface CLIResult {
  success: boolean;
  output: string;
  authUsed: 'subscription' | 'api';
}

// サブスクモード時の直列化用mutex（OAuth .credentials.json競合防止）
let cliMutex: Promise<void> = Promise.resolve();

/**
 * Claude CLIを非対話モード (-p) で実行する。
 *
 * 認証モード（config.cli.authMode）:
 *   - 'subscription': サブスクOAuth → 直列化 + 失敗時APIキーフォールバック
 *   - 'api': APIキー認証 → 並列実行可能
 */
export function runClaudeCLI(
  prompt: string,
  model: 'sonnet' | 'opus' = 'sonnet',
  timeoutMs = 300_000,
): Promise<CLIResult> {
  if (config.cli.authMode === 'subscription') {
    // サブスクモード: 直列化して並列競合を回避
    const current = cliMutex;
    let resolveNext: () => void;
    cliMutex = new Promise(r => { resolveNext = r; });

    return current.then(async () => {
      try {
        const result = await executeCLI(prompt, model, timeoutMs, 'subscription');
        if (result.success) return result;

        // 認証/レート制限エラーのみAPIキーにフォールバック
        if (isAuthOrRateLimitError(result.output)) {
          logger.warn('サブスクCLI失敗 → APIキーにフォールバック', {
            err: result.output.slice(0, 100),
          });
          return executeCLI(prompt, model, timeoutMs, 'api');
        }

        // コード生成失敗等はそのまま返す（devAgentのレビューループで処理）
        return result;
      } finally {
        resolveNext!();
      }
    });
  }

  // APIモード: 直列化不要、並列実行可能
  return executeCLI(prompt, model, timeoutMs, 'api');
}

function executeCLI(
  prompt: string,
  model: 'sonnet' | 'opus',
  timeoutMs: number,
  authMode: 'subscription' | 'api',
): Promise<CLIResult> {
  return new Promise((resolve) => {
    const modelName = model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

    logger.info('Claude CLI実行開始', {
      promptLength: prompt.length,
      model,
      authMode,
    });

    // 認証モードに応じた環境変数
    const env: Record<string, string | undefined> = { ...process.env };
    if (authMode === 'subscription') {
      // ANTHROPIC_API_KEYを除外 → OAuthにフォールバック
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = config.claude.apiKey;
    }

    const child: ChildProcess = spawn('npx', [
      '-y', '@anthropic-ai/claude-code',
      '-p',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', modelName,
      '--allowedTools', 'Read,Edit,Write,Bash(npm run build),Bash(git *),Glob,Grep',
    ], {
      cwd: PROJECT_ROOT,
      env,
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

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      logger.warn('Claude CLI タイムアウト', { timeoutMs, authMode });
      resolve({
        success: false,
        output: (stdout + '\n' + stderr).trim().slice(-3000),
        authUsed: authMode,
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn('Claude CLI実行エラー', {
          code,
          authMode,
          err: (stderr || stdout).slice(0, 300),
        });
        resolve({
          success: false,
          output: (stdout + '\n' + stderr).trim().slice(-3000),
          authUsed: authMode,
        });
      } else {
        logger.info('Claude CLI実行完了', {
          outputLength: stdout.length,
          authMode,
        });
        resolve({
          success: true,
          output: stdout.trim(),
          authUsed: authMode,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('Claude CLI起動失敗', { err: err.message, authMode });
      resolve({
        success: false,
        output: err.message,
        authUsed: authMode,
      });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function isAuthOrRateLimitError(output: string): boolean {
  const patterns = [
    'rate_limit', 'Rate limit',
    'authentication_error', 'authentication',
    '401', 'OAuth',
    'credit balance', 'Not logged in',
    'token has expired',
  ];
  return patterns.some(p => output.includes(p));
}
