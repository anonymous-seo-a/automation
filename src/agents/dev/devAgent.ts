import { Agent, Task, TaskResult } from '../baseAgent';
import { callClaude } from '../../claude/client';
import { sendLineMessage } from '../../line/sender';
import { logger, dbLog } from '../../utils/logger';
import {
  getActiveConversation,
  createConversation,
  getConversation,
  updateConversationStatus,
  touchConversation,
  appendHearingLog,
  setRequirements,
  setGeneratedFiles,
  cancelConversation,
  getHearingRound,
  DevConversation,
  buildDevHistorySummary,
  buildRelatedDevContext,
} from './conversation';
import {
  DEV_SYSTEM_PROMPT,
  PM_HEARING_PROMPT,
  PM_REQUIREMENTS_PROMPT,
  PM_DECOMPOSE_PROMPT,
  ENGINEER_PROMPT,
  REVIEWER_PROMPT,
  buildAgentPersonality,
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
import { getRecentHistory } from '../../line/messageHistory';
import { buildAgentMemoryContext } from './teamMemory';
import { recordMetric } from './teamEvaluation';
import { recordReject, handleConsult, runConsensus, saveTeamConversation } from './teamConversation';
import { recordBuildLearning, recordRejectLearning, recordReviewerLearning, recordDeployerLearning, recordTestLearning, recordPmLearning } from './teamMemory';
import { runPreflightChecks, autoFixEnvironment } from './preflight';
import { classifyError, categoryLabel } from './errorClassifier';
import { runTeamDiagnosis, DiagnosisResult } from './teamDiagnosis';
import { emitDevEvent } from '../../events/devEvents';
import { buildExecutionBatches, formatBatchPlan } from './scheduler';
import { findRelevantProcedures, extractProcedure, updateProcedureOutcome } from './proceduralMemory';
import { getMonthlySpend } from '../../claude/budgetTracker';
import { config } from '../../config';

const MAX_BUILD_RETRIES = 3;
const MAX_TEST_FIX_RETRIES = 3;
const MAX_HEARING_ROUNDS = 3;
const MAX_REVIEW_RETRIES = 2;
const MAX_ENGINEER_PARSE_RETRIES = 3;
const MAX_DIAGNOSIS_ROUNDS = 2;   // チーム診断→リトライの最大サイクル数
const MAX_STUCK_DIALOGUE = 5;     // stuck時のPM対話の最大ラウンド数
const MAX_TRANSIENT_WAITS = 3;    // 一時的エラー待機の最大回数（autoFix内）
const PHASE_TIMEOUT_MS = 5 * 60 * 1000; // 各フェーズ最大5分

// レビュアーに常に提供するシステム基盤ファイル（コンテキスト不足による無限差し戻し防止）
const SYSTEM_REFERENCE_FILES = [
  'src/db/migrations.ts',
  'src/config.ts',
  'package.json',
];

/** 2つの差し戻し理由が同一パターンかを判定（単語重複率ベース） */
function isSimilarReject(prev: string, curr: string): boolean {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^\w\u3000-\u9fff]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const prevWords = new Set(normalize(prev));
  const currWords = normalize(curr);
  if (prevWords.size === 0 || currWords.length === 0) return false;
  const overlap = currWords.filter(w => prevWords.has(w)).length;
  return overlap / Math.min(prevWords.size, currWords.length) > 0.4;
}

interface Subtask {
  index: number;
  path: string;
  action: 'create' | 'update';
  description: string;
  depends_on: number[];  // 依存するサブタスクのindex（空配列 = 独立）
  difficulty: 'simple' | 'moderate' | 'complex';
}

interface StuckContext {
  branchName: string;
  subtasks: Subtask[];
  completedFiles: Array<{ path: string; content: string }>;
  failedSubtaskIndex: number;
  errorMessage: string;
  phase: string; // エラーが起きたフェーズ名
  lastFiles?: FileToWrite[]; // build/testフェーズで使用したファイル（リカバリ用）
  // エスカレーション強化: 対話と状況のコンテキスト
  triedActions?: string[];         // これまでに試したこと
  teamDiagnosis?: string;          // チーム診断結果のサマリー
  dialogueLog?: Array<{ role: 'pm' | 'user'; message: string }>;  // ユーザーとの対話履歴
  awaitingConfirmation?: boolean;  // PMがアクション確認待ち
  proposedAction?: string;         // PM提案のアクション（retry/skip/cancel/custom）
  errorCategory?: string;          // エラーの分類（git/build/test/api/unknown）
  errorExplanation?: string;       // 人間向けのエラー説明
}

