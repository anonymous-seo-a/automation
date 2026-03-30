import { exec, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_PORT = 3999;
const TEST_DB_PATH = './data/test.db';
const STARTUP_WAIT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;

export interface TestResult {
  passed: boolean;
  stage: 'build' | 'startup' | 'functional';
  message: string;
  details?: string;
}

/** テスト用サーバープロセスを保持（確実にkillするため） */
let testServerProcess: ChildProcess | null = null;

function killTestServer(): void {
  if (testServerProcess) {
    try {
      testServerProcess.kill('SIGTERM');
      // SIGTERMが効かない場合に備え 2秒後にSIGKILL
      const pid = testServerProcess.pid;
      setTimeout(() => {
        try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 2000);
    } catch { /* already dead */ }
    testServerProcess = null;
  }
}

async function cleanupTestDb(): Promise<void> {
  const dbPath = path.resolve(PROJECT_ROOT, TEST_DB_PATH);
  try {
    await fs.unlink(dbPath);
    logger.info('[tester] テストDB削除完了', { path: dbPath });
  } catch {
    // ファイルがなければ無視
  }
  // WALファイルも削除
  for (const suffix of ['-wal', '-shm']) {
    try { await fs.unlink(dbPath + suffix); } catch { /* ignore */ }
  }
}

// ── テスト1: 起動テスト ──────────────────────────────

export async function runStartupTest(): Promise<TestResult> {
  killTestServer(); // 前回の残骸があれば掃除
  await cleanupTestDb();

  return new Promise<TestResult>((resolve) => {
    let settled = false;
    const settle = (result: TestResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    // テスト用サーバーを別ポートで起動
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      NODE_ENV: 'test',
      DB_PATH: TEST_DB_PATH,
    };

    let stderr = '';
    testServerProcess = exec(
      'npx tsx src/index.ts',
      { cwd: PROJECT_ROOT, env, timeout: STARTUP_WAIT_MS + 15_000 },
    );

    testServerProcess.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    testServerProcess.on('exit', (code) => {
      if (!settled) {
        settle({
          passed: false,
          stage: 'startup',
          message: `テスト用サーバーが起動前に終了 (code: ${code})`,
          details: stderr.slice(0, 1500),
        });
      }
    });

    // 起動待ち → ヘルスチェック
    setTimeout(async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

        const res = await fetch(`http://localhost:${TEST_PORT}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.status === 200) {
          settle({
            passed: true,
            stage: 'startup',
            message: `テスト用サーバー起動成功 (port ${TEST_PORT})`,
          });
        } else {
          const body = await res.text().catch(() => '');
          settle({
            passed: false,
            stage: 'startup',
            message: `ヘルスチェック失敗: HTTP ${res.status}`,
            details: body.slice(0, 500),
          });
        }
      } catch (err) {
        settle({
          passed: false,
          stage: 'startup',
          message: 'ヘルスチェック接続失敗（サーバーが応答しない）',
          details: (err instanceof Error ? err.message : String(err)) + '\n\nstderr:\n' + stderr.slice(0, 1000),
        });
      }
    }, STARTUP_WAIT_MS);
  });
}

// ── テスト2: 機能テスト ──────────────────────────────

export async function runFunctionalTest(): Promise<TestResult> {
  const errors: string[] = [];

  // 1. /test/task エンドポイント確認
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const res = await fetch(`http://localhost:${TEST_PORT}/test/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'テスト' }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 200) {
      logger.info('[tester] /test/task: OK');
    } else {
      // テスト環境ではClaude API呼び出しが失敗する可能性があるので
      // 500でもルートが存在すること自体は確認できる
      if (res.status === 404) {
        errors.push(`/test/task: 404 (ルートが存在しない)`);
      } else {
        logger.info(`[tester] /test/task: HTTP ${res.status} (ルートは存在する)`);
      }
    }
  } catch (err) {
    errors.push(`/test/task: 接続失敗 (${err instanceof Error ? err.message : String(err)})`);
  }

  // 2. /webhook ルート存在確認（空events送信 → 403 or 400 = ルート存在）
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const res = await fetch(`http://localhost:${TEST_PORT}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 404) {
      errors.push(`/webhook: 404 (ルートが存在しない)`);
    } else {
      logger.info(`[tester] /webhook: HTTP ${res.status} (ルートは存在する)`);
    }
  } catch (err) {
    errors.push(`/webhook: 接続失敗 (${err instanceof Error ? err.message : String(err)})`);
  }

  // 3. /telegram ルート存在確認
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

    const res = await fetch(`http://localhost:${TEST_PORT}/telegram`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 404) {
      errors.push(`/telegram: 404 (ルートが存在しない)`);
    } else {
      logger.info(`[tester] /telegram: HTTP ${res.status} (ルートは存在する)`);
    }
  } catch (err) {
    errors.push(`/telegram: 接続失敗 (${err instanceof Error ? err.message : String(err)})`);
  }

  if (errors.length > 0) {
    return {
      passed: false,
      stage: 'functional',
      message: `機能テスト失敗: ${errors.length}件`,
      details: errors.join('\n'),
    };
  }

  return {
    passed: true,
    stage: 'functional',
    message: '全エンドポイント確認OK',
  };
}

// ── 統合テスト実行 ──────────────────────────────────

export async function runAllTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // 起動テスト
  const startupResult = await runStartupTest();
  results.push(startupResult);

  if (!startupResult.passed) {
    killTestServer();
    await cleanupTestDb();
    return results;
  }

  // 機能テスト（テストサーバーが動いている状態で実行）
  const functionalResult = await runFunctionalTest();
  results.push(functionalResult);

  // テストサーバー停止 + テストDB削除
  killTestServer();
  await cleanupTestDb();

  return results;
}

/** テスト結果をフォーマット（LINE報告用） */
export function formatTestResults(results: TestResult[]): string {
  return results.map(r => {
    const icon = r.passed ? '✅' : '❌';
    const stageName = r.stage === 'startup' ? '起動テスト' : '機能テスト';
    let line = `${icon} ${stageName}: ${r.message}`;
    if (!r.passed && r.details) {
      line += `\n${r.details.slice(0, 300)}`;
    }
    return line;
  }).join('\n');
}
