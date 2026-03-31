import { exec } from 'child_process';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import path from 'path';
import { logger, dbLog } from '../../utils/logger';
import { config } from '../../config';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── Git キューロック ──────────────────────────────
// 同時に複数の会話がgit操作しないよう、キュー方式で直列化する
interface LockWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

let currentLockHolder: string | null = null;
const lockQueue: Array<{ convId: string } & LockWaiter> = [];

/**
 * Git操作のキューロックを取得する。
 * 既に別の会話がロックを持っている場合、キューに入って順番待ちする。
 * @param convId 会話ID（ロック所有者の識別用）
 * @param timeoutMs 最大待機時間（ms）。超過すると false を返す
 * @returns ロック取得できたら true
 */
export function acquireGitLock(convId: string, timeoutMs = 60_000): Promise<boolean> {
  // 既に同じ会話が持っている場合は再入可
  if (currentLockHolder === convId) return Promise.resolve(true);

  // ロックが空いていればそのまま取得
  if (currentLockHolder === null) {
    currentLockHolder = convId;
    logger.info('Gitロック取得', { convId });
    return Promise.resolve(true);
  }

  // キューに入って待つ
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      // タイムアウト: キューから自分を除去して false を返す
      const idx = lockQueue.findIndex(w => w.convId === convId);
      if (idx !== -1) lockQueue.splice(idx, 1);
      logger.warn('Gitロックタイムアウト', { convId, timeoutMs });
      resolve(false);
    }, timeoutMs);

    lockQueue.push({
      convId,
      resolve: () => { clearTimeout(timer); resolve(true); },
      reject: () => { clearTimeout(timer); resolve(false); },
    });
    logger.info('Gitロック待機キューに追加', { convId, queueLength: lockQueue.length });
  });
}

/**
 * Git操作のロックを解放する。キューに次の待機者がいれば自動で渡す。
 */
export function releaseGitLock(convId: string): void {
  if (currentLockHolder !== convId) {
    logger.warn('Gitロック解放: 所有者不一致', { convId, holder: currentLockHolder });
    return;
  }

  if (lockQueue.length > 0) {
    const next = lockQueue.shift()!;
    currentLockHolder = next.convId;
    logger.info('Gitロック引き継ぎ', { from: convId, to: next.convId });
    next.resolve();
  } else {
    currentLockHolder = null;
    logger.info('Gitロック解放', { convId });
  }
}

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
        // stdout も含める（git は "nothing to commit" を stdout に出力するため）
        reject(new Error(`${cmd} failed: ${error.message}\n${stderr}\n${stdout}`));
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

  // mainブランチに戻ってから新規ブランチを作成（過去の失敗ブランチを引き継がない）
  try {
    await execAsync('git checkout main');
    logger.info('mainブランチに移動');
  } catch {
    // mainがなければ dev/initial-build を試す
    try {
      await execAsync('git checkout dev/initial-build');
      logger.info('dev/initial-buildブランチに移動');
    } catch {
      logger.warn('ベースブランチへの移動失敗、現在のHEADからブランチ作成');
    }
  }

  // rsyncで更新されたファイルをステージングしてベースに反映
  try {
    await execAsync('git add -A');
    await execAsync('git diff --cached --quiet');
    // 変更なし
  } catch {
    // 変更あり → ベースにコミット（rsyncによるデプロイ分を取り込む）
    try {
      await execAsync("git commit -m 'chore: sync deployed changes'");
      logger.info('ベースブランチにrsync分をコミット');
    } catch {
      // nothing to commit の場合は無視
    }
  }

  // 自動ブランチを作成
  await execAsync(`git checkout -b ${branchName}`);
  logger.info(`ブランチ作成: ${branchName} (from main)`);

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
    // dist/ をクリーン＆リビルド（壊れたコンパイル結果を除去）
    try {
      await fs.rm(path.join(PROJECT_ROOT, 'dist'), { recursive: true, force: true });
      await execAsync('npm run build', 60000);
      logger.info('rollback後リビルド完了');
    } catch (rebuildErr) {
      logger.error('rollback後リビルド失敗', { err: rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr) });
    }
    logger.info('git rollback 完了: dev/initial-build に復帰');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('git rollback 失敗', { err: errMsg });
  }
}

export interface CommitResult {
  success: boolean;
  error?: string;
}

