import { Router, Request, Response } from 'express';
import * as line from '@line/bot-sdk';
import { config } from '../config';
import { isAuthorizedUser } from './auth';
import { sendLineMessage, setActiveSendTo } from './sender';
import { interpretTask } from '../interpreter/taskInterpreter';
import { enqueueTask } from '../queue/taskQueue';
import { getActiveConversation, cancelConversation, getConversation } from '../agents/dev/conversation';
import { DevAgent } from '../agents/dev/devAgent';
import { generateResponse, gatherSystemContext } from './responder';
import { extractAndSaveMemories } from './autoExtract';
import { saveMessage } from './messageHistory';
import { saveMemoryWithEmbedding, getAllMemories, searchByMeaning, deleteMemory, MemoryType } from '../memory/store';
import { trackMessage, isEndSignal, endSession } from '../memory/session';
import { consolidateKnowledge, applyPendingUpdate } from '../knowledge/consolidator';
import { extractDaikiEvaluation } from '../agents/dev/teamEvaluation';
import { getTeamConversations } from '../agents/dev/teamConversation';
import { getDB } from '../db/database';
import { logger, dbLog } from '../utils/logger';

/**
 * プラットフォーム間のユーザーID統一。
 * DB操作（記憶・履歴・セッション）は常にLINE IDを使い、
 * メッセージ送信は元の userId（tg: プレフィックス付き含む）を使う。
 */
function getCanonicalUserId(userId: string): string {
  if (userId.startsWith('tg:')) {
    return config.line.allowedUserId; // Telegram → LINE IDに統一
  }
  return userId;
}

const devAgent = new DevAgent();

const lineMiddlewareConfig = {
  channelSecret: config.line.channelSecret,
};

export const webhookRouter = Router();

webhookRouter.post(
  '/',
  line.middleware(lineMiddlewareConfig) as any,
  async (req: Request, res: Response) => {
    res.status(200).end();

    try {
      const events = (req.body?.events || []) as line.WebhookEvent[];
      for (const event of events) {
        if (event.type !== 'message') continue;
        if (event.message.type !== 'text') continue;

        const userId = event.source.userId;
        if (!userId || !isAuthorizedUser(userId)) {
          logger.warn('未認証ユーザー', { userId });
          continue;
        }

        const text = event.message.text.trim();
        dbLog('info', 'webhook', `受信: ${text.slice(0, 100)}`, { userId });
        await handleMessage(userId, text);
      }
    } catch (err) {
      logger.error('Webhook処理エラー', { err });
    }
  }
);

/** 脱出意図の検出（最優先で処理） */
function wantsToExit(text: string): boolean {
  return /リセット|reset|キャンセル|やめ|中止|中断|ストップ|stop|もういい|いらない|別の話|終わり|終了/i.test(text);
}

