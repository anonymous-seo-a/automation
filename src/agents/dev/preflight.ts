import { exec } from 'child_process';
import path from 'path';
import { logger, dbLog } from '../../utils/logger';
import { classifyError, ClassifiedError } from './errorClassifier';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_PORT = 3999;

export interface PreflightIssue {
  severity: 'error' | 'warning';
  category: 'git' | 'disk' | 'port' | 'dependency';
  message: string;
  autoFixable: boolean;
}

export interface PreflightResult {
  passed: boolean;
  issues: PreflightIssue[];
  fixedIssues: string[];
}

function execAsync(cmd: string, timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: PROJECT_ROOT, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/**
 * 実装開始前の環境チェック。問題があれば自動修正を試み、結果を返す。
 */
export async function runPreflightChecks(): Promise<PreflightResult> {
  const issues: PreflightIssue[] = [];
  const fixedIssues: string[] = [];

  // 1. Git user設定チェック
  try {
    const { stdout: name } = await execAsync('git config user.name');
    const { stdout: email } = await execAsync('git config user.email');
    if (!name.trim() || !email.trim()) throw new Error('empty');
  } catch {
    try {
      await execAsync('git config user.name "Mothership Bot"');
      await execAsync('git config user.email "bot@mothership.local"');
      fixedIssues.push('git user.name / user.email を自動設定');
      logger.info('[preflight] Git user設定を自動修正');
    } catch {
      issues.push({
        severity: 'error',
        category: 'git',
        message: 'git user.name / user.email が未設定でコミットできません',
        autoFixable: false,
      });
    }
  }

  // 2. ディスク容量チェック
  try {
    const { stdout } = await execAsync('df -m . | tail -1');
    const parts = stdout.trim().split(/\s+/);
    const availMB = parseInt(parts[3], 10);
    if (!isNaN(availMB) && availMB < 100) {
      issues.push({
        severity: 'error',
        category: 'disk',
        message: `ディスク残量不足 (${availMB}MB < 100MB)`,
        autoFixable: false,
      });
    } else if (!isNaN(availMB) && availMB < 500) {
      issues.push({
        severity: 'warning',
        category: 'disk',
        message: `ディスク残量が少なめです (${availMB}MB)`,
        autoFixable: false,
      });
    }
  } catch { /* パース失敗は無視 */ }

  // 3. テストポート(3999)の使用状況チェック
  try {
    const { stdout } = await execAsync(`lsof -i :${TEST_PORT} -t 2>/dev/null || true`);
    if (stdout.trim()) {
      // 自動修正: テストポートのプロセスをkill
      try {
        await execAsync(`kill -9 ${stdout.trim()} 2>/dev/null || true`);
        fixedIssues.push(`テストポート ${TEST_PORT} の残存プロセスを停止`);
      } catch {
        issues.push({
          severity: 'warning',
          category: 'port',
          message: `テストポート ${TEST_PORT} が使用中 (PID: ${stdout.trim()})`,
          autoFixable: false,
        });
      }
    }
  } catch { /* ignore */ }

  // 4. node_modules存在チェック
  try {
    await execAsync('test -d node_modules');
  } catch {
    try {
      logger.info('[preflight] node_modules不在 → npm install 実行');
      await execAsync('npm install', 60_000);
      fixedIssues.push('npm install を自動実行');
    } catch {
      issues.push({
        severity: 'error',
        category: 'dependency',
        message: 'node_modulesが存在せず、npm installも失敗',
        autoFixable: false,
      });
    }
  }

  const result: PreflightResult = {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    fixedIssues,
  };

  if (fixedIssues.length > 0) {
    dbLog('info', 'dev-agent', `[preflight] 自動修正: ${fixedIssues.join(', ')}`);
  }
  if (issues.length > 0) {
    dbLog('warn', 'dev-agent', `[preflight] 問題検出: ${issues.map(i => i.message).join(', ')}`);
  }

  return result;
}

/**
 * 分類済みエラーに対して環境の自動修正を試みる。
 * @returns 修正できたら true
 */
export async function autoFixEnvironment(classified: ClassifiedError): Promise<boolean> {
  dbLog('info', 'dev-agent', `[autofix] 環境修正試行: ${classified.subcategory}`, {
    action: classified.suggestedAction,
  });

  try {
    switch (classified.subcategory) {
      case 'git_config': {
        await execAsync('git config user.name "Mothership Bot"');
        await execAsync('git config user.email "bot@mothership.local"');
        logger.info('[autofix] Git user設定を修正');
        return true;
      }
      case 'port_conflict': {
        // テストポートのプロセスをkill
        const { stdout } = await execAsync(`lsof -i :${TEST_PORT} -t 2>/dev/null || true`);
        if (stdout.trim()) {
          await execAsync(`kill -9 ${stdout.trim()} 2>/dev/null || true`);
        }
        logger.info('[autofix] ポート競合を解消');
        return true;
      }
      case 'missing_module': {
        await execAsync('npm install', 60_000);
        logger.info('[autofix] npm install 完了');
        return true;
      }
      default:
        dbLog('warn', 'dev-agent', `[autofix] 自動修正非対応: ${classified.subcategory}`);
        return false;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    dbLog('error', 'dev-agent', `[autofix] 環境修正失敗: ${errMsg.slice(0, 200)}`);
    return false;
  }
}