export async function commitAndStay(branchName: string, message: string): Promise<CommitResult> {
  try {
    // コミットメッセージのサニタイズ: 改行→スペース、シングルクォートのエスケープ
    const safeMessage = message
      .replace(/[\r\n]+/g, ' ')    // 改行をスペースに（シェルコマンド破壊防止）
      .replace(/'/g, "'\\''")       // シングルクォートのエスケープ
      .slice(0, 200);               // 長すぎるメッセージを切り詰め
    await execAsync('git add -A');

    // ステージング済み変更の有無を確認（nothing to commit でのエラー防止）
    try {
      await execAsync('git diff --cached --quiet');
      // exit 0 = 変更なし → コミット不要
      logger.info('git commit スキップ（変更なし）', { branchName });
      return { success: true };
    } catch {
      // exit 1 = 変更あり → コミット実行
    }

    await execAsync(`git commit -m '${safeMessage}'`);
    logger.info(`コミット完了: ${branchName}`);
    return { success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // "nothing to commit" は正常（変更なし）— フォールバック検出
    if (/nothing to commit|working tree clean/i.test(errMsg)) {
      logger.info('git commit スキップ（変更なし）', { branchName });
      return { success: true };
    }
    logger.warn('git commit 失敗', { err: errMsg });
    return { success: false, error: errMsg };
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

/** プロジェクト内のファイルを読み込む（ビルドエラー修正用） */
export async function readProjectFile(filePath: string): Promise<string | null> {
  try {
    const fullPath = path.join(PROJECT_ROOT, filePath);
    return await fs.readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

/** ビルドエラー出力からエラーが発生しているファイルパスを抽出 */
export function extractErrorFiles(buildOutput: string): string[] {
  const files = new Set<string>();
  // TypeScript形式: src/foo/bar.ts(10,5): error TS2345
  const tsMatches = buildOutput.matchAll(/(src\/[^\s:(]+\.ts)\(/g);
  for (const m of tsMatches) {
    files.add(m[1]);
  }
  // "Cannot find module '../xxx'" からのインポートパス推定
  const moduleMatches = buildOutput.matchAll(/Cannot find module '([^']+)'/g);
  for (const m of moduleMatches) {
    const modPath = m[1].replace(/^\.\.?\//, 'src/').replace(/^src\/src\//, 'src/');
    if (!modPath.endsWith('.ts')) {
      files.add(modPath + '.ts');
    } else {
      files.add(modPath);
    }
  }
  return [...files];
}

export async function runBuild(): Promise<DeployResult> {
  // dist/ をクリーンしてから再ビルド（削除されたソースのゴミが残らないように）
  try {
    await fs.rm(path.join(PROJECT_ROOT, 'dist'), { recursive: true, force: true });
  } catch { /* ignore */ }

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

// ── Pending Deploy（pm2 restart後の後処理用）──────────

export interface PendingDeploy {
  convId: string;
  branchName: string;
  userId: string;
  topic: string;
}

const PENDING_DEPLOY_PATH = path.join(PROJECT_ROOT, 'data', 'pending_deploy.json');

export function savePendingDeploy(info: PendingDeploy): void {
  fsSync.writeFileSync(PENDING_DEPLOY_PATH, JSON.stringify(info), 'utf-8');
  logger.info('PendingDeploy保存', { convId: info.convId, branch: info.branchName });
}

export function loadPendingDeploy(): PendingDeploy | null {
  try {
    const data = fsSync.readFileSync(PENDING_DEPLOY_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function clearPendingDeploy(): void {
  try {
    fsSync.unlinkSync(PENDING_DEPLOY_PATH);
  } catch { /* file doesn't exist, ignore */ }
}

/**
 * デプロイ実行: pending情報を保存してからpm2 restartを発火。
 * pm2 restartにより自プロセスが終了するため、この関数は「返らない」前提。
 * 後処理（ヘルスチェック・push・ステータス更新）は新プロセスの completePendingDeploy() で行う。
 */
export async function deployWithHealthCheck(branchName: string, pendingInfo: PendingDeploy): Promise<DeployResult> {
  // pm2 restart前にpending情報をディスクに永続化
  savePendingDeploy(pendingInfo);

  dbLog('info', 'deploy', 'pm2 restart発火（プロセス再起動予定）', { convId: pendingInfo.convId, branch: branchName });

  // pm2 restartを fire-and-forget で発火。自プロセスは死ぬ前提。
  exec('pm2 restart mothership', { cwd: PROJECT_ROOT, timeout: 15000 }, () => {});

  // pm2が自プロセスを殺すまで待つ（通常ここには到達しない）
  await sleep(60000);

  // 万が一ここに到達した場合（pm2が自分を管理していない等）
  clearPendingDeploy();
  return { success: false, message: 'PM2再起動後もプロセスが生きています。手動でpm2 restartしてください。' };
}

/**
 * 起動時に呼ばれる後処理。pendingデプロイがあればヘルスチェック→push→完了処理を行う。
 */
export async function completePendingDeploy(): Promise<void> {
  const pending = loadPendingDeploy();
  if (!pending) return;

  dbLog('info', 'deploy', `PendingDeploy検出: ${pending.branchName}`, { convId: pending.convId });

  // ヘルスチェック（起動直後なので少し待つ）
  await sleep(3000);
  const healthy = await healthCheck();

  // 遅延import（循環参照回避）
  const { updateConversationStatus, getConversation } = await import('./conversation');
  const { sendLineMessage } = await import('../../line/sender');
  const { recordMetric } = await import('./teamEvaluation');

  if (healthy) {
    dbLog('info', 'deploy', 'ヘルスチェック成功', { convId: pending.convId });

    // GitHubにpush
    try {
      await execAsync(`git push origin ${pending.branchName}`, 30000);
      dbLog('info', 'deploy', `GitHub push 完了: ${pending.branchName}`, { convId: pending.convId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('GitHub push 失敗（デプロイ自体は成功）', { err: errMsg });
    }

    // ステータス更新
    recordMetric(pending.convId, 'deployer', 'deploy_success');
    updateConversationStatus(pending.convId, 'deployed');

    const updatedConv = getConversation(pending.convId);
    const generatedFiles: string[] = [];
    try {
      const parsed = JSON.parse(updatedConv?.generated_files || '[]');
      if (Array.isArray(parsed)) generatedFiles.push(...parsed);
    } catch { /* ignore */ }

    dbLog('info', 'deploy', `デプロイ成功: ${pending.branchName}`, { convId: pending.convId, files: generatedFiles });

    const detailUrl = `${config.admin.baseUrl}/admin/dev/${pending.convId}`;
    await sendLineMessage(pending.userId,
      `✅ デプロイ完了!\n\n` +
      `${pending.topic}\n` +
      `ブランチ: ${pending.branchName}\n` +
      `ファイル: ${[...new Set(generatedFiles)].join(', ')}\n\n` +
      `ビルド・テスト・ヘルスチェック 全て通過。\n\n` +
      `詳細: ${detailUrl}`
    ).catch(err => logger.warn('デプロイ成功通知失敗', { err: err instanceof Error ? err.message : String(err) }));

    // レトロスペクティブ（バックグラウンド）
    if (updatedConv) {
      import('./retrospective').then(({ runRetrospective }) =>
        runRetrospective(updatedConv).catch(err =>
          logger.warn('レトロスペクティブ失敗', { err: err instanceof Error ? err.message : String(err) })
        )
      ).catch(err => logger.warn('レトロスペクティブimport失敗', { err: err instanceof Error ? err.message : String(err) }));
    }
  } else {
    dbLog('error', 'deploy', 'ヘルスチェック失敗 → ロールバック', { convId: pending.convId });

    // ★ 先にpendingファイルを削除（pm2 restart後の無限ループ防止）
    clearPendingDeploy();

    // ロールバック
    await rollbackGit(pending.branchName);
    updateConversationStatus(pending.convId, 'failed');

    const failUrl = `${config.admin.baseUrl}/admin/dev/${pending.convId}`;
    await sendLineMessage(pending.userId,
      `デプロイ失敗: ヘルスチェックNG\nロールバックしました。\nブランチ: ${pending.branchName}\n\n詳細: ${failUrl}`
    ).catch(err => logger.warn('デプロイ失敗通知失敗', { err: err instanceof Error ? err.message : String(err) }));

    // 失敗時もレトロスペクティブを実行（学習のため）
    const failedConv = getConversation(pending.convId);
    if (failedConv) {
      import('./retrospective').then(({ runRetrospective }) =>
        runRetrospective(failedConv).catch(err =>
          logger.warn('レトロスペクティブ失敗（デプロイ失敗時）', { err: err instanceof Error ? err.message : String(err) })
        )
      ).catch(err => logger.warn('レトロスペクティブimport失敗', { err: err instanceof Error ? err.message : String(err) }));
    }

    // ロールバック後に再起動が必要（コードを元に戻したので）
    exec('pm2 restart mothership', { cwd: PROJECT_ROOT, timeout: 15000 }, () => {});
    return; // clearPendingDeploy は既に呼び済み
  }

  clearPendingDeploy();
}