export async function handleMessage(userId: string, text: string): Promise<void> {
  // DB用の正規化ID（LINE/Telegram共通で同一ユーザーの記憶を共有）
  const dbId = getCanonicalUserId(userId);
  // 送信用はそのまま userId を使う（tg: プレフィックスで自動切り替え）
  // 最後にアクティブなプラットフォームを記録（executor等のバックグラウンド通知用）
  setActiveSendTo(userId);

  // セッション追跡
  trackMessage(dbId);

  if (text === 'ping') {
    await sendLineMessage(userId, 'pong');
    return;
  }

  // 終了合図 → セッション要約保存
  if (isEndSignal(text)) {
    saveMessage(dbId, 'user', text);
    const response = await generateResponse(text, undefined, dbId);
    await sendLineMessage(userId, response);
    saveMessage(dbId, 'assistant', response);
    endSession(dbId).catch(err => logger.warn('セッション終了失敗', { err: err instanceof Error ? err.message : String(err) }));
    return;
  }

  // ★ 記憶コマンド
  const memoryResult = await handleMemoryCommand(userId, dbId, text);
  if (memoryResult) return;

  // ★ ナレッジ統合コマンド
  if (/^ナレッジ(更新|統合)$/.test(text)) {
    saveMessage(dbId, 'user', text);
    await sendLineMessage(userId, 'ナレッジ統合を開始します...');
    try {
      const result = await consolidateKnowledge(dbId);
      for (const diff of result.diffs) {
        await sendLineMessage(userId, diff);
      }
      if (result.updatedFiles.length > 0) {
        await sendLineMessage(userId, '上記の変更を反映しますか？「反映」で確定。');
      }
    } catch (err) {
      logger.error('ナレッジ統合エラー', { err: err instanceof Error ? err.message : String(err) });
      await sendLineMessage(userId, 'ナレッジ統合でエラーが発生しました。');
    }
    return;
  }

  // ★ ナレッジ反映承認
  if (/^反映$/.test(text)) {
    saveMessage(dbId, 'user', text);
    try {
      const result = await applyPendingUpdate(dbId);
      await sendLineMessage(userId, result);
      saveMessage(dbId, 'assistant', result);
    } catch (err) {
      logger.error('ナレッジ反映エラー', { err: err instanceof Error ? err.message : String(err) });
      await sendLineMessage(userId, 'ナレッジ反映でエラーが発生しました。');
    }
    return;
  }

  // ★ 会話ログコマンド
  if (/^会話ログ$/.test(text)) {
    saveMessage(dbId, 'user', text);
    try {
      const logs = getTeamConversations(undefined, 5);
      if (logs.length === 0) {
        await sendLineMessage(userId, 'チーム会話ログはまだありません。');
      } else {
        const lines = logs.map((log: any) => {
          const participants = JSON.parse(log.participants).join(',');
          const created = log.created_at?.slice(0, 16) || '';
          const decision = log.decision ? `\n  → ${log.decision.slice(0, 60)}` : '';
          return `[${log.conversation_type}] ${participants} (${created})${decision}`;
        });
        await sendLineMessage(userId, `📋 チーム会話ログ（直近5件）\n\n${lines.join('\n\n')}`);
      }
    } catch (err) {
      logger.error('会話ログ取得エラー', { err: err instanceof Error ? err.message : String(err) });
      await sendLineMessage(userId, '会話ログの取得でエラーが発生しました。');
    }
    return;
  }

  // dev会話はプラットフォーム固有ID（tg:xxx等）で管理される（devAgentが作成時にuserIdを使うため）
  const activeDevConv = getActiveConversation(userId);

  // ★ 脱出チェック（最優先）
  if (activeDevConv && wantsToExit(text)) {
    cancelConversation(activeDevConv.id);
    dbLog('info', 'webhook', `開発脱出: "${text}" → conv ${activeDevConv.id} をキャンセル`);
    await sendLineMessage(userId, '開発を中止しました。何でも聞いてください。');
    return;
  }

  // ★ セーフワード検出（最優先 — 自動ルーティングを上書き）
  const safeWordResult = detectSafeWord(text);
  if (safeWordResult && activeDevConv) {
    const { target, cleanText } = safeWordResult;
    const autoTarget = getAutoRouteTarget(activeDevConv.status);
    // 自動判定先と違う場合のみ修正を記録（学習用）
    if (autoTarget !== target) {
      recordRoutingCorrection(userId, cleanText, activeDevConv.status, autoTarget, target);
      dbLog('info', 'webhook', `セーフワード: ${target} (自動判定: ${autoTarget}, フェーズ: ${activeDevConv.status})`);
    }
    if (target === 'pm') {
      await devAgent.handleMessage(userId, cleanText);
      return;
    }
    // target === 'bunshin' → 下のresponder処理にフォールスルー（cleanTextで上書き）
    text = cleanText;
    // bunshin強制のため、dev固有ルーティングをスキップ
    saveMessage(dbId, 'user', text);
    dbLog('info', 'webhook', `セーフワード → 分身: "${text.slice(0, 30)}"`);
    // responder呼び出しへ直行
  } else {
    // ★ 通常のdev会話ルーティング

    // ★ defining フェーズ: OKか修正指示のみdevへ
    if (activeDevConv && activeDevConv.status === 'defining') {
      // requirements が未生成（API呼び出し中）の場合はメッセージをブロック
      if (!activeDevConv.requirements) {
        dbLog('info', 'webhook', `要件定義書生成中にメッセージ受信（待機通知）: "${text.slice(0, 20)}"`);
        await sendLineMessage(userId, '要件定義書を作成中です。もう少しお待ちください...\n（完了後に確認いただけます）');
        return;
      }
      if (isDefiningResponse(text)) {
        dbLog('info', 'webhook', `ルーティング → defining応答: "${text.slice(0, 20)}"`);
        await devAgent.handleMessage(userId, text);
        return;
      }
      dbLog('info', 'webhook', 'defining中だが無関係 → 通常応答');
    }

    // ★ hearing / stuck / implementing / testing: responderに判断を委ねる（DEV_AGENTトリガー経由）
    // （セーフワードなし → 自動ルーティング → 全てresponderが判定）

    // ★ 新規開発依頼（正規表現で即マッチ）
    if (!activeDevConv && isDevRequest(text)) {
      dbLog('info', 'webhook', 'ルーティング → 新規開発依頼（パターンマッチ）');
      await devAgent.handleMessage(userId, text);
      return;
    }

    // --- 通常応答（hearing/stuck/implementing/testing中もここを通る） ---
    saveMessage(dbId, 'user', text);
    dbLog('info', 'webhook', 'ルーティング → 通常応答');
  }

  try {
    // ★ タスク実行判定を先にチェック（Claude API呼び出しの無駄を防ぐ）
    if (!activeDevConv && shouldCreateTask(text)) {
      dbLog('info', 'webhook', 'タスクキューへ投入');
      const interpreted = await interpretTask(text);

      if (interpreted.confirmation_needed) {
        const clarifyResponse = await generateResponse(
          `ユーザーの指示「${text}」について確認が必要です: ${interpreted.clarification_question}`,
          { rawContext: '確認事項をユーザーに自然に質問してください。' },
          dbId,
        );
        await sendLineMessage(userId, clarifyResponse);
        saveMessage(dbId, 'assistant', clarifyResponse);
        return;
      }

      for (const task of interpreted.tasks) {
        enqueueTask(task);
      }

      const taskNames = interpreted.tasks.map(t => t.description).join('\n');
      const queueResponse = await generateResponse(
        `「${text}」を受けて以下のタスクをキューに追加しました:\n${taskNames}\n\n推定API呼び出し: ${interpreted.estimated_api_calls}回`,
        { rawContext: 'タスクが正常にキューに入ったことをユーザーに伝えてください。' },
        dbId,
      );
      await sendLineMessage(userId, queueResponse);
      saveMessage(dbId, 'assistant', queueResponse);
      extractAndSaveMemories(dbId, text, queueResponse).catch(err => logger.warn('自動記憶抽出失敗', { err }));
      return;
    }

    const systemContext = await gatherSystemContext();

    // 進行中の開発情報をコンテキストに含める + DEV_AGENTトリガー指示
    let devContext = '';
    if (activeDevConv) {
      devContext = buildDevRoutingContext(activeDevConv, userId);
    } else {
      // 開発会話がない時も、新規開発依頼を検出する
      devContext = '\n\n## 開発エージェント\nこのシステムには開発チーム（PM→エンジニア→レビュアー）が組み込まれています。' +
        'ユーザーが「何かを作って欲しい」「機能を追加したい」「ページ/ツール/エージェントを開発して」のような開発依頼をしている場合は、"DEV_AGENT" とだけ返してください。' +
        '雑談・質問・相談など開発依頼でないメッセージには普通に回答してください。';
    }

    const response = await generateResponse(text, {
      systemStatus: systemContext,
      rawContext: devContext || undefined,
    }, dbId);

    // DEV_AGENT トリガー
    if (response.trim() === 'DEV_AGENT') {
      dbLog('info', 'webhook', 'responder判定 → DEV_AGENT');
      await devAgent.handleMessage(userId, text);
      return;
    }

    await sendLineMessage(userId, response);
    saveMessage(dbId, 'assistant', response);
    extractAndSaveMemories(dbId, text, response).catch(err => logger.warn('自動記憶抽出失敗', { err }));

    // バックグラウンドで評価抽出（直近のdeployedタスクのtopicを渡す）
    const lastDeployed = getDB().prepare(
      `SELECT topic FROM dev_conversations WHERE user_id = ? AND status = 'deployed' ORDER BY updated_at DESC LIMIT 1`
    ).get(userId) as { topic: string } | undefined;
    extractDaikiEvaluation(text, lastDeployed?.topic).catch(err =>
      logger.warn('評価抽出失敗', { err: err instanceof Error ? err.message : String(err) })
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('メッセージ処理エラー', { err: errMsg, text });
    dbLog('error', 'webhook', `処理エラー: ${errMsg.slice(0, 200)}`, { text });

    const errorResponse = await generateResponse(
      `エラーが発生しました: ${errMsg.slice(0, 200)}`,
      { rawContext: 'エラーをユーザーに伝え、次に何をすべきか提案してください。' },
      dbId,
    ).catch(() => `エラーが発生しました。ダッシュボードで確認してください: ${config.admin.baseUrl}/admin`);

    await sendLineMessage(userId, errorResponse);
    saveMessage(dbId, 'assistant', errorResponse);
  }
}

/** 開発依頼かどうかを正規表現で判定 */
function isDevRequest(text: string): boolean {
  return /開発して|実装して|開発依頼|開発.*お願い|母艦に.*追加|新しいエージェント.*作|機能.*追加して|作って.*欲しい|ページ.*作って|ツール.*作って|ボット.*作って|追加.*開発|エンジニア.*依頼|開発チーム.*お願い/.test(text);
}

function isDefiningResponse(text: string): boolean {
  const trimmed = text.trim();
  // 承認パターン（完全一致）
  if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで|それでいい|いいと思う|よさそう|良さそう)$/i.test(trimmed)) return true;
  // 修正指示パターン（具体的な動詞のみ。「要件」「追加して」は状況確認と紛らわしいので除外）
  if (/変えて|修正して|削除して|不要|変更して|直して|ここを|書き直して|やり直して/.test(trimmed)) return true;
  return false;
}