/** エラーメッセージを人間が分かる分類と説明に変換 */
function classifyStuckError(errorMessage: string, phase: string): { category: string; explanation: string } {
  const msg = errorMessage.toLowerCase();

  if (/git commit.*failed|git.*nothing to commit/i.test(errorMessage)) {
    if (/[\r\n]/.test(errorMessage) && /commit -m/.test(errorMessage)) {
      return { category: 'git（コミットメッセージ）', explanation: 'コミットメッセージに改行や特殊文字が含まれていてgitコマンドが失敗しました。メッセージの書式を修正する必要があります。' };
    }
    if (/nothing to commit/.test(msg)) {
      return { category: 'git（変更なし）', explanation: 'コミットしようとしましたが、ファイルに変更がありませんでした。コード生成が正しく動作していない可能性があります。' };
    }
    return { category: 'git', explanation: 'gitのコミット操作が失敗しました。ブランチの状態やファイルの権限に問題がある可能性があります。' };
  }
  if (/tsc|typescript|type error|ts\(\d+\)/i.test(msg)) {
    return { category: 'ビルド（TypeScriptエラー）', explanation: 'TypeScriptのコンパイルエラーが発生しています。生成されたコードに型の不整合やimportの問題があります。' };
  }
  if (/npm run build|build failed/i.test(msg)) {
    return { category: 'ビルド', explanation: 'プロジェクトのビルドが失敗しました。生成されたコードにエラーがあります。' };
  }
  if (/429|rate.?limit|too many requests/i.test(msg)) {
    return { category: 'API制限', explanation: 'Claude APIの呼び出し回数が上限に達しました。しばらく待ってからリトライすれば解決します。' };
  }
  if (/health.?check|pm2|restart|deploy/i.test(msg)) {
    return { category: 'デプロイ', explanation: 'サーバーの再起動やヘルスチェックが失敗しました。サーバーの状態を確認する必要があります。' };
  }
  if (/test.*fail|assert|expect/i.test(msg)) {
    return { category: 'テスト', explanation: '自動テストが失敗しています。生成されたコードの動作が期待と異なります。' };
  }
  if (/cli.*fail|timeout/i.test(msg)) {
    return { category: 'コード生成', explanation: 'Claude CLIでのコード生成に失敗しました。タイムアウトや接続エラーの可能性があります。' };
  }
  if (phase === 'implementing') {
    return { category: '実装エラー', explanation: 'コードの実装中にエラーが発生しました。' };
  }
  return { category: '不明', explanation: 'エラーの詳細を確認中です。' };
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class DevAgent implements Agent {
  name = 'dev';

  // 会話ID → stuckコンテキストのマッピング（シングルトンでも安全）
  private stuckContextMap = new Map<string, StuckContext>();
  // リトライ/スキップ実行中の会話IDセット（二重実行防止）
  private resumingSet = new Set<string>();
  // コードベースコンテキストキャッシュ（会話中に何度も再取得しない）
  private codebaseCtxCache: { text: string; cachedAt: number } | null = null;
  private readonly CODEBASE_CTX_TTL_MS = 10 * 60 * 1000; // 10分キャッシュ
  // 現在の開発タスクの受け入れ条件（AC）
  private currentAC: string[] = [];

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
        const conv = await getActiveConversation(userId);
        if (conv) {
          this.cleanupConversation(conv.id, conv.user_id);
          await cancelConversation(conv.id);
          dbLog('info', 'dev-agent', `開発キャンセル: ${conv.topic}`, { convId: conv.id });
          await sendLineMessage(userId, '開発を中止しました。');
        } else {
          await sendLineMessage(userId, '進行中の開発はありません。');
        }
        return;
      }

      let conv = await getActiveConversation(userId);

      if (!conv) {
        // 予算ゲート: 月次上限到達時は新規開発を拒否
        const monthlySpend = await getMonthlySpend();
        if (monthlySpend >= config.claude.monthlyBudgetUsd) {
          await sendLineMessage(userId, `月次API予算上限に到達しています ($${monthlySpend.toFixed(2)}/$${config.claude.monthlyBudgetUsd})。\n開発は来月まで一時停止中です。\n\n「API使用量」で詳細を確認できます。`);
          return;
        }

        conv = await createConversation(userId, text);
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
          await updateConversationStatus(conv.id, 'failed');
          await sendLineMessage(userId, `開発が不整合な状態になっています（ステータス: ${conv.status}）。新しい開発依頼を送ってください。`);
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
        await updateConversationStatus(conv.id, 'failed');
        emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'failed', reason: errMsg.slice(0, 100) } });
        // 529/500エラーは人間向けメッセージに変換
        const isOverloaded = /529|overloaded|500.*Internal server/i.test(errMsg);
        const userMessage = isOverloaded
          ? 'Claude Opus が一時的に混雑しています（Anthropic側の障害）。\n数分後に再度お試しください。\n\n※ 状況確認: status.anthropic.com'
          : `${phaseName}フェーズでエラーが発生しました:\n${errMsg.slice(0, 300)}\n\n新しい開発依頼を送り直してください。`;
        await sendLineMessage(conv.user_id, userMessage).catch(() => {});
        return;
      }

      // implementing/stuck フェーズは途中作業を保全してstuckに移行
      if (conv.status !== 'stuck') {
        await updateConversationStatus(conv.id, 'stuck');
        emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'stuck', reason: errMsg.slice(0, 100) } });
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
          dialogueLog: [],
          triedActions: [],
        });
      } else {
        const ctx = this.stuckContextMap.get(conv.id)!;
        ctx.errorMessage = errMsg;
        ctx.phase = phaseName;
      }

      const isOverloaded = /529|overloaded|500.*Internal server/i.test(errMsg);
      const stuckMessage = isOverloaded
        ? 'Claude Opus が一時的に混雑しています。\n\n・「リトライ」→ 再試行\n・「中止」→ 開発を中止'
        : `${phaseName}フェーズでエラーが発生しました:\n${errMsg.slice(0, 300)}\n\n選択肢:\n・「リトライ」→ 再試行\n・「中止」→ 開発を中止（完了分はブランチに残ります）`;
      await sendLineMessage(conv.user_id, stuckMessage).catch(() => {});
    }
  }

  /** 会話に関連するリソースのクリーンアップ */
  private cleanupConversation(convId: string, _userId: string): void {
    this.stuckContextMap.delete(convId);
    this.codebaseCtxCache = null; // 次の会話で最新のコードベースを取得
    this.currentAC = [];
  }

  // ========================================
  // コードベースコンテキスト（PM用）
  // ========================================

  /**
   * PMがプロジェクト構造を理解するためのコンテキストを構築。
   * GitHubのファイルツリー + 主要ファイルの内容を含む。
   */
  private async buildCodebaseContext(): Promise<string> {
    // キャッシュが有効ならそのまま返す（同一会話中の再取得を回避）
    if (this.codebaseCtxCache && Date.now() - this.codebaseCtxCache.cachedAt < this.CODEBASE_CTX_TTL_MS) {
      return this.codebaseCtxCache.text;
    }

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
      // DBスキーマはCREATE TABLE文のみ抽出（インデックス定義はPMに不要）
      const tableOnly = migrations.replace(/\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS[^;]+;/g, '');
      ctx += '### DBスキーマ (src/db/migrations.ts)\n```typescript\n' + tableOnly + '\n```\n\n';
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

    this.codebaseCtxCache = { text: ctx, cachedAt: Date.now() };
    return ctx;
  }

  // ========================================
  // Phase 1: ヒアリング（PM）
  // ========================================

  /**
   * ヒアリング用の会話コンテキストを構築。
   * PMが過去の文脈を理解した上でヒアリングできるよう:
   * - 直近のLINE会話(10件) — ユーザーが直前に何を話していたか
   * - 過去の開発実績(5件) — 既に何を作ったか
   * - PMのチーム記憶 — 過去の学習・評価
   */
  private async buildConversationContext(userId: string, topic: string): Promise<string> {
    let ctx = '';

    // 1. 直近LINE会話（10件）— PMが会話の流れを把握
    try {
      const recentMessages = await getRecentHistory(userId, 10);
      if (recentMessages.length > 0) {
        ctx += '## 直前のLINE会話（文脈把握用）\n';
        for (const msg of recentMessages) {
          const role = msg.role === 'user' ? 'Daiki' : '分身';
          ctx += `${role}: ${msg.content.slice(0, 200)}\n`;
        }
        ctx += '\n';
      }
    } catch {
      // 取得失敗しても続行
    }

    // 2. 過去開発実績 — 既存機能の把握
    const devHistory = await buildDevHistorySummary(5);
    if (devHistory) {
      ctx += devHistory + '\n\n';
    }

    // 3. PMのチーム記憶（学習・評価・パターン）
    try {
      const memoryCtx = await buildAgentMemoryContext('pm', topic);
      if (memoryCtx) {
        ctx += memoryCtx + '\n\n';
      }
    } catch {
      // 取得失敗しても続行
    }

    return ctx;
  }

  private async runHearing(conv: DevConversation, initialMessage: string): Promise<void> {
    await appendHearingLog(conv.id, 'user', initialMessage);
    dbLog('info', 'dev-agent', `[PM] ヒアリング開始: round 1/${MAX_HEARING_ROUNDS}`, { convId: conv.id });
    emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'hearing', topic: initialMessage.slice(0, 60) } });
    emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'pm', data: { status: 'thinking', message: 'ヒアリング分析中...' } });

    const updatedConv = await getConversation(conv.id);
    if (!updatedConv) {
      dbLog('error', 'dev-agent', `[PM] 会話データ消失: ${conv.id}`, { convId: conv.id });
      await updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id, '会話データの読み込みに失敗しました。もう一度開発依頼を送ってください。').catch(() => {});
      return;
    }
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    const [codebaseCtx, conversationCtx] = await Promise.all([
      this.buildCodebaseContext(),
      this.buildConversationContext(conv.user_id, initialMessage),
    ]);

    const pmSystem = await buildAgentPersonality('pm', initialMessage);

    const { text } = await callClaude({
      system: pmSystem + '\n\n' + PM_HEARING_PROMPT,
      messages: [
        { role: 'user', content: `${codebaseCtx}\n\n${conversationCtx}\n\n開発依頼: ${initialMessage}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\n現在のヒアリング回数: 1/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'default',
    });

    dbLog('info', 'dev-agent', `[PM] ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async handleHearing(conv: DevConversation, userReply: string): Promise<void> {
    await appendHearingLog(conv.id, 'user', userReply);

    const round = await getHearingRound(conv.id);
    dbLog('info', 'dev-agent', `[PM] ヒアリング回答受信: round ${round}/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = await getConversation(conv.id);
    if (!updatedConv) {
      dbLog('error', 'dev-agent', `[PM] 会話データ消失: ${conv.id}`, { convId: conv.id });
      await updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id, '会話データの読み込みに失敗しました。もう一���開発依頼を送ってください。').catch(() => {});
      return;
    }
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    if (round >= MAX_HEARING_ROUNDS) {
      dbLog('info', 'dev-agent', '[PM] ヒアリング最大回数到達 → 要件定義へ', { convId: conv.id });
      await appendHearingLog(conv.id, 'agent', 'ヒアリング最大回数到達。要件定義に進みます。');
      await this.transitionToDefining(conv);
      return;
    }

    const [codebaseCtx, conversationCtx] = await Promise.all([
      this.buildCodebaseContext(),
      this.buildConversationContext(conv.user_id, conv.topic || ''),
    ]);

    const pmSystem = await buildAgentPersonality('pm', conv.topic);

    const { text } = await callClaude({
      system: pmSystem + '\n\n' + PM_HEARING_PROMPT,
      messages: [
        { role: 'user', content: `${codebaseCtx}\n\n${conversationCtx}\n\n開発依頼: ${conv.topic}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\nユーザーの最新回答: ${userReply}\n\n現在のヒアリング回数: ${round}/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'default',
    });

    dbLog('info', 'dev-agent', `[PM] ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async processHearingResponse(conv: DevConversation, text: string): Promise<void> {
    // キャンセル済みの会話はスキップ（Opusリトライ中にユーザーがキャンセルした場合）
    const freshConv = await getConversation(conv.id);
    if (!freshConv || freshConv.status === 'failed' || freshConv.status === 'deployed') {
      dbLog('info', 'dev-agent', `[PM] 会話終了済み(${freshConv?.status || 'deleted'}) → ヒアリング応答スキップ`, { convId: conv.id });
      return;
    }

    const parsed = safeParseJson(text);

    if (parsed && parsed.hearing_complete) {
      dbLog('info', 'dev-agent', '[PM] ヒアリング完了 → 要件定義へ', { convId: conv.id });
      await appendHearingLog(conv.id, 'agent', parsed.summary || 'ヒアリング完了');
      await saveTeamConversation('pm_hearing', ['pm', 'user'], [
        { role: 'pm', message: parsed.summary || 'ヒアリング完了', timestamp: new Date().toISOString() },
      ], conv.id, parsed.summary);
      await this.transitionToDefining(conv);
    } else if (parsed && parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      const questions = (parsed.questions as string[]).slice(0, 3);
      const msg = questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n') + '\n\n（「やめる」で中止できます）';
      await appendHearingLog(conv.id, 'agent', msg);
      emitDevEvent({ type: 'agent_message', convId: conv.id, agent: 'pm', data: { message: questions[0]?.slice(0, 80) || 'ヒアリング質問' } });
      await sendLineMessage(conv.user_id, msg);
    } else {
      dbLog('warn', 'dev-agent', `[PM] ヒアリング応答がJSON外: ${text.slice(0, 80)}`, { convId: conv.id });
      await appendHearingLog(conv.id, 'agent', text);
      await sendLineMessage(conv.user_id, text);
    }
  }

  // ========================================
  // Phase 2: 要件定義（PM - Opus）
  // ========================================

  private async transitionToDefining(conv: DevConversation): Promise<void> {
    await updateConversationStatus(conv.id, 'defining');
    dbLog('info', 'dev-agent', '[PM] 要件定義書作成開始', { convId: conv.id });
    emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'defining' } });
    emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'pm', data: { status: 'thinking', message: '要件定義書作成中...' } });

    const updatedConv = await getConversation(conv.id);
    if (!updatedConv) {
      dbLog('error', 'dev-agent', `[PM] 会話データ消失: ${conv.id}`, { convId: conv.id });
      await updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id, '会話データの読み込みに失敗しました。もう一度開発依頼を送ってください。').catch(() => {});
      return;
    }
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    await sendLineMessage(conv.user_id, 'ヒアリング完了。要件定義書を作成中...');

    const codebaseCtx = await this.buildCodebaseContext();

    const { text: rawRequirements } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_REQUIREMENTS_PROMPT,
      messages: [
        { role: 'user', content: `${codebaseCtx}\n\n開発依頼: ${conv.topic}\n\nヒアリング内容:\n${JSON.stringify(hearingLog)}` },
      ],
      model: 'default',
    });

    // PM Self-Refine: 要件定義書の自己批評（AC粒度・登録漏れ・テスト方法の具体性を検証）
    let text = rawRequirements;
    try {
      dbLog('info', 'dev-agent', '[PM] Self-Refine: 要件定義書を自己批評中', { convId: conv.id });
      const { text: selfReviewResult } = await callClaude({
        system: DEV_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `以下の要件定義書を批評し、問題があれば修正版を出力してください。

${rawRequirements}

## チェック項目
1. 各ACは具体的で検証可能か？「〜できること」が動作として記述されているか？
2. UIを追加する場合、「既存ナビゲーションからリンクで到達できること」がACに含まれているか？
3. 新規ファイルを作る場合、「app.ts/dashboard.tsへの登録」がサブタスクに含まれるか？
4. テスト方法は具体的か？（「動作確認」ではなく「〇〇にアクセスして△△が表示される」等）
5. 各ACが少なくとも1つのサブタスクでカバーされているか？

問題がなければ「LGTM」とだけ出力。問題があれば修正した完全な要件定義書を出力してください。`,
        }],
        model: 'default',
        enableThinking: true,
        thinkingBudget: 3000,
        timeoutMs: 120_000,
      });
      if (!selfReviewResult.includes('LGTM')) {
        text = selfReviewResult;
        dbLog('info', 'dev-agent', '[PM] Self-Refine: 要件定義書を修正', { convId: conv.id });
      } else {
        dbLog('info', 'dev-agent', '[PM] Self-Refine: LGTM（修正不要）', { convId: conv.id });
      }
    } catch (err) {
      dbLog('warn', 'dev-agent', `[PM] Self-Refine失敗（原版を使用）: ${err instanceof Error ? err.message : String(err)}`, { convId: conv.id });
      // Self-Refineは品質向上の追加ステップ。失敗しても原版で続行するが、ユーザーに通知
      await sendLineMessage(conv.user_id, '※ 要件の品質チェック（Self-Refine）をスキップしました。内容を特に注意して確認してください。').catch(() => {});
    }

    await setRequirements(conv.id, text);
    dbLog('info', 'dev-agent', `[PM] 要件定義書作成完了 (${text.length}文字)`, { convId: conv.id });
    await saveTeamConversation('pm_requirements', ['pm'], [
      { role: 'pm', message: text, timestamp: new Date().toISOString() },
    ], conv.id, `要件定義書作成完了 (${text.length}文字)`);
    await sendLineMessage(conv.user_id, text);
    await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
  }

  private async handleDefining(conv: DevConversation, userReply: string): Promise<void> {
    dbLog('info', 'dev-agent', `[PM] 要件定義フェーズ応答: ${userReply.slice(0, 40)}`, { convId: conv.id });

    // 要件が未生成の場合は何もしない（webhookで弾くが二重安全）
    const freshConv = await getConversation(conv.id);
    if (!freshConv?.requirements) {
      dbLog('warn', 'dev-agent', '[PM] 要件未生成のまま handleDefining に到達', { convId: conv.id });
      await sendLineMessage(conv.user_id, '要件定義書を作成中です。完了までお待ちください。');
      return;
    }

    if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで|それでいい|いいと思う|よさそう|良さそう)$/i.test(userReply.trim())) {
      await updateConversationStatus(freshConv.id, 'approved');
      dbLog('info', 'dev-agent', '[PM] 要件承認 → 実装開始', { convId: conv.id });
      emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'approved' } });
      await sendLineMessage(conv.user_id, '実装を開始します。チーム体制で進めます。\n（PM → エンジニア → レビュアー の順で各ファイルを処理）');
      // 実装は非同期で実行（safeExecutePhaseの5分タイムアウトを回避）
      // runImplementation は独自のtry/catch/finallyで全てのエラーを処理する
      this.runImplementation(conv).catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `[チーム] 実装未捕捉エラー: ${errMsg}`, { convId: conv.id });
        await updateConversationStatus(conv.id, 'failed');
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
        model: 'default',
      });

      await setRequirements(conv.id, text);
      dbLog('info', 'dev-agent', `[PM] 要件修正完了 (${text.length}文字)`, { convId: conv.id });
      await saveTeamConversation('pm_requirements_revision', ['pm', 'user'], [
        { role: 'user', message: userReply, timestamp: new Date().toISOString() },
        { role: 'pm', message: text, timestamp: new Date().toISOString() },
      ], conv.id, `要件修正完了 (${text.length}文字)`);
      await sendLineMessage(conv.user_id, text);
      await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
    }
  }

  // ========================================
  // Phase 3: 実装（チーム体制）
  // ========================================

  private async runImplementation(conv: DevConversation, resumeFrom?: { branchName: string; subtasks: Subtask[]; completedFiles: Array<{ path: string; content: string }>; startIndex: number }): Promise<void> {
    await updateConversationStatus(conv.id, 'implementing');
    dbLog('info', 'dev-agent', '[チーム] 実装フェーズ開始', { convId: conv.id });
    emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'implementing', topic: conv.topic } });

    const updatedConv = await getConversation(conv.id);
    if (!updatedConv) {
      dbLog('error', 'dev-agent', `[チーム] 会話データ消失: ${conv.id}`, { convId: conv.id });
      await updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id, '会話データが見つかりません。新しい開発依頼を送ってください。').catch(() => {});
      return;
    }

    let branchName = resumeFrom?.branchName || '';
    let subtasks: Subtask[] = resumeFrom?.subtasks || [];
    const allFiles: FileToWrite[] = [];
    const completedFiles: Array<{ path: string; content: string }> = resumeFrom?.completedFiles || [];
    let startIndex = resumeFrom?.startIndex || 0;
    let gitLockAcquired = false;

    try {
      // 新規開始の場合
      if (!resumeFrom) {
        // ── プリフライトチェック ──
        emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'system', data: { status: 'working', message: '環境チェック中...' } });
        await sendLineMessage(conv.user_id, '🔍 環境チェック中...');
        const preflight = await runPreflightChecks();
        if (preflight.fixedIssues.length > 0) {
          await sendLineMessage(conv.user_id, `🔧 自動修正: ${preflight.fixedIssues.join(', ')}`);
        }
        if (!preflight.passed) {
          const errorMsgs = preflight.issues.filter(i => i.severity === 'error').map(i => `・${i.message}`).join('\n');
          throw new Error(`環境チェック失敗（自動修正不可）:\n${errorMsgs}`);
        }
        if (preflight.issues.length > 0) {
          const warnMsgs = preflight.issues.filter(i => i.severity === 'warning').map(i => `⚠️ ${i.message}`).join('\n');
          await sendLineMessage(conv.user_id, `警告:\n${warnMsgs}\n\n続行します。`);
        }

        // Gitロック取得（キュー待ち）
        await sendLineMessage(conv.user_id, 'Gitロック取得中...');
        gitLockAcquired = await acquireGitLock(conv.id, 60_000);
        if (!gitLockAcquired) {
          throw new Error('Git操作のロック取得に失敗しました（他の開発が進行中の可能性）');
        }

        branchName = await prepareGitBranch();
        dbLog('info', 'dev-agent', `[チーム] ブランチ作成: ${branchName}`, { convId: conv.id });
        emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'deployer', data: { status: 'working', message: `ブランチ作成: ${branchName}` } });
        await sendLineMessage(conv.user_id, `ブランチ: ${branchName}`);

        emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'pm', data: { status: 'thinking', message: 'サブタスク分解中...' } });
        subtasks = await this.pmDecompose(updatedConv);
        dbLog('info', 'dev-agent', `[PM] サブタスク分解完了: ${subtasks.length}件`, { convId: conv.id });
        emitDevEvent({ type: 'agent_message', convId: conv.id, agent: 'pm', data: { message: `${subtasks.length}個のサブタスクに分解` } });
        await saveTeamConversation('pm_decompose', ['pm'], [
          { role: 'pm', message: `サブタスク分解:\n${subtasks.map(s => `${s.index}. [${s.action}] ${s.path}: ${s.description}`).join('\n')}`, timestamp: new Date().toISOString() },
        ], conv.id, `${subtasks.length}個のサブタスクに分解`);
        await sendLineMessage(conv.user_id, `${subtasks.length}個のサブタスクに分解しました:\n${subtasks.map(s => `${s.index}. ${s.path}`).join('\n')}`);
      } else {
        // 再開時もロック取得
        gitLockAcquired = await acquireGitLock(conv.id, 60_000);
        if (!gitLockAcquired) {
          throw new Error('Git操作のロック取得に失敗しました');
        }
        await sendLineMessage(conv.user_id, `サブタスク ${startIndex + 1} から再開します...`);
      }

      // depends_on/difficultyフィールドがないサブタスク（PMが古い形式で返した場合）のデフォルト設定
      for (const st of subtasks) {
        if (!st.depends_on) st.depends_on = [];
        if (!st.difficulty) st.difficulty = 'moderate';
      }

      // 再開時: startIndexから始まる未完了サブタスクのみ対象
      const remainingSubtasks = startIndex > 0
        ? subtasks.filter((_, idx) => idx >= startIndex)
        : subtasks;

      const batches = buildExecutionBatches(remainingSubtasks);
      dbLog('info', 'dev-agent', `[PM] バッチ計画: ${batches.length}バッチ`, { convId: conv.id });
      const batchPlan = formatBatchPlan(batches);
      await sendLineMessage(conv.user_id, `⚡ 実行計画（${batches.length}バッチ）:\n${batchPlan}`);
      emitDevEvent({ type: 'agent_message', convId: conv.id, agent: 'pm', data: { message: `実行計画:\n${batchPlan}` } });

      // バッチごとに実行
      for (const batch of batches) {
        await touchConversation(conv.id);

        if (batch.subtasks.length === 1) {
          // === 単一サブタスク → 従来通り直列実行 ===
          const subtask = batch.subtasks[0];
          dbLog('info', 'dev-agent', `[バッチ${batch.batchIndex}] 直列: ${subtask.path}`, { convId: conv.id });

          try {
            const result = await this.engineerAndReview(conv, subtask, subtasks, completedFiles);
            allFiles.push(result.file);
            completedFiles.push({ path: result.file.path, content: result.file.content });

            const commitResult = await commitAndStay(branchName, `feat: ${subtask.path}`);
            if (!commitResult.success) {
              const classified = classifyError(commitResult.error || '');
              dbLog('warn', 'dev-agent', `[チーム] コミット失敗: ${categoryLabel(classified.category)} - ${classified.subcategory}`, { convId: conv.id });
              if (classified.autoFixable) {
                const fixed = await autoFixEnvironment(classified);
                if (fixed) {
                  const retryResult = await commitAndStay(branchName, `feat: ${subtask.path}`);
                  if (!retryResult.success) throw new Error(`コミット失敗（自動修正後も解決せず）: ${retryResult.error}`);
                  dbLog('info', 'dev-agent', `[チーム] コミット: 自動修正後に成功`, { convId: conv.id });
                } else {
                  throw new Error(`コミット失敗（自動修正失敗）: ${commitResult.error}`);
                }
              } else {
                throw new Error(`コミット失敗: ${commitResult.error}`);
              }
            }

            await touchConversation(conv.id);
            const modelIcon = result.model === 'opus' ? '🧠' : '⚡';
            await sendLineMessage(conv.user_id, `${subtask.index}/${subtasks.length} 完了: ${subtask.path} (${result.model} ${modelIcon})`);
          } catch (subtaskErr) {
            const errMsg = subtaskErr instanceof Error ? subtaskErr.message : String(subtaskErr);
            dbLog('error', 'dev-agent', `[チーム] サブタスク失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id, subtaskIndex: subtask.index });

            const isEscalation = subtaskErr instanceof EscalationError;
            const triedActions = isEscalation
              ? [`サブタスク${subtask.index}の実装を複数回試行`, 'チーム合議の結果、ユーザー判断が必要と判断']
              : [`サブタスク${subtask.index}の実装を${MAX_REVIEW_RETRIES > 0 ? 'レビュー差し戻し含め複数回' : '1回'}試行`];

            const failIdx = subtasks.findIndex(s => s.index === subtask.index);
            this.stuckContextMap.set(conv.id, {
              branchName, subtasks, completedFiles: [...completedFiles],
              failedSubtaskIndex: failIdx >= 0 ? failIdx : 0,
              errorMessage: errMsg, phase: 'implementing', triedActions, dialogueLog: [],
            });
            await updateConversationStatus(conv.id, 'stuck');
            if (gitLockAcquired) { releaseGitLock(conv.id); gitLockAcquired = false; }

            const stuckUrl1 = `${config.admin.baseUrl}/admin/dev/${conv.id}`;
            if (isEscalation) {
              await saveTeamConversation('pm_escalation', ['pm', 'user'], [
                { role: 'pm', message: errMsg, timestamp: new Date().toISOString() },
              ], conv.id, 'ユーザーへエスカレーション');
              await sendLineMessage(conv.user_id,
                `📋 PMからの相談\n\n■ 状況: サブタスク ${subtask.index}/${subtasks.length} (${subtask.path}) で方針判断が必要です\n■ 進捗: ${completedFiles.length}/${subtasks.length} ファイル完了済み\n\n■ 経緯:\n${errMsg}\n\nどう進めるべきか、方針を教えてください。\n「リトライ」「スキップ」「中止」も選べます。\n\n詳細: ${stuckUrl1}`
              );
            } else {
              const { category: errCat1, explanation: errExp1 } = classifyStuckError(errMsg, 'implementing');
              await sendLineMessage(conv.user_id,
                `📋 PMからの報告\n\n■ 状況: サブタスク ${subtask.index}/${subtasks.length} (${subtask.path}) で問題発生\n■ 進捗: ${completedFiles.length}/${subtasks.length} ファイル完了済み（コミット済み）\n■ エラー種別: ${errCat1}\n■ 原因: ${errExp1}\n\n■ 試したこと:\n${triedActions.map(a => `・${a}`).join('\n')}\n\n何か気になる点や指示があれば送ってください。「リトライ」「スキップ」「中止」も選べます。\n\n詳細: ${stuckUrl1}`
              );
            }
            return; // stuckで一旦停止
          }

        } else {
          // === 複数サブタスク → 並列実行 ===
          const parallelPaths = batch.subtasks.map(s => s.path.split('/').pop()).join(', ');
          dbLog('info', 'dev-agent', `[バッチ${batch.batchIndex}] ⚡並列(${batch.subtasks.length}): ${parallelPaths}`, { convId: conv.id });
          await sendLineMessage(conv.user_id, `⚡ バッチ${batch.batchIndex}: ${batch.subtasks.length}ファイルを並列実装中...\n${parallelPaths}`);
          emitDevEvent({ type: 'batch_start', convId: conv.id, agent: 'engineer', data: { batchIndex: batch.batchIndex, count: batch.subtasks.length, files: parallelPaths } });

          // Promise.allSettledで並列実行（1つ失敗しても他は続行）
          // 並列バッチではビルドスキップ（バッチ完了後に一括ビルド）
          const results = await Promise.allSettled(
            batch.subtasks.map(subtask =>
              this.engineerAndReview(conv, subtask, subtasks, completedFiles, true)
            )
          );

          const succeeded: FileToWrite[] = [];
          const failed: Array<{ subtask: Subtask; error: string }> = [];

          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const subtask = batch.subtasks[j];
            if (result.status === 'fulfilled') {
              succeeded.push(result.value.file);
              dbLog('info', 'dev-agent', `[バッチ${batch.batchIndex}] ✅ ${subtask.path}`, { convId: conv.id });
            } else {
              const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
              failed.push({ subtask, error: errMsg });
              dbLog('error', 'dev-agent', `[バッチ${batch.batchIndex}] ❌ ${subtask.path}: ${errMsg.slice(0, 200)}`, { convId: conv.id });
            }
          }

          // 成功分を記録・コミット
          for (const file of succeeded) {
            allFiles.push(file);
            completedFiles.push({ path: file.path, content: file.content });
          }
          if (succeeded.length > 0) {
            const commitResult = await commitAndStay(
              branchName,
              `feat: batch${batch.batchIndex} - ${succeeded.map(f => f.path.split('/').pop()).join(', ')}`
            );
            if (!commitResult.success) {
              throw new Error(`バッチコミット失敗: ${commitResult.error}`);
            }
          }

          await touchConversation(conv.id);
          emitDevEvent({ type: 'batch_complete', convId: conv.id, agent: 'engineer', data: { batchIndex: batch.batchIndex, succeeded: succeeded.length, failed: failed.length } });
          await sendLineMessage(conv.user_id,
            `バッチ${batch.batchIndex} 完了: ✅${succeeded.length} ${failed.length > 0 ? `❌${failed.length}` : ''}\n全体進捗: ${completedFiles.length}/${subtasks.length}`
          );

          // 失敗があった場合 → stuckモードに移行
          if (failed.length > 0) {
            const firstFail = failed[0];
            const failIdx = subtasks.findIndex(s => s.index === firstFail.subtask.index);

            this.stuckContextMap.set(conv.id, {
              branchName, subtasks, completedFiles: [...completedFiles],
              failedSubtaskIndex: failIdx >= 0 ? failIdx : 0,
              errorMessage: `バッチ${batch.batchIndex}で${failed.length}件失敗:\n${failed.map(f => `- ${f.subtask.path}: ${f.error.slice(0, 100)}`).join('\n')}`,
              phase: 'implementing',
              triedActions: [`バッチ${batch.batchIndex}の並列実行で${failed.length}件失敗`],
              dialogueLog: [],
            });
            await updateConversationStatus(conv.id, 'stuck');
            emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'stuck', reason: `バッチ${batch.batchIndex}で${failed.length}件失敗` } });
            if (gitLockAcquired) { releaseGitLock(conv.id); gitLockAcquired = false; }

            const stuckUrl2 = `${config.admin.baseUrl}/admin/dev/${conv.id}`;
            await sendLineMessage(conv.user_id,
              `⚠️ バッチ${batch.batchIndex}で${failed.length}件失敗\n\n` +
              `成功（コミット済み）:\n${succeeded.map(f => `✅ ${f.path}`).join('\n')}\n\n` +
              `失敗:\n${failed.map(f => `❌ ${f.subtask.path}: ${f.error.slice(0, 100)}`).join('\n')}\n\n` +
              `「リトライ」で失敗分を再実行、「スキップ」で次へ、「中止」で終了\n\n` +
              `詳細: ${stuckUrl2}`
            );
            return; // stuckで一旦停止
          }
        }
      }

      await setGeneratedFiles(conv.id, [...new Set(completedFiles.map(f => f.path))]);

      // ビルド → デプロイ
      await updateConversationStatus(conv.id, 'testing');
      dbLog('info', 'dev-agent', '[チーム] 全サブタスク完了 → ビルド開始', { convId: conv.id });
      emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'testing' } });
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
          triedActions: [`${completedFiles.length}ファイルまで実装完了後にエラー発生`],
          dialogueLog: [],
        });
        await updateConversationStatus(conv.id, 'stuck');

        const stuckUrl2 = `${config.admin.baseUrl}/admin/dev/${conv.id}`;
        const { category: errCat2, explanation: errExp2 } = classifyStuckError(errMsg, 'implementing');
        await sendLineMessage(conv.user_id,
          `📋 PMからの報告\n\n` +
          `■ 状況: 実装フェーズで予期しないエラーが発生\n` +
          `■ 進捗: ${completedFiles.length}/${subtasks.length} ファイル完了（ブランチ ${branchName} に保存済み）\n` +
          `■ エラー種別: ${errCat2}\n` +
          `■ 原因: ${errExp2}\n\n` +
          `完了分のコードは安全に保存されています。\n方針を一緒に決めましょう。質問も歓迎です。\n\n` +
          `詳細: ${stuckUrl2}`
        ).catch(() => {});
      } else {
        // 何も進んでいない場合はロールバック
        if (branchName) {
          await rollbackGit(branchName).catch(() => {});
        }
        await updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `実装中にエラーが発生しました:\n${errMsg.slice(0, 400)}\n\n` +
          `コードをロールバックしました。新しい依頼を送ってリトライできます。`
        ).catch(() => {});

        // C: 失敗時もレトロスペクティブを実行（学習蓄積のため）
        const failedConv = await getConversation(conv.id);
        if (failedConv) {
          import('./retrospective').then(({ runRetrospective }) =>
            runRetrospective(failedConv).catch(() => {})
          ).catch(() => {});
        }
      }
    } finally {
      if (gitLockAcquired) releaseGitLock(conv.id);
    }
  }

  private async handleStuck(conv: DevConversation, userReply: string): Promise<void> {
    // 二重実行防止
    if (this.resumingSet.has(conv.id)) {
      await sendLineMessage(conv.user_id, '再試行を処理中です。完了までお待ちください。');
      return;
    }

    const ctx = this.stuckContextMap.get(conv.id);
    if (!ctx) {
      await sendLineMessage(conv.user_id, 'スタック情報が失われました。新しい開発依頼を送ってください。');
      await updateConversationStatus(conv.id, 'failed');
      return;
    }

    // 対話ログにユーザー発言を記録
    if (!ctx.dialogueLog) ctx.dialogueLog = [];
    ctx.dialogueLog.push({ role: 'user', message: userReply });

    const normalizedReply = userReply.trim().toLowerCase();

    // 明確な中止コマンドのみ即時実行
    if (/^(中止|キャンセル|やめ)/.test(normalizedReply)) {
      dbLog('info', 'dev-agent', '[stuck] ユーザーが中止を選択', { convId: conv.id });
      this.stuckContextMap.delete(conv.id);
      await updateConversationStatus(conv.id, 'failed');
      const branchMsg = ctx.branchName ? `\n完了済みファイルはブランチ ${ctx.branchName} に残っています。` : '';
      await sendLineMessage(conv.user_id, `承知しました。開発を中止します。${branchMsg}`);
      return;
    }

    // 対話回数が上限に達した場合、強制的にアクション選択を促す
    const dialogueCount = (ctx.dialogueLog || []).filter(e => e.role === 'user').length;
    if (dialogueCount >= MAX_STUCK_DIALOGUE) {
      dbLog('warn', 'dev-agent', `[stuck] 対話上限到達(${MAX_STUCK_DIALOGUE}回) → 強制アクション選択`, { convId: conv.id });
      await sendLineMessage(conv.user_id,
        `対話が${MAX_STUCK_DIALOGUE}回に達しました。以下から選択してください:\n\n` +
        `・「リトライ」→ 再試行\n・「スキップ」→ 失敗したサブタスクを飛ばす\n・「中止」→ 開発を中止`
      );
      return;
    }

    // PMが対話を通じて状況を分析し、アクションを提案 or 実行
    await this.pmDialogue(conv, ctx, userReply);
  }

  /** PMがユーザーと対話して合意形成した上でアクションを決定する */
  private async pmDialogue(conv: DevConversation, ctx: StuckContext, userReply: string): Promise<void> {
    const dialogueHistory = (ctx.dialogueLog || [])
      .map(e => `${e.role === 'user' ? 'Daiki' : 'PM'}: ${e.message}`)
      .join('\n');

    // エラーを分類して人間向けの説明を生成
    const { category: errCategory, explanation: errExplanation } = classifyStuckError(ctx.errorMessage, ctx.phase);

    const situationSummary = [
      `フェーズ: ${ctx.phase}`,
      `エラー分類: ${errCategory}`,
      `原因の説明: ${errExplanation}`,
      `エラー詳細: ${ctx.errorMessage.slice(0, 300)}`,
      ctx.triedActions?.length ? `試行済み: ${ctx.triedActions.join('、')}` : '',
      ctx.teamDiagnosis ? `チーム診断: ${ctx.teamDiagnosis}` : '',
      ctx.subtasks.length > 0 ? `サブタスク: ${ctx.failedSubtaskIndex + 1}/${ctx.subtasks.length} (${ctx.subtasks[ctx.failedSubtaskIndex]?.path || '不明'})` : '',
      ctx.completedFiles.length > 0 ? `完了済み: ${ctx.completedFiles.length}ファイル` : '',
      ctx.branchName ? `ブランチ: ${ctx.branchName}` : '',
    ].filter(Boolean).join('\n');

    const availableActions = ctx.phase === 'build' || ctx.phase === 'test'
      ? '・retry: ビルド/テストを再試行\n・retry_with_hint: ユーザーのヒントを元に修正して再試行\n・cancel: 開発中止'
      : '・retry: 失敗したサブタスクを再試行\n・retry_with_hint: ユーザーのヒントを元に修正して再試行\n・skip: このサブタスクをスキップして次へ\n・cancel: 開発中止';

    const { text: pmResponse } = await callClaude({
      system: await buildAgentPersonality('pm') + `\n\n` +
        `あなたはPMとして、開発で詰まった状況についてDaiki（ユーザー）と対話しています。\n` +
        `目標: Daikiと合意を形成してから作業に戻ること。1回のやり取りで判断を急がない。\n\n` +
        `## 行動ルール\n` +
        `1. Daikiの発言を理解し、質問があれば答え、必要なら追加の質問をする\n` +
        `2. 状況を正確に伝える。曖昧にしない。何を試して何がダメだったかを明示する\n` +
        `3. アクションを実行する場合は、必ずDaikiの明確な同意を得てから\n` +
        `4. Daikiが「いいよ」「お願い」「それで」等の同意を示した場合のみアクションを実行\n` +
        `5. 判断に必要な情報が足りなければ聞く。推測で動かない\n\n` +
        `## 出力形式\n` +
        `JSON形式で出力:\n` +
        `対話を続ける場合: {"action":"dialogue","message":"PMとしてのメッセージ"}\n` +
        `アクションを提案する場合: {"action":"propose","proposed_action":"retry|retry_with_hint|skip|cancel","message":"提案の説明"}\n` +
        `合意が得られてアクションを実行する場合: {"action":"execute","execute_action":"retry|retry_with_hint|skip|cancel","hint":"追加指示（あれば）","message":"実行前の確認メッセージ"}\n\n` +
        `利用可能なアクション:\n${availableActions}`,
      messages: [{
        role: 'user',
        content: `## 現在の状況\n${situationSummary}\n\n` +
          `## これまでの対話\n${dialogueHistory || '（初回）'}\n\n` +
          `## Daikiの最新メッセージ\n${userReply}`,
      }],
      model: 'default',
      maxTokens: 500,
    });

    const parsed = safeParseJson(pmResponse);
    if (!parsed) {
      // パース失敗時はPMの応答をそのまま返す
      ctx.dialogueLog!.push({ role: 'pm', message: pmResponse });
      await sendLineMessage(conv.user_id, pmResponse);
      return;
    }

    const pmMessage = parsed.message || pmResponse;
    ctx.dialogueLog!.push({ role: 'pm', message: pmMessage });
    await saveTeamConversation('pm_stuck_dialogue', ['pm', 'user'], [
      { role: 'user', message: userReply, timestamp: new Date().toISOString() },
      { role: 'pm', message: pmMessage, timestamp: new Date().toISOString() },
    ], conv.id, `stuck対話: ${parsed.action}`);

    switch (parsed.action) {
      case 'dialogue':
      case 'propose': {
        // 対話 or 提案 → メッセージを送って待機（stuckのまま）
        if (parsed.proposed_action) {
          ctx.proposedAction = parsed.proposed_action;
          ctx.awaitingConfirmation = true;
        }
        await sendLineMessage(conv.user_id, pmMessage);
        break;
      }
      case 'execute': {
        // 合意が得られた → アクションを実行
        const action = parsed.execute_action || ctx.proposedAction || 'retry';
        const hint = parsed.hint || '';
        await sendLineMessage(conv.user_id, pmMessage);
        await this.executeStuckAction(conv, ctx, action, hint);
        break;
      }
      default: {
        // 不明なアクション → 対話として扱う
        await sendLineMessage(conv.user_id, pmMessage);
        break;
      }
    }
  }

  /**
   * レビュー差し戻し2回目でPMが介入し、レビュー指摘を分析して
   * エンジニアへの追加指示を生成する
   */
  private async pmReviewIntervention(
    conv: DevConversation,
    subtask: Subtask,
    reviewFeedback: string,
  ): Promise<string | null> {
    try {
      const { text: pmAdvice } = await callClaude({
        system: await buildAgentPersonality('pm') +
          '\n\nレビュアーが同じ指摘を繰り返しています。あなたはPMとして、状況を判断してください。' +
          '\n\n## 判断基準' +
          '\n- チーム内で解決可能 → エンジニアに具体的な修正指示を出す（テキストで回答）' +
          '\n- 仕様が曖昧・方針判断が必要 → 「ESCALATE:」で始めてユーザーに確認すべき内容を書く' +
          '\n\n## 修正指示を出す場合のルール' +
          '\n- レビュアーの指摘を分析し、根本原因を特定する' +
          '\n- エンジニアが「何をどう変えればいいか」が明確に分かる指示を出す' +
          '\n- ファイルパスや関数名など、具体的な情報を含める' +
          '\n- プロジェクトのコーディング規約（config.ts経由の環境変数、認証ミドルウェア等）を踏まえる',
        messages: [{
          role: 'user',
          content: `サブタスク: ${subtask.path} - ${subtask.description}\n\n` +
            `レビュアーの指摘（2回差し戻し済み）:\n${reviewFeedback}\n\n` +
            `エンジニアが同じミスを繰り返しています。根本原因を分析し、チーム内で解決可能か判断してください。`,
        }],
        model: 'default',
        maxTokens: 500,
      });

      // PMがエスカレーションを判断した場合
      if (pmAdvice.includes('ESCALATE:')) {
        const escalateReason = pmAdvice.replace(/^[\s\S]*?ESCALATE:\s*/, '').slice(0, 500);
        dbLog('info', 'dev-agent', `[PM介入] エスカレーション判断: ${escalateReason.slice(0, 100)}`, { convId: conv.id });
        emitDevEvent({ type: 'escalation', convId: conv.id, agent: 'pm', data: { reason: 'pm_intervention', file: subtask.path } });
        throw new EscalationError(
          `PM判断: ${subtask.path} のレビュー差し戻しについて、ユーザー確認が必要\n\n` +
          `理由: ${escalateReason}\n差し戻し内容: ${reviewFeedback.slice(0, 200)}`
        );
      }

      dbLog('info', 'dev-agent', `[PM介入] レビュー分析完了: ${pmAdvice.slice(0, 100)}`, { convId: conv.id });
      await saveTeamConversation('pm_review_intervention', ['pm', 'reviewer', 'engineer'], [
        { role: 'reviewer', message: `差し戻しが繰り返されている: ${reviewFeedback.slice(0, 200)}`, timestamp: new Date().toISOString() },
        { role: 'pm', message: pmAdvice, timestamp: new Date().toISOString() },
      ], conv.id, `PM介入: ${subtask.path}`);
      await sendLineMessage(conv.user_id, `🔍 PM介入: 同じ指摘が繰り返されたため、PMがレビュー内容を分析してエンジニアに追加指示を出しました。`);
      return pmAdvice;
    } catch (err) {
      if (err instanceof EscalationError) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('warn', 'dev-agent', `[PM介入] 分析失敗: ${errMsg.slice(0, 100)}`, { convId: conv.id });
      return null;
    }
  }

  /** stuck状態からの具体的なアクション実行 */
  private async executeStuckAction(
    conv: DevConversation, ctx: StuckContext, action: string, hint: string
  ): Promise<void> {
    dbLog('info', 'dev-agent', `[stuck] アクション実行: ${action} (hint: ${hint.slice(0, 50)})`, { convId: conv.id });

    if (action === 'cancel') {
      this.stuckContextMap.delete(conv.id);
      await updateConversationStatus(conv.id, 'failed');
      const branchMsg = ctx.branchName ? `\n完了済みファイルはブランチ ${ctx.branchName} に残っています。` : '';
      await sendLineMessage(conv.user_id, `承知しました。開発を中止します。${branchMsg}`);
      return;
    }

    // build/testフェーズ
    if (ctx.phase === 'build' || ctx.phase === 'test') {
      if (action === 'skip') {
        await sendLineMessage(conv.user_id, 'ビルド/テストフェーズではスキップできません。リトライまたは中止を選んでください。');
        return;
      }
      this.stuckContextMap.delete(conv.id);
      this.resumingSet.add(conv.id);
      // ヒントがある場合はエラーメッセージに追記してautoFixに渡す
      if (hint) ctx.errorMessage += `\n\nDaikiからの追加情報: ${hint}`;
      this.resumeBuildTest(conv, ctx).catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `[チーム] ${ctx.phase}再試行失敗: ${errMsg}`, { convId: conv.id });
        await updateConversationStatus(conv.id, 'failed');
        sendLineMessage(conv.user_id, `再試行中にエラーが発生しました:\n${errMsg.slice(0, 300)}`).catch(() => {});
      }).finally(() => this.resumingSet.delete(conv.id));
      return;
    }

    // implementingフェーズ
    if (action === 'skip') {
      dbLog('info', 'dev-agent', `[stuck] サブタスク ${ctx.failedSubtaskIndex + 1} をスキップ`, { convId: conv.id });
      this.stuckContextMap.delete(conv.id);
      this.resumingSet.add(conv.id);
      this.runImplementation(conv, {
        branchName: ctx.branchName,
        subtasks: ctx.subtasks,
        completedFiles: ctx.completedFiles,
        startIndex: ctx.failedSubtaskIndex + 1,
      }).catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `[チーム] 再開エラー: ${errMsg}`, { convId: conv.id });
        await updateConversationStatus(conv.id, 'failed');
        sendLineMessage(conv.user_id, `再開中にエラー:\n${errMsg.slice(0, 300)}`).catch(() => {});
      }).finally(() => this.resumingSet.delete(conv.id));
      return;
    }

    // retry or retry_with_hint
    const failedSubtask = ctx.subtasks[ctx.failedSubtaskIndex];
    if (failedSubtask && hint) {
      failedSubtask.description += `\n\nDaikiからの追加指示: ${hint}`;
    }

    this.stuckContextMap.delete(conv.id);
    this.resumingSet.add(conv.id);
    this.runImplementation(conv, {
      branchName: ctx.branchName,
      subtasks: ctx.subtasks,
      completedFiles: ctx.completedFiles,
      startIndex: ctx.failedSubtaskIndex,
    }).catch(async (err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[チーム] リトライエラー: ${errMsg}`, { convId: conv.id });
      await updateConversationStatus(conv.id, 'failed');
      sendLineMessage(conv.user_id, `リトライ中にエラー:\n${errMsg.slice(0, 300)}`).catch(() => {});
    }).finally(() => this.resumingSet.delete(conv.id));
  }

  /** build/testフェーズからの復帰（Gitロック管理付き） */
  private async resumeBuildTest(conv: DevConversation, ctx: StuckContext): Promise<void> {
    let gitLockAcquired = false;
    try {
      gitLockAcquired = await acquireGitLock(conv.id, 60_000);
      if (!gitLockAcquired) throw new Error('Gitロック取得失敗');
      await updateConversationStatus(conv.id, 'testing');
      const phaseName = ctx.phase === 'build' ? 'ビルド' : 'テスト';
      await sendLineMessage(conv.user_id, `🔄 ${phaseName}から再試行中...`);
      await this.runBuildAndDeploy(conv, ctx.lastFiles || [], 0, ctx.branchName);
    } finally {
      if (gitLockAcquired) releaseGitLock(conv.id);
    }
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
        model: 'default',
      });

      const parsed = safeParseJson(text);
      if (parsed && parsed.subtasks && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0) {
        // ACを保存（後でエンジニア/レビュアーに渡す）
        if (parsed.acceptance_criteria && Array.isArray(parsed.acceptance_criteria)) {
          this.currentAC = parsed.acceptance_criteria as string[];
        }
        // depends_on/difficultyがない場合のデフォルト設定
        return (parsed.subtasks as Subtask[]).map(s => ({
          ...s,
          depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
          difficulty: (['simple', 'moderate', 'complex'].includes(s.difficulty) ? s.difficulty : 'moderate') as Subtask['difficulty'],
        }));
      }

      dbLog('warn', 'dev-agent', `[PM] サブタスク分解パース失敗 (${attempt}/${MAX_DECOMPOSE_RETRIES}): ${text.slice(0, 200)}`, { convId: conv.id });
    }

    throw new Error(`PM: サブタスク分解のパースに${MAX_DECOMPOSE_RETRIES}回失敗しました`);
  }

  // ========================================
  // エンジニア + レビュアー ループ
  // ========================================

  /** サブタスクの難易度に応じてCLIモデルを選択 */
  private selectModel(subtask: Subtask): 'sonnet' | 'opus' {
    if (subtask.difficulty === 'complex') return 'opus';
    return 'sonnet';
  }

  private async engineerAndReview(
    conv: DevConversation,
    subtask: Subtask,
    allSubtasks: Subtask[],
    completedFiles: Array<{ path: string; content: string }>,
    skipBuild: boolean = false,
  ): Promise<{ file: FileToWrite; model: 'sonnet' | 'opus' }> {

    let model = this.selectModel(subtask);
    let reviewRetry = 0;
    let redefineAttempts = 0; // PMサブタスク再定義の試行回数（無限ループ防止）
    let reviewFeedback = '';
    let previousRejectReason = ''; // 同一理由差し戻し検出用

    // A: レビュアー用にシステム基盤ファイルを事前読み込み（コンテキスト不足防止）
    const systemFiles: Array<{ path: string; content: string }> = [];
    for (const sysPath of SYSTEM_REFERENCE_FILES) {
      // サブタスク対象ファイルや完了済みファイルと重複しない場合のみ
      if (sysPath !== subtask.path && !completedFiles.some(f => f.path === sysPath)) {
        const sysContent = await readProjectFile(sysPath);
        if (sysContent) {
          systemFiles.push({ path: sysPath, content: sysContent });
        }
      }
    }

    // エンジニアの過去学習・パターン記憶を事前取得（ERL式ナラティブ注入）
    let engineerMemoryCtx = '';
    try {
      engineerMemoryCtx = await buildAgentMemoryContext('engineer', subtask.description);
    } catch {
      dbLog('warn', 'dev-agent', `[エンジニア] 記憶コンテキスト取得失敗`, { convId: conv.id });
    }

    while (reviewRetry <= MAX_REVIEW_RETRIES) {
      // --- エンジニア（Claude CLI） ---
      const cliPrompt = await this.buildCLIPrompt(conv, subtask, allSubtasks, completedFiles, reviewFeedback, skipBuild, engineerMemoryCtx);

      dbLog('info', 'dev-agent', `[エンジニア/CLI] コード生成開始 (レビュー試行 ${reviewRetry + 1}) [${model}]`, { convId: conv.id, path: subtask.path });
      emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'engineer', data: { status: 'coding', message: `コーディング中: ${subtask.path} [${model}]`, file: subtask.path } });

      const cliResult = await runClaudeCLI(cliPrompt, model);

      if (!cliResult.success) {
        throw new Error(`CLI実行失敗: ${cliResult.output.slice(-300)}`);
      }

      dbLog('info', 'dev-agent', `[エンジニア/CLI] コード生成完了`, { convId: conv.id, path: subtask.path });

      // エンジニアがPMに相談したい場合の検出（CLI出力にconsultが含まれるか）
      const consultMatch = cliResult.output.match(/"consult"\s*:\s*\{[^}]*"question"\s*:\s*"([^"]+)"/);
      if (consultMatch) {
        dbLog('info', 'dev-agent', `[エンジニア→PM] 相談検出: ${consultMatch[1].slice(0, 100)}`, { convId: conv.id });
        const pmAnswer = await handleConsult('engineer', consultMatch[1], undefined, undefined, subtask.description);
        reviewFeedback += `\n\n## PMからの回答\n${pmAnswer}`;
        dbLog('info', 'dev-agent', `[PM→エンジニア] 回答: ${pmAnswer.slice(0, 100)}`, { convId: conv.id });
      }

      emitDevEvent({ type: 'code_write', convId: conv.id, agent: 'engineer', data: { file: subtask.path, action: subtask.action } });

      // --- MIRROR Self-Check（Goals/Reasoning/Memory の3次元自己レビュー） ---
      if (reviewRetry === 0) {
        // 初回のみ実行（リトライ時はレビュアーFBがあるので不要）
        dbLog('info', 'dev-agent', `[エンジニア] MIRROR self-check実行中`, { convId: conv.id });
        emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'engineer', data: { status: 'thinking', message: `自己レビュー中: ${subtask.path}` } });
        const selfCheckPrompt = `あなたは実装を完了したエンジニアとして、提出前の自己レビューを行います。

## Goals（このサブタスクのゴール）
${subtask.description}

## Memory（過去の失敗パターン — 必ず確認）
${engineerMemoryCtx || '（過去の記録なし）'}

## チェック項目（1つでも該当すれば修正してください）
1. 新しいRouterを作成した場合、dashboard.ts/app.tsへのuse()登録は済んでいるか？
2. 新しいページなら、views.tsのナビゲーションリンクは追加したか？
3. importパスは実在するファイルを指しているか？
4. export名が既存のものと衝突していないか？
5. 過去の失敗パターンに該当していないか？

問題があれば修正してください。問題がなければ「SELF-CHECK PASSED」と出力してください。`;
        try {
          await runClaudeCLI(selfCheckPrompt, 'sonnet', 60_000);
        } catch {
          dbLog('warn', 'dev-agent', `[エンジニア] self-check失敗（続行）`, { convId: conv.id });
        }
      }

      // CLIが書いたファイルの内容を読み取り（self-check後の最新版）
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
      emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'reviewer', data: { status: 'reviewing', message: `レビュー中: ${subtask.path}`, file: subtask.path } });

      // A: システム基盤ファイルを含むレビューコンテキストを構築
      const reviewContext = await this.buildReviewContext(subtask, fileToWrite, completedFiles, systemFiles, allSubtasks);

      const { text: reviewOutput } = await callClaude({
        system: await buildAgentPersonality('reviewer') + '\n\n' + REVIEWER_PROMPT,
        messages: [{ role: 'user', content: reviewContext }],
        model: 'default',
      });

      let reviewParsed = safeParseJson(reviewOutput);

      // F2: パース失敗時、レビュアーに再度JSON変換を依頼（1回のみ）
      if (!reviewParsed) {
        dbLog('warn', 'dev-agent', `[レビュアー] 初回パース失敗 → JSON変換リクエスト`, { convId: conv.id });
        try {
          const { text: retryJson } = await callClaude({
            system: '以下のレビュー結果をJSON形式に変換してください。JSONオブジェクトのみを出力し、他のテキストは一切不要です。\n形式: {"approved": true/false, "issues": [{"severity": "error"|"warning", "message": "内容", "fix": "修正方法"}], "summary": "要約"}',
            messages: [{ role: 'user', content: reviewOutput }],
            model: 'default',
            maxTokens: 1000,
          });
          reviewParsed = safeParseJson(retryJson);
          if (reviewParsed) {
            dbLog('info', 'dev-agent', `[レビュアー] JSON変換成功`, { convId: conv.id });
          }
        } catch (retryErr) {
          dbLog('warn', 'dev-agent', `[レビュアー] JSON変換リクエスト失敗`, { convId: conv.id });
        }
      }

      // パース成功 & 承認 → 通過
      if (reviewParsed && reviewParsed.approved) {
        dbLog('info', 'dev-agent', `[レビュアー] 承認: ${subtask.path} - ${reviewParsed.summary} [${model}]`, { convId: conv.id });
        emitDevEvent({ type: 'agent_message', convId: conv.id, agent: 'reviewer', data: { message: `承認: ${subtask.path}`, verdict: 'approved' } });
        await saveTeamConversation('review_approve', ['reviewer', 'engineer'], [
          { role: 'engineer', message: `実装完了: ${subtask.path} (${model})`, timestamp: new Date().toISOString() },
          { role: 'reviewer', message: `承認: ${reviewParsed.summary || 'OK'}`, timestamp: new Date().toISOString() },
        ], conv.id, `承認: ${subtask.path}`);
        return { file: fileToWrite, model };
      }

      // パース失敗 or レビューNG → 差し戻し
      reviewRetry++;
      let currentRejectReason = '';

      if (!reviewParsed) {
        dbLog('warn', 'dev-agent', `[レビュアー] レビュー結果パース失敗 → 差し戻し扱い (${reviewRetry}/${MAX_REVIEW_RETRIES})`, { convId: conv.id });
        currentRejectReason = reviewOutput.slice(0, 500);
        reviewFeedback = `レビュアーの応答（JSON解析不可）:\n${currentRejectReason}`;
        await recordMetric(conv.id, 'reviewer', 'review_reject');
        await recordReject('reviewer', 'engineer', 'レビュー結果パース失敗',
          reviewFeedback.slice(0, 300), 'major', false, conv.id);
      } else {
        await recordMetric(conv.id, 'reviewer', 'review_reject');
        const issues = (reviewParsed.issues || []) as Array<{ severity: string; message: string; fix: string }>;
        currentRejectReason = (reviewParsed.summary || '') + ' ' + issues.map(i => i.message).join(' ');
        reviewFeedback = issues.map(i => `[${i.severity}] ${i.message}\n修正: ${i.fix}`).join('\n\n');
        await recordReject('reviewer', 'engineer', reviewParsed.summary || 'レビューNG',
          reviewFeedback.slice(0, 300), 'major',
          reviewRetry >= 2, conv.id);
        await recordRejectLearning('engineer', reviewParsed.summary || 'レビューNG', reviewFeedback.slice(0, 200), subtask.path);
        for (const issue of issues.filter(i => i.severity === 'error')) {
          await recordReviewerLearning(issue.message, issue.severity, subtask.path);
        }
        dbLog('warn', 'dev-agent', `[レビュアー] NG → エンジニアに差し戻し (${reviewRetry}/${MAX_REVIEW_RETRIES}): ${reviewParsed.summary}`, { convId: conv.id });
        emitDevEvent({ type: 'agent_message', convId: conv.id, agent: 'reviewer', data: { message: `差し戻し: ${(reviewParsed.summary || '').slice(0, 60)}`, verdict: 'rejected', file: subtask.path } });
      }

      // B: 同一理由の差し戻し検出 → PMサブタスク再定義を試みる（合議より迅速）
      if (previousRejectReason && isSimilarReject(previousRejectReason, currentRejectReason)) {
        // 再定義は1回まで。2回目以降はエスカレーション
        if (redefineAttempts >= 1) {
          dbLog('warn', 'dev-agent', `[PM] 再定義後も差し戻し継続 → エスカレーション`, { convId: conv.id });
          emitDevEvent({ type: 'escalation', convId: conv.id, agent: 'pm', data: { reason: 'redefine_exhausted', file: subtask.path } });
          throw new EscalationError(
            `PMのサブタスク再定義後も同じ理由で差し戻しが続いています（${subtask.path}）。\n` +
            `差し戻し理由: ${currentRejectReason.slice(0, 300)}\n\n` +
            `要件の根本的な見直しが必要です。`
          );
        }
        redefineAttempts++;
        dbLog('info', 'dev-agent', `[PM] 同一差し戻し検出 → サブタスク再定義を試みる (${redefineAttempts}回目)`, { convId: conv.id, file: subtask.path });
        emitDevEvent({ type: 'agent_message', convId: conv.id, agent: 'pm', data: { message: '同一差し戻し検出 → PMがサブタスクを再定義' } });
        try {
          // PMに拡張思考付きでサブタスク再定義を依頼
          const { text: redefineResult } = await callClaude({
            system: DEV_SYSTEM_PROMPT + '\n\nあなたはPMです。レビュアーの繰り返し差し戻しの根本原因を分析し、サブタスクの説明を修正してください。',
            messages: [{
              role: 'user',
              content: `## 問題
レビュアーが同じ理由で${reviewRetry}回差し戻しています。

## 差し戻し理由
${currentRejectReason.slice(0, 500)}

## 現在のサブタスク定義
ファイル: ${subtask.path}
説明: ${subtask.description}
アクション: ${subtask.action}

## 指示
差し戻し理由を解消するために、サブタスクの説明を修正してください。
特に「どのファイルにどんな変更が必要か」を具体的に明記してください。
修正後の説明文のみを出力してください（JSON不要、テキストのみ）。`,
            }],
            model: 'default',
            enableThinking: true,
            thinkingBudget: 3000,
          });

          // サブタスクの説明を更新
          subtask.description = redefineResult.trim();
          reviewFeedback = `## PMによるサブタスク再定義\n差し戻し理由「${currentRejectReason.slice(0, 100)}」を踏まえ、以下に修正:\n${subtask.description}`;
          dbLog('info', 'dev-agent', `[PM] サブタスク再定義完了: ${subtask.description.slice(0, 100)}`, { convId: conv.id });
        } catch (redefineErr) {
          // 再定義失敗 → エスカレーション
          dbLog('warn', 'dev-agent', `[PM] サブタスク再定義失敗 → エスカレーション`, { convId: conv.id });
          emitDevEvent({ type: 'escalation', convId: conv.id, agent: 'pm', data: { reason: 'redefine_failed', file: subtask.path } });
          throw new EscalationError(
            `レビュー差し戻しの繰り返し（${subtask.path}）でPMのサブタスク再定義も失敗\n\n` +
            `差し戻し理由: ${currentRejectReason.slice(0, 300)}\n` +
            `PMの判断: ユーザーに方針を確認する必要があります。`
          );
        }
      } else if (reviewRetry === 2) {
        // 異なる理由の2回目差し戻し → PM介入（従来動作）
        dbLog('info', 'dev-agent', `[PM介入] 差し戻し2回目 → PMがレビュー指摘を分析`, { convId: conv.id });
        const pmAdvice = await this.pmReviewIntervention(conv, subtask, reviewFeedback);
        if (pmAdvice) {
          reviewFeedback += `\n\n## PMからの指示\n${pmAdvice}`;
        }
      }
      previousRejectReason = currentRejectReason;

      // Sonnetで2回連続失敗 → Opusにエスカレート
      if (reviewRetry >= 2 && model === 'sonnet') {
        model = 'opus';
        dbLog('info', 'dev-agent', `[エンジニア] Sonnetで2回失敗 → Opusにエスカレート: ${subtask.path}`, { convId: conv.id });
        emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'engineer', data: { status: 'thinking', message: `Opusにアップグレード: ${subtask.path}` } });
      }

      if (reviewRetry > MAX_REVIEW_RETRIES) {
        dbLog('warn', 'dev-agent', `[レビュアー] 最大リトライ到達 → エスカレーション`, { convId: conv.id });
        emitDevEvent({ type: 'escalation', convId: conv.id, agent: 'pm', data: { reason: 'max_review_retries', file: subtask.path } });
        throw new EscalationError(
          `${subtask.path} のレビューが${MAX_REVIEW_RETRIES}回差し戻されても解決できません。\n` +
          `最新の差し戻し理由: ${currentRejectReason.slice(0, 300)}\n\n` +
          `PMの判断: ユーザーに方針を確認する必要があります。`
        );
      }
    }

    throw new Error(`レビューループ異常終了: ${subtask.path}`);
  }

  private async buildCLIPrompt(
    conv: DevConversation,
    subtask: Subtask,
    _allSubtasks: Subtask[],
    completedFiles: Array<{ path: string; content: string }>,
    reviewFeedback: string,
    skipBuild: boolean = false,
    engineerMemory: string = '',
  ): Promise<string> {
    const acSection = this.currentAC.length > 0
      ? `\n## 受け入れ条件（AC）— 全サブタスクの最終ゴール\n${this.currentAC.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}\nあなたのサブタスクがこのACの達成に必要な部分を確実に実装してください。\n`
      : '';

    // エンジニアの過去学習（パターン記憶+関連経験）をナラティブ形式で注入
    const memorySection = engineerMemory
      ? `\n## 過去の経験から学んだこと（必ず確認してから実装を開始すること）\n${engineerMemory}\n`
      : '';

    let prompt = `CLAUDE.md を読んでから、以下のサブタスクを実装してください。
${memorySection}
## サブタスク
- ファイル: ${subtask.path}
- 内容: ${subtask.description}
- アクション: ${subtask.action}
${acSection}
## 全体の要件定義
${conv.requirements}
`;

    // 手続き記憶: 類似タスクの成功手順を注入（Phase 1）
    const proceduralCtx = await findRelevantProcedures(`${subtask.description} ${subtask.path}`);
    if (proceduralCtx) {
      prompt += `\n${proceduralCtx}\n`;
    }

    // ナレッジグラフ: 類似過去開発の経験を注入（Phase 4.5）
    try {
      const { findSimilarDeployExperiences } = await import('./knowledgeGraph');
      const graphCtx = await findSimilarDeployExperiences(subtask.description);
      if (graphCtx) prompt += `\n${graphCtx}\n`;
    } catch { /* graph not populated yet */ }

    // 過去開発で同じファイルを触った実績があれば参照情報として注入
    const relatedDev = await buildRelatedDevContext(subtask.path);
    if (relatedDev) {
      prompt += `\n${relatedDev}\n`;
    }

    if (completedFiles.length > 0) {
      prompt += `\n## 完了済みファイル（参照用）\n`;
      for (const f of completedFiles) {
        prompt += `- ${f.path}\n`;
      }
    }

    if (reviewFeedback) {
      prompt += `\n## レビュアーからのフィードバック（必ず反映すること）\n${reviewFeedback}\n`;
    }

    // 全サブタスクの概要を注入（共有コンテキスト — 自分のタスクの位置を把握）
    const taskOverview = _allSubtasks
      .map(s => `${s.index}. [${s.action}] ${s.path}: ${s.description.slice(0, 80)}${s.index === subtask.index ? ' ← 今回のタスク' : ''}`)
      .join('\n');
    prompt += `\n## 全サブタスクの概要（あなたのタスクは${subtask.index}番）\n${taskOverview}\n`;
    prompt += `※ 他のサブタスクの内容を把握した上で、必要な連携（import先の確認等）を行ってください。\n`;

    prompt += `\n## 指示
- 主な変更対象は ${subtask.path} です
- このファイルが正しく動作するために、他ファイルへの以下の変更のみ許可します:
  - import追加/修正（新しいimportのみ。既存ファイルの再編成は不可）
  - use()登録（dashboard.ts/app.tsへの1-2行追加のみ）
  - ナビゲーションリンク追加（views.tsへの1-2行追加のみ）
- ${subtask.path}以外のファイルへのロジック変更・リファクタリングは絶対禁止
- 判断に迷ったら相談してください`;

    if (skipBuild) {
      prompt += `\n- ⚠️ npm run build は実行しないでください。ビルドは後で一括で行います。ファイルの作成/変更のみ行ってください`;
    } else {
      prompt += `\n- npm run build でビルドが通ることを確認してください`;
    }

    prompt += `\n- 不明点や設計判断に迷った場合、以下のJSONを出力に含めるとPMに相談できます:
  {"consult": {"question": "相談内容"}}`;

    return prompt;
  }

  private async buildReviewContext(
    subtask: Subtask,
    file: FileToWrite,
    completedFiles: Array<{ path: string; content: string }>,
    systemFiles: Array<{ path: string; content: string }> = [],
    allSubtasks: Subtask[] = [],
  ): Promise<string> {
    let ctx = `## レビュー対象\npath: ${file.path}\naction: ${file.action}\n\n`;
    ctx += `## コード\n\`\`\`typescript\n${file.content}\n\`\`\`\n\n`;
    ctx += `## サブタスクの説明\n${subtask.description}\n\n`;

    // 後続サブタスク情報（レビュアーのスコープ判断用）
    const remaining = allSubtasks
      .filter(s => s.index > subtask.index)
      .map(s => `${s.index}. [${s.action}] ${s.path}: ${s.description.slice(0, 80)}`)
      .join('\n');
    if (remaining) {
      ctx += `## 後続サブタスク（このレビュー後に実施予定）\n${remaining}\n`;
      ctx += `※ 後続サブタスクで実施予定の変更は、このレビューではerrorとしないこと。ただし「到達不可能」問題はerror。\n\n`;
    }

    // ACをレビュアーに提供（サブタスクがACに貢献しているか検証するため）
    if (this.currentAC.length > 0) {
      ctx += `## 受け入れ条件（AC）— この開発全体の完了基準\n`;
      ctx += this.currentAC.map((ac, i) => `${i + 1}. ${ac}`).join('\n');
      ctx += `\n※ このサブタスクの説明に含まれるACに関する要件が、コードで実際に達成されているか確認してください。\n\n`;
    }

    // A: システム基盤ファイル（DBスキーマ、設定等）をレビュアーに提供
    if (systemFiles.length > 0) {
      ctx += `## システム基盤ファイル（参照用 — DBスキーマ・設定等）\n`;
      ctx += `※ これらのファイルは既にプロジェクトに存在します。レビュー対象コードがこれらを参照している場合の整合性チェックに使ってください。\n\n`;
      for (const f of systemFiles) {
        ctx += `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
      }
    }

    if (completedFiles.length > 0) {
      ctx += `## 関連する完了済みファイル\n`;
      for (const f of completedFiles) {
        ctx += `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\`\n\n`;
      }
    }

    // 過去開発で同じファイルを触った実績があれば情報提供
    const relatedDev = await buildRelatedDevContext(file.path);
    if (relatedDev) {
      ctx += `\n${relatedDev}\n`;
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
    diagnosisRound = 0,
  ): Promise<void> {
    // ── Step 1: ビルド ──
    dbLog('info', 'dev-agent', `[チーム] ビルド開始 (試行 ${retryCount + 1})`, { convId: conv.id });
    emitDevEvent({ type: 'build', convId: conv.id, agent: 'deployer', data: { status: 'building' } });
    const buildResult = await runBuild();

    if (!buildResult.success) {
      await recordMetric(conv.id, 'engineer', 'build_fail');
      const classified = classifyError(buildResult.buildOutput || '');
      dbLog('info', 'dev-agent', `[チーム] ビルド失敗: ${categoryLabel(classified.category)}/${classified.subcategory}`, { convId: conv.id });
      emitDevEvent({ type: 'build', convId: conv.id, agent: 'deployer', data: { status: 'failed', error: (buildResult.buildOutput || '').slice(0, 200) } });
      await saveTeamConversation('deployer_build', ['deployer', 'engineer'], [
        { role: 'deployer', message: `ビルド失敗 (試行 ${retryCount + 1}): ${categoryLabel(classified.category)}/${classified.subcategory}\n${(buildResult.buildOutput || '').slice(0, 300)}`, timestamp: new Date().toISOString() },
      ], conv.id, `ビルド失敗: ${classified.subcategory}`);

      if (retryCount < MAX_BUILD_RETRIES) {
        // エラー種別に応じた修正
        if (classified.category === 'transient') {
          const waitMs = classified.waitMs || 30_000;
          await sendLineMessage(conv.user_id, `⏳ 一時的エラー（${classified.subcategory}）。${waitMs / 1000}秒後にリトライ...`);
          await sleep(waitMs);
          await this.runBuildAndDeploy(conv, lastFiles, retryCount + 1, branchName);
          return;
        }
        if (classified.category === 'environment' && classified.autoFixable) {
          const fixed = await autoFixEnvironment(classified);
          if (fixed) {
            await sendLineMessage(conv.user_id, `🔧 環境問題を自動修正。リビルド中...`);
            await this.runBuildAndDeploy(conv, lastFiles, retryCount + 1, branchName);
            return;
          }
        }
        // コードエラー or 修正不可な環境エラー → エンジニアに自動修正させる
        await this.autoFixBuildError(conv, lastFiles, retryCount, branchName, buildResult.buildOutput || '', undefined, diagnosisRound);
      } else {
        // ── リトライ上限到達 → チーム診断 ──
        await this.handleExhaustedRetries(conv, branchName, 'build', buildResult.buildOutput || '', classified, lastFiles, undefined, diagnosisRound);
      }
      return;
    }

    await sendLineMessage(conv.user_id, '🔨 ビルド: OK');
    dbLog('info', 'dev-agent', '[チーム] ビルド成功 → テスト開始', { convId: conv.id });
    emitDevEvent({ type: 'build', convId: conv.id, agent: 'deployer', data: { status: 'success' } });
    await saveTeamConversation('deployer_build', ['deployer'], [
      { role: 'deployer', message: `ビルド成功 (試行 ${retryCount + 1})`, timestamp: new Date().toISOString() },
    ], conv.id, 'ビルド成功');

    // ── Step 2-3: 起動テスト + 機能テスト ──
    await sendLineMessage(conv.user_id, '🧪 自動テスト実行中...');
    emitDevEvent({ type: 'test', convId: conv.id, agent: 'deployer', data: { status: 'testing' } });
    const testResults = await runAllTests();
    const allPassed = testResults.every(r => r.passed);

    if (allPassed) {
      emitDevEvent({ type: 'test', convId: conv.id, agent: 'deployer', data: { status: 'passed' } });
      await saveTeamConversation('deployer_test', ['deployer'], [
        { role: 'deployer', message: `全テスト通過: ${testResults.map(r => `${r.stage}=OK`).join(', ')}`, timestamp: new Date().toISOString() },
      ], conv.id, '全テスト通過');
      for (const r of testResults) {
        const icon = r.stage === 'startup' ? '🚀' : '🧪';
        const name = r.stage === 'startup' ? '起動テスト' : '機能テスト';
        await sendLineMessage(conv.user_id, `${icon} ${name}: OK`);
      }
    } else {
      const failedResult = testResults.find(r => !r.passed)!;
      const failedName = failedResult.stage === 'startup' ? '起動テスト' : '機能テスト';
      const errorText = `${failedResult.message}\n${failedResult.details || ''}`;
      const classified = classifyError(errorText);

      dbLog('warn', 'dev-agent', `[デプロイヤー] ${failedName}失敗: ${categoryLabel(classified.category)}/${classified.subcategory}`, { convId: conv.id });
      emitDevEvent({ type: 'test', convId: conv.id, agent: 'deployer', data: { status: 'failed', message: failedResult.message.slice(0, 100) } });
      await saveTeamConversation('deployer_test', ['deployer', 'engineer'], [
        { role: 'deployer', message: `${failedName}失敗: ${failedResult.message.slice(0, 200)}`, timestamp: new Date().toISOString() },
      ], conv.id, `${failedName}失敗`);
      await recordMetric(conv.id, 'deployer', 'test_fail');
      await recordDeployerLearning(failedResult.stage, failedResult.message.slice(0, 150), retryCount >= MAX_TEST_FIX_RETRIES ? 'escalated' : 'fixed');
      await recordReject('deployer', 'engineer', failedResult.message,
        failedResult.details || '修正してください', 'major', false, conv.id);

      if (retryCount < MAX_TEST_FIX_RETRIES) {
        // 一時的エラー → 待機してリトライ
        if (classified.category === 'transient') {
          const waitMs = classified.waitMs || 30_000;
          await sendLineMessage(conv.user_id, `⏳ テスト中の一時的エラー（${classified.subcategory}）。${waitMs / 1000}秒後にリトライ...`);
          await sleep(waitMs);
          await this.runBuildAndDeploy(conv, lastFiles, retryCount + 1, branchName);
          return;
        }
        // 環境エラー → 自動修正してリトライ
        if (classified.category === 'environment' && classified.autoFixable) {
          const fixed = await autoFixEnvironment(classified);
          if (fixed) {
            await sendLineMessage(conv.user_id, `🔧 環境問題を自動修正。再テスト中...`);
            await this.runBuildAndDeploy(conv, lastFiles, retryCount + 1, branchName);
            return;
          }
        }
        // コードエラー → エンジニアに差し戻し
        await sendLineMessage(conv.user_id,
          `🧪 ${failedName}失敗 → エンジニアに差し戻し (${retryCount + 1}/${MAX_TEST_FIX_RETRIES})\n${failedResult.message}\n${failedResult.details?.slice(0, 200) || ''}`
        );
        await this.autoFixTestError(conv, lastFiles, retryCount, branchName, testResults, undefined, diagnosisRound);
      } else {
        // ── リトライ上限到達 → チーム診断 ──
        await this.handleExhaustedRetries(conv, branchName, 'test', errorText, classified, lastFiles, testResults, diagnosisRound);
      }
      return;
    }

    // ── Step 4: デプロイ ──
    dbLog('info', 'dev-agent', '[チーム] 全テスト通過 → デプロイ開始', { convId: conv.id });

    // デプロイ前コミット（失敗を検知）
    const finalCommit = await commitAndStay(branchName, `feat: complete ${conv.id.slice(0, 8)}`);
    if (!finalCommit.success) {
      const classified = classifyError(finalCommit.error || '');
      if (classified.autoFixable) {
        const fixed = await autoFixEnvironment(classified);
        if (fixed) {
          const retry = await commitAndStay(branchName, `feat: complete ${conv.id.slice(0, 8)}`);
          if (!retry.success) {
            throw new Error(`デプロイ前コミット失敗（自動修正後も解決せず）: ${retry.error}`);
          }
        } else {
          throw new Error(`デプロイ前コミット失敗: ${finalCommit.error}`);
        }
      } else {
        throw new Error(`デプロイ前コミット失敗: ${finalCommit.error}`);
      }
    }

    this.stuckContextMap.delete(conv.id);

    // pm2 restartでプロセスが死ぬためfinallyが実行されない → 先にロック解放
    releaseGitLock(conv.id);

    emitDevEvent({ type: 'deploy', convId: conv.id, agent: 'deployer', data: { status: 'deploying' } });
    await saveTeamConversation('deployer_deploy', ['deployer'], [
      { role: 'deployer', message: `デプロイ開始: ブランチ ${branchName}`, timestamp: new Date().toISOString() },
    ], conv.id, `デプロイ実行: ${branchName}`);
    await sendLineMessage(conv.user_id, '🚀 全テスト通過。デプロイ中（再起動します）...');

    await deployWithHealthCheck(branchName, {
      convId: conv.id,
      branchName,
      userId: conv.user_id,
      topic: conv.topic,
    });
    // ↑ 通常ここには到達しない（pm2がプロセスを殺すため）
  }

  // ── リトライ上限到達時のチーム診断 ──

  private async handleExhaustedRetries(
    conv: DevConversation,
    branchName: string,
    phase: 'build' | 'test',
    errorOutput: string,
    classified: ReturnType<typeof classifyError>,
    lastFiles: FileToWrite[],
    testResults?: TestResult[],
    diagnosisRound = 0,
  ): Promise<void> {
    const maxRetries = phase === 'build' ? MAX_BUILD_RETRIES : MAX_TEST_FIX_RETRIES;
    const phaseName = phase === 'build' ? 'ビルド' : 'テスト';

    // ── 診断ラウンド上限チェック ──
    if (diagnosisRound >= MAX_DIAGNOSIS_ROUNDS) {
      dbLog('error', 'dev-agent', `[チーム診断] 診断${MAX_DIAGNOSIS_ROUNDS}ラウンド到達 → 強制エスカレーション`, { convId: conv.id });
      const triedActions = [
        `${phaseName}の自動修正を${maxRetries}回試行`,
        `チーム診断会議を${diagnosisRound}ラウンド実施`,
        `診断に基づく修正を試みたが解決に至らず`,
      ];
      const { category: errCatDiag, explanation: errExpDiag } = classifyStuckError(errorOutput, phase);
      this.stuckContextMap.set(conv.id, {
        branchName, subtasks: [], completedFiles: [],
        failedSubtaskIndex: 0, errorMessage: errorOutput.slice(0, 500),
        phase, lastFiles,
        triedActions,
        dialogueLog: [],
        errorCategory: errCatDiag,
        errorExplanation: errExpDiag,
      });
      await updateConversationStatus(conv.id, 'stuck');
      emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'stuck', reason: `${phaseName}エラーが${MAX_DIAGNOSIS_ROUNDS}ラウンド診断でも未解決` } });
      const diagUrl = `${config.admin.baseUrl}/admin/dev/${conv.id}`;
      await sendLineMessage(conv.user_id,
        `📋 PMからの報告\n\n` +
        `■ 状況: ${phaseName}エラーが${MAX_DIAGNOSIS_ROUNDS}ラウンドの診断・修正でも解決できませんでした\n\n` +
        `■ 試したこと:\n${triedActions.map(a => `・${a}`).join('\n')}\n\n` +
        `■ エラー概要:\n${errorOutput.slice(0, 300)}\n\n` +
        `■ PM所見: 自動修正の範囲では解決が難しいエラーです。エラーの内容を見て、何か心当たりや追加の情報があれば教えてください。\n` +
        `一緒に方針を考えましょう。\n\n` +
        `詳細: ${diagUrl}`
      ).catch(() => {});
      return;
    }

    dbLog('info', 'dev-agent', `[チーム診断] ${phaseName}修正${maxRetries}回失敗 → チーム診断開始 (round ${diagnosisRound + 1}/${MAX_DIAGNOSIS_ROUNDS})`, { convId: conv.id });
    await sendLineMessage(conv.user_id, `🏥 ${phaseName}修正が上限に達しました。チーム診断会議を開始... (${diagnosisRound + 1}/${MAX_DIAGNOSIS_ROUNDS})`);
    emitDevEvent({ type: 'diagnosis', convId: conv.id, agent: 'system', data: { status: 'meeting', message: 'チーム診断会議開始' } });

    const diagnosis = await runTeamDiagnosis({
      convId: conv.id,
      phase,
      error: errorOutput,
      classifiedError: classified,
      buildOutput: phase === 'build' ? errorOutput : undefined,
      testResults: testResults,
      filesChanged: lastFiles.map(f => f.path),
      retryCount: maxRetries,
      maxRetries,
    });

    dbLog('info', 'dev-agent', `[チーム診断] 結果: ${diagnosis.recommendation} - ${diagnosis.rootCause.slice(0, 100)}`, { convId: conv.id });
    emitDevEvent({ type: 'diagnosis', convId: conv.id, agent: 'system', data: { recommendation: diagnosis.recommendation, rootCause: diagnosis.rootCause.slice(0, 100) } });
    // PMが診断結果を学びとして記憶
    await recordPmLearning(`diagnosis_${phase}_${conv.id.slice(0, 8)}`,
      `${phaseName}障害(${conv.topic.slice(0, 30)}): ${diagnosis.rootCause.slice(0, 200)}\n判断: ${diagnosis.recommendation}\n対処: ${diagnosis.actionPlan.slice(0, 150)}`,
      'team_diagnosis');

    // チーム分析の報告
    const analysisReport = diagnosis.teamAnalysis
      ? `\n\n📋 チーム分析:\n` +
        `PM: ${diagnosis.teamAnalysis.pm}\n` +
        `エンジニア: ${diagnosis.teamAnalysis.engineer}\n` +
        `デプロイヤー: ${diagnosis.teamAnalysis.deployer}`
      : '';

    switch (diagnosis.recommendation) {
      case 'retry_after_wait': {
        const waitMs = diagnosis.waitMs || 60_000;
        await sendLineMessage(conv.user_id, `⏳ チーム診断: ${diagnosis.actionPlan}\n${waitMs / 1000}秒待機後にリトライ...${analysisReport}`);
        await sleep(waitMs);
        // リトライカウントをリセット（診断を経たので新しい試行として扱う）
        await this.runBuildAndDeploy(conv, lastFiles, 0, branchName, diagnosisRound + 1);
        break;
      }
      case 'retry_with_fix': {
        await sendLineMessage(conv.user_id, `🔧 チーム診断: ${diagnosis.actionPlan}${analysisReport}`);
        // 診断の修正指示をもとに再修正を試みる
        if (phase === 'build') {
          await this.autoFixBuildError(conv, lastFiles, 0, branchName, errorOutput, diagnosis.fixInstructions, diagnosisRound + 1);
        } else {
          await this.autoFixTestError(conv, lastFiles, 0, branchName, testResults || [], diagnosis.fixInstructions, diagnosisRound + 1);
        }
        break;
      }
      case 'rollback': {
        await rollbackGit(branchName).catch(() => {});
        await updateConversationStatus(conv.id, 'failed');
        this.stuckContextMap.delete(conv.id);
        await sendLineMessage(conv.user_id,
          `🏥 チーム診断結果: ロールバック\n` +
          `根本原因: ${diagnosis.rootCause}\n` +
          `対処: ${diagnosis.actionPlan}${analysisReport}\n\n` +
          `コードをロールバックしました。新しい開発依頼でリトライできます。`
        ).catch(() => {});
        break;
      }
      case 'escalate_to_user':
      default: {
        // ロールバックせず、stuckモードでユーザーに判断を委ねる
        const triedActions = [
          `${phaseName}の自動修正を${maxRetries}回試行`,
          `チーム診断会議で原因分析を実施`,
        ];
        this.stuckContextMap.set(conv.id, {
          branchName,
          subtasks: [],
          completedFiles: [],
          failedSubtaskIndex: 0,
          errorMessage: diagnosis.rootCause,
          phase,
          lastFiles,
          triedActions,
          teamDiagnosis: `根本原因: ${diagnosis.rootCause}\n対処案: ${diagnosis.actionPlan}`,
          dialogueLog: [],
        });
        await updateConversationStatus(conv.id, 'stuck');
        emitDevEvent({ type: 'phase_change', convId: conv.id, agent: 'system', data: { phase: 'stuck', reason: 'チーム診断: ユーザーへエスカレーション' } });
        emitDevEvent({ type: 'escalation', convId: conv.id, agent: 'pm', data: { reason: 'team_diagnosis', phase } });
        const diagUrl2 = `${config.admin.baseUrl}/admin/dev/${conv.id}`;
        await sendLineMessage(conv.user_id,
          `📋 PMからの報告\n\n` +
          `■ 状況: ${phaseName}フェーズでチームの自動解決が困難な問題が発生\n\n` +
          `■ 試したこと:\n${triedActions.map(a => `・${a}`).join('\n')}\n\n` +
          `■ チーム診断結果:\n` +
          `根本原因: ${diagnosis.rootCause}\n` +
          `対処案: ${diagnosis.actionPlan}${analysisReport}\n\n` +
          `■ PM推奨: ${diagnosis.actionPlan}\n\n` +
          `この方針でよろしいですか？質問や別の方針があれば教えてください。\n\n` +
          `詳細: ${diagUrl2}`
        ).catch(() => {});
        break;
      }
    }
  }

  // ── ビルドエラー自動修正 ──

  private async autoFixBuildError(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
    buildOutput: string,
    diagnosisHint?: string,
    diagnosisRound = 0,
    transientWaitCount = 0,
  ): Promise<void> {
    dbLog('warn', 'dev-agent', `[エンジニア] ビルドエラー → 自動修正 (${retryCount + 1}/${MAX_BUILD_RETRIES})`, {
      convId: conv.id,
      buildOutput: buildOutput.slice(0, 300),
    });
    emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'engineer', data: { status: 'fixing', message: `ビルドエラー修正中... (${retryCount + 1}/${MAX_BUILD_RETRIES})` } });
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

      const diagnosisSection = diagnosisHint
        ? `## チーム診断からの追加指示\n${diagnosisHint}\n\n`
        : '';

      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
        messages: [{
          role: 'user',
          content: `以下のコードにビルドエラーがあります。修正してください。\n\n` +
            `## ビルドエラー\n${buildOutput}\n\n` +
            diagnosisSection +
            `## 今回変更したコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}\n\n` +
            (existingContext ? `## 関連する既存ファイル\n${existingContext}\n\n` : '') +
            `## 重要\n- 既存ファイルのimportパスや型定義に合わせてください\n- 存在しないモジュールをimportしないでください\n\n` +
            `全ファイルをまとめて修正してください。出力形式:\n{"files": [{"path": "...", "content": "...", "action": "..."}]}`,
        }],
        model: 'default',
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
      const fixDesc = fixedFiles.map(f => `${f.path}(${f.action})`).join(', ');
      await recordBuildLearning('engineer', buildOutput.slice(0, 200), `修正ファイル: ${fixDesc}`, fixedFiles.map(f => f.path));
      await recordDeployerLearning('build', buildOutput.slice(0, 150), 'fixed');
      await this.runBuildAndDeploy(conv, fixedFiles, retryCount + 1, branchName, diagnosisRound);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[エンジニア] ビルド自動修正失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });

      // 自動修正自体が失敗した場合もエラーを分類
      const classified = classifyError(errMsg);
      if (classified.category === 'transient') {
        if (transientWaitCount >= MAX_TRANSIENT_WAITS) {
          dbLog('error', 'dev-agent', `[エンジニア] 一時的エラー待機${MAX_TRANSIENT_WAITS}回到達 → エスカレーション`, { convId: conv.id });
          await updateConversationStatus(conv.id, 'stuck');
          this.stuckContextMap.set(conv.id, {
            branchName, subtasks: [], completedFiles: [],
            failedSubtaskIndex: 0, errorMessage: errMsg,
            phase: 'build', lastFiles,
            triedActions: [`ビルドエラー自動修正中にAPI制限が${MAX_TRANSIENT_WAITS}回連続で発生`],
            dialogueLog: [],
          });
          await sendLineMessage(conv.user_id,
            `⏳ API制限が${MAX_TRANSIENT_WAITS}回連続で発生しました。\n\n` +
            `選択肢:\n・「リトライ」→ 再試行\n・「中止」→ 開発を中止`
          ).catch(() => {});
          return;
        }
        const waitMs = classified.waitMs || 60_000;
        dbLog('info', 'dev-agent', `[エンジニア] 自動修正中の一時的エラー → ${waitMs / 1000}秒待機 (${transientWaitCount + 1}/${MAX_TRANSIENT_WAITS})`, { convId: conv.id });
        await sendLineMessage(conv.user_id, `⏳ API制限。${waitMs / 1000}秒待機後にリトライ... (${transientWaitCount + 1}/${MAX_TRANSIENT_WAITS})`);
        await sleep(waitMs);
        await this.autoFixBuildError(conv, lastFiles, retryCount, branchName, buildOutput, diagnosisHint, diagnosisRound, transientWaitCount + 1);
        return;
      }

      // それ以外 → ロールバック
      await rollbackGit(branchName).catch(() => {});
      await updateConversationStatus(conv.id, 'failed');
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
    diagnosisHint?: string,
    diagnosisRound = 0,
    transientWaitCount = 0,
  ): Promise<void> {
    dbLog('warn', 'dev-agent', `[エンジニア] テスト失敗 → 自動修正 (${retryCount + 1}/${MAX_TEST_FIX_RETRIES})`, { convId: conv.id });
    emitDevEvent({ type: 'agent_activity', convId: conv.id, agent: 'engineer', data: { status: 'fixing', message: `テスト失敗修正中... (${retryCount + 1}/${MAX_TEST_FIX_RETRIES})` } });
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
      const diagnosisSection = diagnosisHint
        ? `## チーム診断からの追加指示\n${diagnosisHint}\n\n`
        : '';

      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
        messages: [{
          role: 'user',
          content: `以下のコードはビルドは通りましたが、ランタイムテストで失敗しました。修正してください。\n\n` +
            `## テスト結果\n${testReport}\n\n` +
            diagnosisSection +
            `## テストの説明\n` +
            `- 起動テスト: PORT=3999 NODE_ENV=test で別プロセス起動 → /health で200確認\n` +
            `- 機能テスト: /test/task, /webhook, /telegram のルート存在確認\n\n` +
            `## 今回変更したコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}\n\n` +
            (existingContext ? `## 関連する既存ファイル\n${existingContext}\n\n` : '') +
            `## 重要\n- ランタイムエラー（起動時に落ちる原因）を特定して修正してください\n- importの不整合、未定義変数、型ミスマッチ等を確認\n- NODE_ENV=test時はLINE/Telegram送信がスキップされます\n\n` +
            `全ファイルをまとめて修正してください。出力形式:\n{"files": [{"path": "...", "content": "...", "action": "..."}]}`,
        }],
        model: 'default',
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
      const failedResult = testResults.find(r => !r.passed);
      if (failedResult) {
        const fixDesc = fixedFiles.map(f => `${f.path}(${f.action})`).join(', ');
        await recordTestLearning('engineer', failedResult.stage, failedResult.message.slice(0, 200), `修正ファイル: ${fixDesc}`);
        await recordDeployerLearning(failedResult.stage, failedResult.message.slice(0, 150), 'fixed');
      }
      await this.runBuildAndDeploy(conv, fixedFiles, retryCount + 1, branchName, diagnosisRound);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[エンジニア] テスト自動修正失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });

      // 自動修正自体が失敗した場合もエラーを分類
      const classified = classifyError(errMsg);
      if (classified.category === 'transient') {
        if (transientWaitCount >= MAX_TRANSIENT_WAITS) {
          dbLog('error', 'dev-agent', `[エンジニア] 一時的エラー待機${MAX_TRANSIENT_WAITS}回到達 → エスカレーション`, { convId: conv.id });
          await updateConversationStatus(conv.id, 'stuck');
          this.stuckContextMap.set(conv.id, {
            branchName, subtasks: [], completedFiles: [],
            failedSubtaskIndex: 0, errorMessage: errMsg,
            phase: 'test', lastFiles,
            triedActions: [`テスト失敗自動修正中にAPI制限が${MAX_TRANSIENT_WAITS}回連続で発生`],
            dialogueLog: [],
          });
          await sendLineMessage(conv.user_id,
            `⏳ API制限が${MAX_TRANSIENT_WAITS}回連続で発生しました。\n\n` +
            `選択肢:\n・「リトライ」→ 再試行\n・「中止」→ 開発を中止`
          ).catch(() => {});
          return;
        }
        const waitMs = classified.waitMs || 60_000;
        dbLog('info', 'dev-agent', `[エンジニア] 自動修正中の一時的エラー → ${waitMs / 1000}秒待機 (${transientWaitCount + 1}/${MAX_TRANSIENT_WAITS})`, { convId: conv.id });
        await sendLineMessage(conv.user_id, `⏳ API制限。${waitMs / 1000}秒待機後にリトライ... (${transientWaitCount + 1}/${MAX_TRANSIENT_WAITS})`);
        await sleep(waitMs);
        await this.autoFixTestError(conv, lastFiles, retryCount, branchName, testResults, diagnosisHint, diagnosisRound, transientWaitCount + 1);
        return;
      }

      await rollbackGit(branchName).catch(() => {});
      await updateConversationStatus(conv.id, 'failed');
      this.stuckContextMap.delete(conv.id);
      await sendLineMessage(conv.user_id,
        `テスト失敗の自動修正に失敗しました:\n${errMsg.slice(0, 300)}\n\nコードをロールバックしました。`
      ).catch(() => {});
    }
  }
}

/** F3: PMがユーザーにエスカレーションすべきと判断した場合に投げるエラー */
class EscalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscalationError';
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
