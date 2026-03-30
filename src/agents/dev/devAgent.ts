import { Agent, Task, TaskResult } from '../baseAgent';
import { callClaude } from '../../claude/client';
import { sendLineMessage } from '../../line/sender';
import { logger, dbLog } from '../../utils/logger';
import {
  getActiveConversation,
  createConversation,
  getConversation,
  updateConversationStatus,
  appendHearingLog,
  setRequirements,
  setGeneratedFiles,
  cancelConversation,
  getHearingRound,
  DevConversation,
} from './conversation';
import {
  DEV_SYSTEM_PROMPT,
  PM_HEARING_PROMPT,
  PM_REQUIREMENTS_PROMPT,
  PM_DECOMPOSE_PROMPT,
  ENGINEER_PROMPT,
  REVIEWER_PROMPT,
} from './prompts';
import {
  writeFiles,
  runBuild,
  deployWithHealthCheck,
  prepareGitBranch,
  rollbackGit,
  commitAndStay,
  readProjectFile,
  FileToWrite,
  acquireGitLock,
  releaseGitLock,
} from './deployer';
import {
  runAllTests,
  formatTestResults,
  TestResult,
} from './tester';
import { runClaudeCLI } from './cliRunner';
import { getSourceTree } from '../../github/client';

const MAX_BUILD_RETRIES = 5;
const MAX_TEST_FIX_RETRIES = 3;
const MAX_HEARING_ROUNDS = 3;
const MAX_REVIEW_RETRIES = 3;
const MAX_ENGINEER_PARSE_RETRIES = 3;
const PHASE_TIMEOUT_MS = 5 * 60 * 1000; // 各フェーズ最大5分

interface Subtask {
  index: number;
  path: string;
  action: 'create' | 'update';
  description: string;
}

interface StuckContext {
  branchName: string;
  subtasks: Subtask[];
  completedFiles: Array<{ path: string; content: string }>;
  failedSubtaskIndex: number;
  errorMessage: string;
  phase: string; // エラーが起きたフェーズ名
}