function shouldCreateTask(userMessage: string): boolean {
  return /分析して|最適化して|チェックして|レポート|調べて|改善して|提案して|比較して|監査して|スクリプト|自動化/.test(userMessage);
}

// ========================================
// セーフワード & ルーティング学習
// ========================================

/** セーフワードを検出してターゲットとクリーンテキストを返す */
function detectSafeWord(text: string): { target: 'bunshin' | 'pm'; cleanText: string } | null {
  // @分身 / @PM をメッセージ先頭で検出
  const bunshinMatch = text.match(/^@分身\s*([\s\S]*)/);
  if (bunshinMatch) {
    return { target: 'bunshin', cleanText: bunshinMatch[1].trim() || text };
  }
  const pmMatch = text.match(/^@PM\s*([\s\S]*)/i);
  if (pmMatch) {
    return { target: 'pm', cleanText: pmMatch[1].trim() || text };
  }
  return null;
}

/** 各フェーズで自動ルーティングが向かう先を返す */
function getAutoRouteTarget(status: string): 'bunshin' | 'pm' {
  // stuck → 従来はPMに全メッセージ直行だった
  // implementing/testing/approved → 従来はブロック（PMでも分身でもない）だが、概念上はPM側
  // hearing/defining → 分身が判定
  if (['stuck', 'implementing', 'testing', 'approved'].includes(status)) return 'pm';
  return 'bunshin';
}

