import { exec } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../../utils/logger';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface FileToWrite {
  path: string;
  content: string;
  action: 'create' | 'update';
}

export interface DeployResult {
  success: boolean;
  message: string;
  buildOutput?: string;
  branch?: string;
}

function execAsync(cmd: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: PROJECT_ROOT, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} failed: ${error.message}\n${stderr}`));
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    });
  });
}

function generateBranchName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `dev/auto-${ts}`;
}

export async function prepareGitBranch(): Promise<string> {
  const branchName = generateBranchName();

  // 現在の変更を退避
  try {
    await execAsync('git stash');
    logger.info('git stash 完了');
  } catch {
    // stash するものがない場合は無視
    logger.info('git stash: 退避する変更なし');
  }

  // 自動ブランチを作成
  await execAsync(`git checkout -b ${branchName}`);
  logger.info(`ブランチ作成: ${branchName}`);

  return branchName;
}

export async function rollbackGit(branchName: string): Promise<void> {
  try {
    // 変更を破棄してdev/initial-buildに戻る
    await execAsync('git checkout -- .').catch(() => {});
    await execAsync('git clean -fd').catch(() => {});
    await execAsync('git checkout dev/initial-build');
    // 失敗ブランチを削除
    await execAsync(`git branch -D ${branchName}`).catch(() => {});
    // stash を戻す
    await execAsync('git stash pop').catch(() => {});
    logger.info('git rollback 完了: dev/initial-build に復帰');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('git rollback 失敗', { err: errMsg });
  }
}

export async function commitAndStay(branchName: string, message: string): Promise<void> {
  try {
    await execAsync('git add -A');
    await execAsync(`git commit -m "${message}"`);
    logger.info(`コミット完了: ${branchName}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('git commit スキップ', { err: errMsg });
  }
}

export async function writeFiles(files: FileToWrite[]): Promise<string[]> {
  const written: string[] = [];

  for (const file of files) {
    const fullPath = path.join(PROJECT_ROOT, file.path);
    const dir = path.dirname(fullPath);

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fullPath, file.content, 'utf-8');
      written.push(file.path);
      logger.info(`ファイル書き出し: ${file.path}`, { action: file.action });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`ファイル書き出し失敗: ${file.path}`, { err: errMsg });
      throw new Error(`ファイル書き出し失敗: ${file.path}: ${errMsg}`);
    }
  }

  return written;
}

export async function runBuild(): Promise<DeployResult> {
  return new Promise((resolve) => {
    exec('npm run build', {
      cwd: PROJECT_ROOT,
      timeout: 60000,
    }, (error, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim();
      if (error) {
        resolve({
          success: false,
          message: 'ビルドエラー',
          buildOutput: output.slice(0, 3000),
        });
      } else {
        resolve({
          success: true,
          message: 'ビルド成功',
          buildOutput: output.slice(0, 1000),
        });
      }
    });
  });
}

export async function restartPM2(): Promise<DeployResult> {
  return new Promise((resolve) => {
    exec('pm2 restart mothership', {
      cwd: PROJECT_ROOT,
      timeout: 15000,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          message: `PM2再起動失敗: ${stderr.slice(0, 500)}`,
        });
      } else {
        resolve({
          success: true,
          message: 'PM2再起動完了',
        });
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('http://localhost:3000/health', { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function deployWithHealthCheck(branchName: string): Promise<DeployResult> {
  const pm2Result = await restartPM2();
  if (!pm2Result.success) {
    return pm2Result;
  }

  // 5秒待ってヘルスチェック
  await sleep(5000);
  const healthy = await healthCheck();

  if (healthy) {
    logger.info('ヘルスチェック成功');

    // GitHubにpush
    try {
      await execAsync(`git push origin ${branchName}`, 30000);
      logger.info(`GitHub push 完了: ${branchName}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('GitHub push 失敗（デプロイ自体は成功）', { err: errMsg });
    }

    return { success: true, message: 'デプロイ成功（ヘルスチェック通過）', branch: branchName };
  }

  // ヘルスチェック失敗 → ロールバック
  logger.error('ヘルスチェック失敗。ロールバック開始');
  await rollbackGit(branchName);
  await runBuild();
  await restartPM2();
  await sleep(3000);

  return {
    success: false,
    message: 'デプロイ失敗: ヘルスチェックNG。ロールバックしました。',
    branch: branchName,
  };
}