/**
 * タイムアウト付きでPromiseを実行するヘルパー
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: ${ms / 1000}秒でタイムアウト`)), ms);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

export class DevAgent implements Agent {
  name = 'dev';

  // 会話ID → stuckコンテキストのマッピング（シングルトンでも安全）
  private stuckContextMap = new Map<string, StuckContext>();

  async execute(task: Task): Promise<TaskResult> {
    return {
      success: true,
      output: '開発エージェントはLINE会話経由で動作します。LINEから「〇〇を開発して」と送信してください。',
      needsExecution: false,
    };
  }

  async handleMessage(userId: string, text: string): Promise<void> {
    try {
      if (/開発(キャンセル|中止|やめ)|やめて|やめる|キャンセル|別の話/.test(text.trim())) {
        const conv = getActiveConversation(userId);
        if (conv) {
          this.cleanupConversation(conv.id, conv.user_id);
          cancelConversation(conv.id);
          dbLog('info', 'dev-agent', `開発キャンセル: ${conv.topic}`, { convId: conv.id });
          await sendLineMessage(userId, '開発を中止しました。');
        } else {
          await sendLineMessage(userId, '進行中の開発はありません。');
        }
        return;
      }

      let conv = getActiveConversation(userId);

      if (!conv) {
        conv = createConversation(userId, text);
        dbLog('info', 'dev-agent', `新規開発会話: ${text.slice(0, 60)}`, { convId: conv.id });
        await sendLineMessage(userId,
          `🛠 開発モード開始\n「${text.slice(0, 40)}」について、いくつか確認させてください。\n\n` +
          `（「やめる」「中止」でいつでも開発モードを終了できます）`
        );
        await this.safeExecutePhase(conv, 'hearing', () => this.runHearing(conv!, text));
        return;
      }

      dbLog('info', 'dev-agent', `handleMessage: status=${conv.status}`, { convId: conv.id, text: text.slice(0, 60) });

      switch (conv.status) {
        case 'hearing':
          await this.safeExecutePhase(conv, 'hearing', () => this.handleHearing(conv!, text));
          break;
        case 'defining':
          await this.safeExecutePhase(conv, 'defining', () => this.handleDefining(conv!, text));
          break;
        case 'stuck':
          await this.safeExecutePhase(conv, 'stuck', () => this.handleStuck(conv!, text));
          break;
        case 'approved':
        case 'implementing':
        case 'testing':
          dbLog('info', 'dev-agent', `実装中メッセージ受信（無視）: ${text.slice(0, 30)}`, { convId: conv.id });
          await sendLineMessage(userId, '現在実装中です。完了次第ご報告します。');
          break;
        default:
          dbLog('warn', 'dev-agent', `想定外ステータス: ${conv.status}`, { convId: conv.id });
          break;
      }
    } catch (err) {
      // 最終安全弁: ここに来たら何かが本当におかしい
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('DevAgent最終エラーハンドラ', { err: errMsg, userId });
      dbLog('error', 'dev-agent', `最終エラー: ${errMsg.slice(0, 200)}`, { userId });
      try {
        await sendLineMessage(userId, `開発エージェントでエラーが発生しました:\n${errMsg.slice(0, 300)}\n\n新しい開発依頼を送ってリトライできます。`);
      } catch {
        // 送信も失敗した場合はログだけ
        logger.error('エラー通知送信も失敗', { userId });
      }
    }
  }

  /**
   * 各フェーズをtry/catchで安全に実行。
   * エラー時は途中作業を保全しつつ、ユーザーに選択肢を提示する。
   */
  private async safeExecutePhase(
    conv: DevConversation,
    phaseName: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    try {
      await withTimeout(fn(), PHASE_TIMEOUT_MS, `${phaseName}フェーズ`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[${phaseName}] フェーズエラー: ${errMsg.slice(0, 200)}`, { convId: conv.id });

      // hearing/defining フェーズはstuckに移行せず、即座にfailed + 通知
      if (phaseName === 'hearing' || phaseName === 'defining') {
        updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `${phaseName}フェーズでエラーが発生しました:\n${errMsg.slice(0, 300)}\n\n` +
          `新しい開発依頼を送り直してください。`
        ).catch(() => {});
        return;
      }

      // implementing/stuck フェーズは途中作業を保全してstuckに移行
      if (conv.status !== 'stuck') {
        updateConversationStatus(conv.id, 'stuck');
      }

      // stuckコンテキストが無ければ作成
      if (!this.stuckContextMap.has(conv.id)) {
        this.stuckContextMap.set(conv.id, {
          branchName: '',
          subtasks: [],
          completedFiles: [],
          failedSubtaskIndex: 0,
          errorMessage: errMsg,
          phase: phaseName,
        });
      } else {
        const ctx = this.stuckContextMap.get(conv.id)!;
        ctx.errorMessage = errMsg;
        ctx.phase = phaseName;
      }

      await sendLineMessage(conv.user_id,
        `${phaseName}フェーズでエラーが発生しました:\n${errMsg.slice(0, 300)}\n\n` +
        `選択肢:\n` +
        `・「リトライ」→ 再試行\n` +
        `・「中止」→ 開発を中止（完了分はブランチに残ります）`
      ).catch(() => {});
    }
  }

  /** 会話に関連するリソースのクリーンアップ */
  private cleanupConversation(convId: string, _userId: string): void {
    this.stuckContextMap.delete(convId);
  }

  // ========================================
  // コードベースコンテキスト（PM用）
  // ========================================

  /**
   * PMがプロジェクト構造を理解するためのコンテキストを構築。
   * GitHubのファイルツリー + 主要ファイルの内容を含む。
   */
  private async buildCodebaseContext(): Promise<string> {
    const [fileTree, migrations, routerCode, indexCode, adminCode] = await Promise.all([
      getSourceTree(),
      readProjectFile('src/db/migrations.ts'),
      readProjectFile('src/agents/router.ts'),
      readProjectFile('src/index.ts'),
      readProjectFile('src/admin/dashboard.ts'),
    ]);

    let ctx = '## 現在のプロジェクト構造（GitHub リポジトリから取得）\n\n';
    ctx += '### ソースファイル一覧\n' + fileTree + '\n\n';

    if (migrations) {
      ctx += '### DBスキーマ (src/db/migrations.ts)\n```typescript\n' + migrations + '\n```\n\n';
    }

    if (routerCode) {
      ctx += '### エージェントルーター (src/agents/router.ts)\n```typescript\n' + routerCode + '\n```\n\n';
    }

    if (indexCode) {
      const truncated = indexCode.length > 3000 ? indexCode.slice(0, 3000) + '\n// ...(以下省略)' : indexCode;
      ctx += '### エントリポイント (src/index.ts)\n```typescript\n' + truncated + '\n```\n\n';
    }

    if (adminCode) {
      const truncated = adminCode.length > 3000 ? adminCode.slice(0, 3000) + '\n// ...(以下省略)' : adminCode;
      ctx += '### 管理ダッシュボード (src/admin/dashboard.ts)\n```typescript\n' + truncated + '\n```\n\n';
    }

    ctx += '※ PMはこの情報を基にユーザーに質問不要な項目は自分で判断すること。コード構造の質問をユーザーにしないこと。\n';

    return ctx;
  }

  // ========================================
  // Phase 1: ヒアリング（PM）
  // ========================================

  private async runHearing(conv: DevConversation, initialMessage: string): Promise<void> {
    appendHearingLog(conv.id, 'user', initialMessage);
    dbLog('info', 'dev-agent', `[PM] ヒアリング開始: round 1/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    const codebaseCtx = await this.buildCodebaseContext();

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_HEARING_PROMPT,
      messages: [
        { role: 'user', content: `${codebaseCtx}\n\n開発依頼: ${initialMessage}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\n現在のヒアリング回数: 1/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'opus',
    });

    dbLog('info', 'dev-agent', `[PM] ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async handleHearing(conv: DevConversation, userReply: string): Promise<void> {
    appendHearingLog(conv.id, 'user', userReply);

    const round = getHearingRound(conv.id);
    dbLog('info', 'dev-agent', `[PM] ヒアリング回答受信: round ${round}/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    if (round >= MAX_HEARING_ROUNDS) {
      dbLog('info', 'dev-agent', '[PM] ヒアリング最大回数到達 → 要件定義へ', { convId: conv.id });
      appendHearingLog(conv.id, 'agent', 'ヒアリング最大回数到達。要件定義に進みます。');
      await this.transitionToDefining(conv);
      return;
    }

    const codebaseCtx = await this.buildCodebaseContext();

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_HEARING_PROMPT,
      messages: [
        { role: 'user', content: `${codebaseCtx}\n\n開発依頼: ${conv.topic}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\nユーザーの最新回答: ${userReply}\n\n現在のヒアリング回数: ${round}/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'opus',
    });

    dbLog('info', 'dev-agent', `[PM] ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async processHearingResponse(conv: DevConversation, text: string): Promise<void> {
    const parsed = safeParseJson(text);

    if (parsed && parsed.hearing_complete) {
      dbLog('info', 'dev-agent', '[PM] ヒアリング完了 → 要件定義へ', { convId: conv.id });
      appendHearingLog(conv.id, 'agent', parsed.summary || 'ヒアリング完了');
      await this.transitionToDefining(conv);
    } else if (parsed && parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      const questions = (parsed.questions as string[]).slice(0, 3);
      const msg = questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n') + '\n\n（「やめる」で中止できます）';
      appendHearingLog(conv.id, 'agent', msg);
      await sendLineMessage(conv.user_id, msg);
    } else {
      dbLog('warn', 'dev-agent', `[PM] ヒアリング応答がJSON外: ${text.slice(0, 80)}`, { convId: conv.id });
      appendHearingLog(conv.id, 'agent', text);
      await sendLineMessage(conv.user_id, text);
    }
  }

  // ========================================
  // Phase 2: 要件定義（PM - Opus）
  // ========================================

  private async transitionToDefining(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'defining');
    dbLog('info', 'dev-agent', '[PM] 要件定義書作成開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    await sendLineMessage(conv.user_id, 'ヒアリング完了。要件定義書を作成中...');

    const codebaseCtx = await this.buildCodebaseContext();

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_REQUIREMENTS_PROMPT,
      messages: [
        { role: 'user', content: `${codebaseCtx}\n\n開発依頼: ${conv.topic}\n\nヒアリング内容:\n${JSON.stringify(hearingLog)}` },
      ],
      model: 'opus',
    });

    setRequirements(conv.id, text);
    dbLog('info', 'dev-agent', `[PM] 要件定義書作成完了 (${text.length}文字)`, { convId: conv.id });
    await sendLineMessage(conv.user_id, text);
    await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
  }

  private async handleDefining(conv: DevConversation, userReply: string): Promise<void> {
    dbLog('info', 'dev-agent', `[PM] 要件定義フェーズ応答: ${userReply.slice(0, 40)}`, { convId: conv.id });

    // 要件が未生成の場合は何もしない（webhookで弾くが二重安全）
    const freshConv = getConversation(conv.id);
    if (!freshConv?.requirements) {
      dbLog('warn', 'dev-agent', '[PM] 要件未生成のまま handleDefining に到達', { convId: conv.id });
      await sendLineMessage(conv.user_id, '要件定義書を作成中です。完了までお待ちください。');
      return;
    }

    if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで|それでいい|いいと思う|よさそう|良さそう)$/i.test(userReply.trim())) {
      updateConversationStatus(freshConv.id, 'approved');
      dbLog('info', 'dev-agent', '[PM] 要件承認 → 実装開始', { convId: conv.id });
      await sendLineMessage(conv.user_id, '実装を開始します。チーム体制で進めます。\n（PM → エンジニア → レビュアー の順で各ファイルを処理）');
      // 実装は非同期で実行（safeExecutePhaseの5分タイムアウトを回避）
      // runImplementation は独自のtry/catch/finallyで全てのエラーを処理する
      this.runImplementation(conv).catch(err => {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `[チーム] 実装未捕捉エラー: ${errMsg}`, { convId: conv.id });
        updateConversationStatus(conv.id, 'failed');
        sendLineMessage(conv.user_id, `実装中に予期しないエラー:\n${errMsg.slice(0, 300)}\n\n新しい開発依頼でリトライできます。`).catch(() => {});
      });
    } else {
      dbLog('info', 'dev-agent', '[PM] 要件修正指示を受信', { convId: conv.id });
      await sendLineMessage(conv.user_id, '要件を修正中...');

      const requirements = freshConv.requirements;
      const codebaseCtx = await this.buildCodebaseContext();
      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + PM_REQUIREMENTS_PROMPT,
        messages: [
          { role: 'user', content: `${codebaseCtx}\n\n元の要件:\n${requirements}\n\n修正指示: ${userReply}` },
        ],
        model: 'opus',
      });

      setRequirements(conv.id, text);
      dbLog('info', 'dev-agent', `[PM] 要件修正完了 (${text.length}文字)`, { convId: conv.id });
      await sendLineMessage(conv.user_id, text);
      await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
    }
  }

  // ========================================
  // Phase 3: 実装（チーム体制）
  // ========================================

  private async runImplementation(conv: DevConversation, resumeFrom?: { branchName: string; subtasks: Subtask[]; completedFiles: Array<{ path: string; content: string }>; startIndex: number }): Promise<void> {
    updateConversationStatus(conv.id, 'implementing');
    dbLog('info', 'dev-agent', '[チーム] 実装フェーズ開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;

    let branchName = resumeFrom?.branchName || '';
    let subtasks: Subtask[] = resumeFrom?.subtasks || [];
    const allFiles: FileToWrite[] = [];
    const completedFiles: Array<{ path: string; content: string }> = resumeFrom?.completedFiles || [];
    let startIndex = resumeFrom?.startIndex || 0;
    let gitLockAcquired = false;

    try {
      // 新規開始の場合
      if (!resumeFrom) {
        // Gitロック取得（キュー待ち）
        await sendLineMessage(conv.user_id, 'Gitロック取得中...');
        gitLockAcquired = await acquireGitLock(conv.id, 60_000);
        if (!gitLockAcquired) {
          throw new Error('Git操作のロック取得に失敗しました（他の開発が進行中の可能性）');
        }

        branchName = await prepareGitBranch();
        dbLog('info', 'dev-agent', `[チーム] ブランチ作成: ${branchName}`, { convId: conv.id });
        await sendLineMessage(conv.user_id, `ブランチ: ${branchName}`);

        subtasks = await this.pmDecompose(updatedConv);
        dbLog('info', 'dev-agent', `[PM] サブタスク分解完了: ${subtasks.length}件`, { convId: conv.id });
        await sendLineMessage(conv.user_id, `${subtasks.length}個のサブタスクに分解しました:\n${subtasks.map(s => `${s.index}. ${s.path}`).join('\n')}`);
      } else {
        // 再開時もロック取得
        gitLockAcquired = await acquireGitLock(conv.id, 60_000);
        if (!gitLockAcquired) {
          throw new Error('Git操作のロック取得に失敗しました');
        }
        await sendLineMessage(conv.user_id, `サブタスク ${startIndex + 1} から再開します...`);
      }

      // サブタスクごとに エンジニア→レビュアー のループ
      for (let i = startIndex; i < subtasks.length; i++) {
        const subtask = subtasks[i];
        dbLog('info', 'dev-agent', `[エンジニア] サブタスク ${subtask.index}/${subtasks.length}: ${subtask.path}`, { convId: conv.id });

        try {
          const file = await this.engineerAndReview(conv, subtask, subtasks, completedFiles);
          allFiles.push(file);
          completedFiles.push({ path: file.path, content: file.content });

          // CLIが直接ファイルを書くのでwriteFiles不要、commitのみ
          await commitAndStay(branchName, `feat: ${subtask.path} - ${subtask.description.slice(0, 50)}`);

          await sendLineMessage(conv.user_id, `${subtask.index}/${subtasks.length} 完了: ${subtask.path}`);
        } catch (subtaskErr) {
          const errMsg = subtaskErr instanceof Error ? subtaskErr.message : String(subtaskErr);
          dbLog('error', 'dev-agent', `[チーム] サブタスク失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id, subtaskIndex: subtask.index });

          // stuckモードに移行（ロールバックしない、ブランチと完了分を保全）
          this.stuckContextMap.set(conv.id, {
            branchName,
            subtasks,
            completedFiles: [...completedFiles],
            failedSubtaskIndex: i,
            errorMessage: errMsg,
            phase: 'implementing',
          });
          updateConversationStatus(conv.id, 'stuck');

          // ロック解放
          if (gitLockAcquired) releaseGitLock(conv.id);

          await sendLineMessage(conv.user_id,
            `サブタスク ${subtask.index}/${subtasks.length} (${subtask.path}) で問題が発生しました:\n` +
            `${errMsg.slice(0, 300)}\n\n` +
            `完了済み: ${completedFiles.length}/${subtasks.length} ファイル（コミット済み）\n\n` +
            `選択肢:\n` +
            `・「リトライ」→ このサブタスクを再試行\n` +
            `・「スキップ」→ このサブタスクを飛ばして次へ\n` +
            `・指示を送る → 追加情報を元に再試行\n` +
            `・「中止」→ 開発を中止（完了分はブランチに残ります）`
          );
          return; // stuckで一旦停止
        }
      }

      setGeneratedFiles(conv.id, [...completedFiles.map(f => f.path), ...allFiles.map(f => f.path)]);

      // ビルド → デプロイ
      updateConversationStatus(conv.id, 'testing');
      dbLog('info', 'dev-agent', '[チーム] 全サブタスク完了 → ビルド開始', { convId: conv.id });
      await sendLineMessage(conv.user_id, `全${subtasks.length}ファイル完了。ビルド開始...`);
      await this.runBuildAndDeploy(conv, allFiles, 0, branchName);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[チーム] 実装失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });

      // 完了済みサブタスクがある場合はブランチを残してstuckへ
      if (completedFiles.length > 0 && branchName) {
        await commitAndStay(branchName, `partial: ${completedFiles.length} files completed before error`).catch(() => {});

        this.stuckContextMap.set(conv.id, {
          branchName,
          subtasks,
          completedFiles: [...completedFiles],
          failedSubtaskIndex: startIndex,
          errorMessage: errMsg,
          phase: 'implementing',
        });
        updateConversationStatus(conv.id, 'stuck');

        await sendLineMessage(conv.user_id,
          `実装中にエラーが発生しました:\n${errMsg.slice(0, 400)}\n\n` +
          `完了済み ${completedFiles.length} ファイルはブランチ ${branchName} に保存されています。\n\n` +
          `選択肢:\n` +
          `・「リトライ」→ 再試行\n` +
          `・「中止」→ 開発を中止（完了分はブランチに残ります）`
        ).catch(() => {});
      } else {
        // 何も進んでいない場合はロールバック
        if (branchName) {
          await rollbackGit(branchName).catch(() => {});
        }
        updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `実装中にエラーが発生しました:\n${errMsg.slice(0, 400)}\n\n` +
          `コードをロールバックしました。新しい依頼を送ってリトライできます。`
        ).catch(() => {});
      }
    } finally {
      if (gitLockAcquired) releaseGitLock(conv.id);
    }
  }

  private async handleStuck(conv: DevConversation, userReply: string): Promise<void> {
    const ctx = this.stuckContextMap.get(conv.id);
    if (!ctx) {
      await sendLineMessage(conv.user_id, 'スタック情報が失われました。新しい開発依頼を送ってください。');
      updateConversationStatus(conv.id, 'failed');
      return;
    }

    const normalizedReply = userReply.trim().toLowerCase();

    if (/^(中止|キャンセル|やめ)/.test(normalizedReply)) {
      dbLog('info', 'dev-agent', '[stuck] ユーザーが中止を選択', { convId: conv.id });
      this.stuckContextMap.delete(conv.id);
      updateConversationStatus(conv.id, 'failed');
      const branchMsg = ctx.branchName ? `\n完了済みファイルはブランチ ${ctx.branchName} に残っています。` : '';
      await sendLineMessage(conv.user_id, `開発を中止しました。${branchMsg}`);
      return;
    }

    if (/^スキップ/.test(normalizedReply)) {
      dbLog('info', 'dev-agent', `[stuck] サブタスク ${ctx.failedSubtaskIndex + 1} をスキップ`, { convId: conv.id });
      this.stuckContextMap.delete(conv.id);
      this.runImplementation(conv, {
        branchName: ctx.branchName,
        subtasks: ctx.subtasks,
        completedFiles: ctx.completedFiles,
        startIndex: ctx.failedSubtaskIndex + 1,
      }).catch(err => {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `[チーム] 再開未捕捉エラー: ${errMsg}`, { convId: conv.id });
        updateConversationStatus(conv.id, 'failed');
        sendLineMessage(conv.user_id, `再開中にエラー:\n${errMsg.slice(0, 300)}`).catch(() => {});
      });
      return;
    }

    // リトライ or 追加指示付きリトライ
    dbLog('info', 'dev-agent', `[stuck] リトライ（指示: ${userReply.slice(0, 50)}）`, { convId: conv.id });
    const failedSubtask = ctx.subtasks[ctx.failedSubtaskIndex];

    // ユーザーの追加指示をサブタスクのdescriptionに反映
    if (failedSubtask && !/^リトライ$/.test(normalizedReply)) {
      failedSubtask.description += `\n\n追加指示: ${userReply}`;
    }

    this.stuckContextMap.delete(conv.id);
    this.runImplementation(conv, {
      branchName: ctx.branchName,
      subtasks: ctx.subtasks,
      completedFiles: ctx.completedFiles,
      startIndex: ctx.failedSubtaskIndex,
    }).catch(err => {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[チーム] リトライ未捕捉エラー: ${errMsg}`, { convId: conv.id });
      updateConversationStatus(conv.id, 'failed');
      sendLineMessage(conv.user_id, `リトライ中にエラー:\n${errMsg.slice(0, 300)}`).catch(() => {});
    });
  }

  // ========================================
  // PM: サブタスク分解
  // ========================================

  private async pmDecompose(conv: DevConversation): Promise<Subtask[]> {
    dbLog('info', 'dev-agent', '[PM] サブタスク分解開始', { convId: conv.id });

    // 要件が短すぎる場合は壊れている可能性が高い → エラー
    if (!conv.requirements || conv.requirements.length < 100) {
      throw new Error(`PM: 要件定義書が不正です (${conv.requirements?.length || 0}文字)。要件定義からやり直してください。`);
    }

    const codebaseCtx = await this.buildCodebaseContext();
    const MAX_DECOMPOSE_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_DECOMPOSE_RETRIES; attempt++) {
      const retryHint = attempt > 1 ? '\n\n⚠️ 前回の出力がJSON形式ではありませんでした。必ず {"subtasks": [...]} のJSON形式のみを出力してください。説明文は不要です。' : '';

      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + PM_DECOMPOSE_PROMPT,
        messages: [
          { role: 'user', content: `${codebaseCtx}\n\n以下の要件をサブタスクに分解してください:\n\n${conv.requirements}${retryHint}` },
        ],
        model: 'opus',
      });

      const parsed = safeParseJson(text);
      if (parsed && parsed.subtasks && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        return parsed.subtasks as Subtask[];
      }

      dbLog('warn', 'dev-agent', `[PM] サブタスク分解パース失敗 (${attempt}/${MAX_DECOMPOSE_RETRIES}): ${text.slice(0, 200)}`, { convId: conv.id });
    }

    throw new Error(`PM: サブタスク分解のパースに${MAX_DECOMPOSE_RETRIES}回失敗しました`);
  }

  // ========================================
  // エンジニア + レビュアー ループ
  // ========================================

  private async engineerAndReview(
    conv: DevConversation,
    subtask: Subtask,
    allSubtasks: Subtask[],
    completedFiles: Array<{ path: string; content: string }>,
  ): Promise<FileToWrite> {

    let reviewRetry = 0;
    let reviewFeedback = '';

    while (reviewRetry <= MAX_REVIEW_RETRIES) {
      // --- エンジニア（Claude CLI） ---
      const cliPrompt = this.buildCLIPrompt(conv, subtask, allSubtasks, completedFiles, reviewFeedback);

      dbLog('info', 'dev-agent', `[エンジニア/CLI] コード生成開始 (レビュー試行 ${reviewRetry + 1})`, { convId: conv.id, path: subtask.path });

      const cliResult = await runClaudeCLI(cliPrompt);

      if (!cliResult.success) {
        throw new Error(`CLI実行失敗: ${cliResult.output.slice(-300)}`);
      }

      dbLog('info', 'dev-agent', `[エンジニア/CLI] コード生成完了`, { convId: conv.id, path: subtask.path });

      // CLIが書いたファイルの内容を読み取り
      const content = await readProjectFile(subtask.path);
      if (!content) {
        throw new Error(`CLIがファイルを生成しませんでした: ${subtask.path}`);
      }

      const fileToWrite: FileToWrite = {
        path: subtask.path,
        content,
        action: subtask.action,
      };

      // --- レビュアー（Claude API, Sonnet） ---
      dbLog('info', 'dev-agent', `[レビュアー] レビュー開始: ${subtask.path}`, { convId: conv.id });

      const reviewContext = this.buildReviewContext(subtask, fileToWrite, completedFiles);

      const { text: reviewOutput } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + REVIEWER_PROMPT,
        messages: [{ role: 'user', content: reviewContext }],
        model: 'default',
      });

      const reviewParsed = safeParseJson(reviewOutput);

      if (!reviewParsed || reviewParsed.approved) {
        if (reviewParsed) {
          dbLog('info', 'dev-agent', `[レビュアー] 承認: ${subtask.path} - ${reviewParsed.summary}`, { convId: conv.id });
        } else {
          dbLog('warn', 'dev-agent', `[レビュアー] レビュー結果パース失敗。承認扱い`, { convId: conv.id });
        }
        return fileToWrite;
      }

      // レビューNG → フィードバックを次のCLI実行に渡す
      reviewRetry++;
      const issues = (reviewParsed.issues || []) as Array<{ severity: string; message: string; fix: string }>;
      reviewFeedback = issues.map(i => `[${i.severity}] ${i.message}\n修正: ${i.fix}`).join('\n\n');

      dbLog('warn', 'dev-agent', `[レビュアー] NG (${reviewRetry}/${MAX_REVIEW_RETRIES}): ${reviewParsed.summary}`, { convId: conv.id });

      if (reviewRetry > MAX_REVIEW_RETRIES) {
        dbLog('warn', 'dev-agent', `[レビュアー] 最大リトライ到達。最終版で続行`, { convId: conv.id });
        return fileToWrite;
      }
    }

    throw new Error(`レビューループ異常終了: ${subtask.path}`);
  }

  private buildCLIPrompt(
    conv: DevConversation,
    subtask: Subtask,
    _allSubtasks: Subtask[],
    completedFiles: Array<{ path: string; content: string }>,
    reviewFeedback: string,
  ): string {
    let prompt = `CLAUDE.md を読んでから、以下のサブタスクを実装してください。

## サブタスク
- ファイル: ${subtask.path}
- 内容: ${subtask.description}
- アクション: ${subtask.action}

## 全体の要件定義
${conv.requirements}
`;

    if (completedFiles.length > 0) {
      prompt += `\n## 完了済みファイル（参照用）\n`;
      for (const f of completedFiles) {
        prompt += `- ${f.path}\n`;
      }
    }

    if (reviewFeedback) {
      prompt += `\n## レビュアーからのフィードバック（必ず反映すること）\n${reviewFeedback}\n`;
    }

    prompt += `\n## 指示
- このサブタスク（1ファイル）だけを作成/変更してください
- npm run build でビルドが通ることを確認してください`;

    return prompt;
  }

  private buildReviewContext(
    subtask: Subtask,
    file: FileToWrite,
    completedFiles: Array<{ path: string; content: string }>,
  ): string {
    let ctx = `## レビュー対象\npath: ${file.path}\naction: ${file.action}\n\n`;
    ctx += `## コード\n\`\`\`typescript\n${file.content}\n\`\`\`\n\n`;
    ctx += `## サブタスクの説明\n${subtask.description}\n\n`;

    if (completedFiles.length > 0) {
      ctx += `## 関連する完了済みファイル\n`;
      for (const f of completedFiles) {
        ctx += `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\`\n\n`;
      }
    }

    return ctx;
  }

  // ========================================
  // Phase 4: ビルド → テスト → 自己修正 → デプロイ
  // ========================================

  private async runBuildAndDeploy(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
  ): Promise<void> {
    // ── Step 1: ビルド ──
    dbLog('info', 'dev-agent', `[チーム] ビルド開始 (試行 ${retryCount + 1})`, { convId: conv.id });
    const buildResult = await runBuild();

    if (!buildResult.success) {
      // ビルド失敗 → 自動修正
      if (retryCount < MAX_BUILD_RETRIES) {
        await this.autoFixBuildError(conv, lastFiles, retryCount, branchName, buildResult.buildOutput || '');
      } else {
        dbLog('error', 'dev-agent', `[チーム] ビルド修正${MAX_BUILD_RETRIES}回失敗`, { convId: conv.id });
        await rollbackGit(branchName).catch(() => {});
        updateConversationStatus(conv.id, 'failed');
        this.stuckContextMap.delete(conv.id);
        await sendLineMessage(conv.user_id,
          `ビルドエラーを${MAX_BUILD_RETRIES}回修正しましたが解決できませんでした:\n${buildResult.buildOutput?.slice(0, 500)}\n\n手動での修正が必要です。コードをロールバックしました。`
        ).catch(() => {});
      }
      return;
    }

    await sendLineMessage(conv.user_id, '🔨 ビルド: OK');
    dbLog('info', 'dev-agent', '[チーム] ビルド成功 → テスト開始', { convId: conv.id });

    // ── Step 2-3: 起動テスト + 機能テスト ──
    await sendLineMessage(conv.user_id, '🧪 自動テスト実行中...');
    const testResults = await runAllTests();
    const allPassed = testResults.every(r => r.passed);

    if (allPassed) {
      // 全テスト通過
      for (const r of testResults) {
        const icon = r.stage === 'startup' ? '🚀' : '🧪';
        const name = r.stage === 'startup' ? '起動テスト' : '機能テスト';
        await sendLineMessage(conv.user_id, `${icon} ${name}: OK`);
      }
    } else {
      // テスト失敗 → 自己修正ループ
      const failedResult = testResults.find(r => !r.passed)!;
      const failedName = failedResult.stage === 'startup' ? '起動テスト' : '機能テスト';
      dbLog('warn', 'dev-agent', `[テスト] ${failedName}失敗`, { convId: conv.id, details: failedResult.details?.slice(0, 300) });

      await sendLineMessage(conv.user_id,
        `❌ ${failedName}失敗: ${failedResult.message}\n${failedResult.details?.slice(0, 200) || ''}`
      );

      if (retryCount < MAX_TEST_FIX_RETRIES) {
        await this.autoFixTestError(conv, lastFiles, retryCount, branchName, testResults);
      } else {
        dbLog('error', 'dev-agent', `[チーム] テスト修正${MAX_TEST_FIX_RETRIES}回失敗`, { convId: conv.id });
        await rollbackGit(branchName).catch(() => {});
        updateConversationStatus(conv.id, 'failed');
        this.stuckContextMap.delete(conv.id);
        await sendLineMessage(conv.user_id,
          `テスト失敗を${MAX_TEST_FIX_RETRIES}回修正しましたが解決できませんでした。\nコードをロールバックしました。`
        ).catch(() => {});
      }
      return;
    }

    // ── Step 4: デプロイ ──
    dbLog('info', 'dev-agent', '[チーム] 全テスト通過 → デプロイ開始', { convId: conv.id });
    await commitAndStay(branchName, `feat(dev-agent): ${conv.topic}`);

    const deployResult = await deployWithHealthCheck(branchName);
    if (deployResult.success) {
      updateConversationStatus(conv.id, 'deployed');
      this.stuckContextMap.delete(conv.id);
      const updatedConv = getConversation(conv.id) || conv;
      const generatedFiles = safeParseJson(updatedConv.generated_files) as string[] || [];

      dbLog('info', 'dev-agent', `[チーム] デプロイ成功: ${branchName}`, { convId: conv.id, files: generatedFiles });
      await sendLineMessage(conv.user_id,
        `✅ デプロイ完了!\n\n` +
        `${conv.topic}\n` +
        `ブランチ: ${branchName}\n` +
        `ファイル: ${generatedFiles.join(', ')}\n\n` +
        `ビルド・起動テスト・機能テスト・ヘルスチェック 全て通過。`
      );
    } else {
      updateConversationStatus(conv.id, 'failed');
      this.stuckContextMap.delete(conv.id);
      dbLog('error', 'dev-agent', `[チーム] デプロイ失敗: ${deployResult.message}`, { convId: conv.id });
      await sendLineMessage(conv.user_id,
        `${deployResult.message}\n前の状態に復帰済みです。`
      );
    }
  }

  // ── ビルドエラー自動修正 ──

  private async autoFixBuildError(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
    buildOutput: string,
  ): Promise<void> {
    dbLog('warn', 'dev-agent', `[エンジニア] ビルドエラー → 自動修正 (${retryCount + 1}/${MAX_BUILD_RETRIES})`, {
      convId: conv.id,
      buildOutput: buildOutput.slice(0, 300),
    });
    await sendLineMessage(conv.user_id,
      `🔧 ビルドエラー自動修正中... (${retryCount + 1}/${MAX_BUILD_RETRIES})`
    );

    try {
      const { extractErrorFiles } = await import('./deployer');
      const errorFiles = extractErrorFiles(buildOutput);
      let existingContext = '';
      for (const ef of errorFiles) {
        if (!lastFiles.find(f => f.path === ef)) {
          const content = await readProjectFile(ef);
          if (content) {
            existingContext += `### ${ef}（既存ファイル）\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
          }
        }
      }

      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
        messages: [{
          role: 'user',
          content: `以下のコードにビルドエラーがあります。修正してください。\n\n` +
            `## ビルドエラー\n${buildOutput}\n\n` +
            `## 今回変更したコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}\n\n` +
            (existingContext ? `## 関連する既存ファイル\n${existingContext}\n\n` : '') +
            `## 重要\n- 既存ファイルのimportパスや型定義に合わせてください\n- 存在しないモジュールをimportしないでください\n\n` +
            `全ファイルをまとめて修正してください。出力形式:\n{"files": [{"path": "...", "content": "...", "action": "..."}]}`,
        }],
        model: 'opus',
        maxTokens: 16384,
      });

      const parsed = safeParseJson(text);
      let fixedFiles: FileToWrite[];
      if (parsed?.files && Array.isArray(parsed.files)) {
        fixedFiles = parsed.files;
      } else if (parsed?.file) {
        fixedFiles = [parsed.file];
      } else {
        throw new Error('修正コードのパースに失敗');
      }

      await writeFiles(fixedFiles);
      await this.runBuildAndDeploy(conv, fixedFiles, retryCount + 1, branchName);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[エンジニア] ビルド自動修正失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });
      await rollbackGit(branchName).catch(() => {});
      updateConversationStatus(conv.id, 'failed');
      this.stuckContextMap.delete(conv.id);
      await sendLineMessage(conv.user_id,
        `ビルドエラーの自動修正に失敗しました:\n${errMsg.slice(0, 300)}\n\nコードをロールバックしました。`
      ).catch(() => {});
    }
  }

  // ── テスト失敗自動修正 ──

  private async autoFixTestError(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
    testResults: TestResult[],
  ): Promise<void> {
    dbLog('warn', 'dev-agent', `[エンジニア] テスト失敗 → 自動修正 (${retryCount + 1}/${MAX_TEST_FIX_RETRIES})`, { convId: conv.id });
    await sendLineMessage(conv.user_id,
      `🔧 テスト失敗の自動修正中... (${retryCount + 1}/${MAX_TEST_FIX_RETRIES})`
    );

    try {
      // 関連する既存ファイルも読み込む
      let existingContext = '';
      const relevantFiles = ['src/index.ts', 'src/line/sender.ts', 'src/config.ts'];
      for (const ef of relevantFiles) {
        if (!lastFiles.find(f => f.path === ef)) {
          const content = await readProjectFile(ef);
          if (content) {
            existingContext += `### ${ef}（既存ファイル）\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
          }
        }
      }

      const testReport = formatTestResults(testResults);

      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
        messages: [{
          role: 'user',
          content: `以下のコードはビルドは通りましたが、ランタイムテストで失敗しました。修正してください。\n\n` +
            `## テスト結果\n${testReport}\n\n` +
            `## テストの説明\n` +
            `- 起動テスト: PORT=3999 NODE_ENV=test で別プロセス起動 → /health で200確認\n` +
            `- 機能テスト: /test/task, /webhook, /telegram のルート存在確認\n\n` +
            `## 今回変更したコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}\n\n` +
            (existingContext ? `## 関連する既存ファイル\n${existingContext}\n\n` : '') +
            `## 重要\n- ランタイムエラー（起動時に落ちる原因）を特定して修正してください\n- importの不整合、未定義変数、型ミスマッチ等を確認\n- NODE_ENV=test時はLINE/Telegram送信がスキップされます\n\n` +
            `全ファイルをまとめて修正してください。出力形式:\n{"files": [{"path": "...", "content": "...", "action": "..."}]}`,
        }],
        model: 'opus',
        maxTokens: 16384,
      });

      const parsed = safeParseJson(text);
      let fixedFiles: FileToWrite[];
      if (parsed?.files && Array.isArray(parsed.files)) {
        fixedFiles = parsed.files;
      } else if (parsed?.file) {
        fixedFiles = [parsed.file];
      } else {
        throw new Error('修正コードのパースに失敗');
      }

      await writeFiles(fixedFiles);
      await this.runBuildAndDeploy(conv, fixedFiles, retryCount + 1, branchName);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[エンジニア] テスト自動修正失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });
      await rollbackGit(branchName).catch(() => {});
      updateConversationStatus(conv.id, 'failed');
      this.stuckContextMap.delete(conv.id);
      await sendLineMessage(conv.user_id,
        `テスト失敗の自動修正に失敗しました:\n${errMsg.slice(0, 300)}\n\nコードをロールバックしました。`
      ).catch(() => {});
    }
  }
}

function safeParseJson(text: string): any {
  let jsonStr = text.trim();

  // 1. マークダウンコードブロック除去
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // 2. そのまま試す
  try { return JSON.parse(jsonStr); } catch { /* continue */ }

  // 3. 最初の { ... } または [ ... ] ブロックを抽出
  const objMatch = jsonStr.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try { return JSON.parse(objMatch[1]); } catch { /* continue */ }
  }
  const arrMatch = jsonStr.match(/(\[[\s\S]*\])/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[1]); } catch { /* continue */ }
  }

  // 4. 末尾のカンマ除去して再試行
  if (objMatch) {
    const cleaned = objMatch[1].replace(/,\s*([\]}])/g, '$1');
    try { return JSON.parse(cleaned); } catch { /* continue */ }
  }

  return null;
}