/** ルーティング修正をDBに記録（自己学習用） */
function recordRoutingCorrection(
  userId: string, message: string, devPhase: string,
  autoTarget: string, correctedTarget: string,
): void {
  try {
    const db = getDB();
    db.prepare(`
      INSERT INTO routing_corrections (user_id, message, dev_phase, auto_target, corrected_target)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, message.slice(0, 300), devPhase, autoTarget, correctedTarget);
  } catch (err) {
    logger.warn('ルーティング修正記録失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** 直近のルーティング修正履歴を取得（プロンプト注入用） */
function getRecentRoutingCorrections(userId: string, limit = 10): Array<{ message: string; dev_phase: string; corrected_target: string }> {
  try {
    const db = getDB();
    return db.prepare(`
      SELECT message, dev_phase, corrected_target
      FROM routing_corrections
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, limit) as Array<{ message: string; dev_phase: string; corrected_target: string }>;
  } catch {
    return [];
  }
}

/** 開発会話の状態に応じたルーティングコンテキストを構築 */
function buildDevRoutingContext(conv: { id: string; topic: string; status: string; hearing_log: string }, userId: string): string {
  let ctx = `\n## 進行中の開発\nトピック: ${conv.topic}\n状態: ${conv.status}`;

  // フェーズ別のコンテキスト追加
  if (conv.status === 'hearing') {
    try {
      const log = JSON.parse(conv.hearing_log) as Array<{ role: string; message: string }>;
      const lastAgentMsg = [...log].reverse().find(e => e.role === 'agent');
      if (lastAgentMsg) {
        ctx += `\nPMの最後の質問:\n${lastAgentMsg.message}`;
      }
    } catch { /* ignore */ }
  } else if (conv.status === 'stuck') {
    ctx += '\nPMがユーザーに質問/提案しています。ユーザーの返答がPMへの指示（リトライ、中止、技術的な相談など）であればPMに転送が必要です。';
  } else if (['implementing', 'testing', 'approved'].includes(conv.status)) {
    const label = conv.status === 'testing' ? 'テスト・デプロイ' : conv.status === 'approved' ? '準備' : '実装';
    ctx += `\n現在${label}がバックグラウンドで進行中。完了時に自動通知されます。`;
  }

  // 過去のルーティング修正を学習例として注入
  const corrections = getRecentRoutingCorrections(userId);
  if (corrections.length > 0) {
    const bunshinExamples = corrections.filter(c => c.corrected_target === 'bunshin');
    const pmExamples = corrections.filter(c => c.corrected_target === 'pm');
    ctx += '\n\n## ルーティング学習（過去の修正例）';
    if (bunshinExamples.length > 0) {
      ctx += '\n開発中でも分身（あなた）が答えるべきだったメッセージ:';
      for (const ex of bunshinExamples.slice(0, 5)) {
        ctx += `\n- 「${ex.message.slice(0, 60)}」(${ex.dev_phase}中)`;
      }
    }
    if (pmExamples.length > 0) {
      ctx += '\nPM（開発チーム）に転送すべきだったメッセージ:';
      for (const ex of pmExamples.slice(0, 5)) {
        ctx += `\n- 「${ex.message.slice(0, 60)}」(${ex.dev_phase}中)`;
      }
    }
  }

  // DEV_AGENTトリガー指示
  ctx += '\n\n## ルーティング判定ルール' +
    '\nユーザーのメッセージが開発チーム（PM）への指示・回答・相談であれば "DEV_AGENT" とだけ返してください。' +
    '\n雑談・質問・相談など開発に無関係なメッセージには普通に回答してください。' +
    '\n迷ったら普通に回答してください（ユーザーは @PM で明示的にPMに切り替えられます）。';

  return ctx;
}

/** 記憶関連コマンドの処理。処理したらtrue
 * @param sendToId - 送信用ID（tg: プレフィックス含む）
 * @param dbUserId - DB用正規化ID（常にLINE ID）
 * @param text - メッセージ本文
 */
async function handleMemoryCommand(sendToId: string, dbUserId: string, text: string): Promise<boolean> {
  // ★ 順番が重要: 一覧/検索チェック → 保存 → 削除

  // 「何覚えてる？」「覚えてる？」「記憶一覧」→ 記憶の一覧表示
  if (/^(何.{0,2}覚えてる|覚えてる[？?]?$|記憶一覧|メモ一覧|覚えてること)/.test(text)) {
    const memories = getAllMemories(dbUserId);
    if (memories.length === 0) {
      await sendLineMessage(sendToId, 'まだ何も覚えていません。\n「覚えて 〇〇」で記憶を追加できます。');
    } else {
      const lines: string[] = [];
      const byType: Record<string, typeof memories> = {};
      for (const m of memories) {
        (byType[m.type] ||= []).push(m);
      }
      if (byType.consolidated) {
        lines.push('🧠 統合プロフィール');
        for (const m of byType.consolidated) lines.push(`  ${m.key}: ${m.content.slice(0, 80)}`);
      }
      if (byType.profile) {
        lines.push('👤 プロフィール');
        for (const m of byType.profile) lines.push(`  ${m.key}: ${m.content}`);
      }
      if (byType.project) {
        lines.push('📁 プロジェクト');
        for (const m of byType.project) lines.push(`  ${m.key}: ${m.content}`);
      }
      if (byType.memo) {
        lines.push('📝 メモ');
        for (const m of byType.memo) lines.push(`  ${m.key}: ${m.content}`);
      }
      if (byType.session_summary) {
        lines.push(`💬 会話要約 (${byType.session_summary.length}件)`);
        for (const m of byType.session_summary.slice(0, 3)) lines.push(`  ${m.key}: ${m.content.slice(0, 60)}`);
        if (byType.session_summary.length > 3) lines.push(`  ...他${byType.session_summary.length - 3}件`);
      }
      await sendLineMessage(sendToId, lines.join('\n'));
    }
    saveMessage(dbUserId, 'user', text);
    return true;
  }

  // 「〇〇について覚えてる？」→ 意味検索
  const recallMatch = text.match(/^(.+?)(について|のこと).*(覚えてる|記憶|知ってる)/);
  if (recallMatch) {
    const query = recallMatch[1].trim();
    try {
      const found = await searchByMeaning(dbUserId, query, 5);
      if (found.length > 0) {
        const lines = found.map(r => `[${r.memory.type}] ${r.memory.key}: ${r.memory.content.slice(0, 80)}`);
        await sendLineMessage(sendToId, `「${query}」に関する記憶:\n${lines.join('\n')}`);
      } else {
        await sendLineMessage(sendToId, `「${query}」に関する記憶はありません。`);
      }
    } catch {
      await sendLineMessage(sendToId, `記憶検索でエラーが発生しました。`);
    }
    saveMessage(dbUserId, 'user', text);
    return true;
  }

  // 「覚えて 〇〇」「覚えて: 〇〇」→ メモ保存（embedding付き）
  const memoMatch = text.match(/^覚えて[：:]\s*(.+)/s) || text.match(/^覚えて\s+(.+)/s);
  if (memoMatch) {
    const content = memoMatch[1].trim();
    if (!content) return false;
    const key = content.slice(0, 20).replace(/\s+/g, '_');
    await saveMemoryWithEmbedding(dbUserId, 'memo', key, content);
    dbLog('info', 'webhook', `記憶保存: key=${key}`, { userId: dbUserId });
    await sendLineMessage(sendToId, `覚えました 📝\n「${content.slice(0, 50)}${content.length > 50 ? '...' : ''}」`);
    saveMessage(dbUserId, 'user', text);
    saveMessage(dbUserId, 'assistant', '覚えました');
    return true;
  }

  // 「忘れて 〇〇」「忘れて: 〇〇」→ 記憶削除
  const forgetMatch = text.match(/^忘れて[：:]\s*(.+)/s) || text.match(/^忘れて\s+(.+)/s);
  if (forgetMatch) {
    const query = forgetMatch[1].trim();
    if (!query) return false;
    try {
      const found = await searchByMeaning(dbUserId, query, 1);
      if (found.length > 0) {
        deleteMemory(dbUserId, found[0].memory.type as MemoryType, found[0].memory.key);
        await sendLineMessage(sendToId, `「${found[0].memory.key}」の記憶を削除しました。`);
      } else {
        await sendLineMessage(sendToId, `「${query}」に関する記憶は見つかりませんでした。`);
      }
    } catch {
      await sendLineMessage(sendToId, `記憶削除でエラーが発生しました。`);
    }
    saveMessage(dbUserId, 'user', text);
    return true;
  }

  return false;
}
