import { Router, Request, Response } from 'express';
import * as line from '@line/bot-sdk';
import { config } from '../config';
import { isAuthorizedUser } from './auth';
import { sendLineMessage } from './sender';
import { interpretTask } from '../interpreter/taskInterpreter';
import { enqueueTask } from '../queue/taskQueue';
import { getActiveConversation, cancelConversation } from '../agents/dev/conversation';
import { DevAgent } from '../agents/dev/devAgent';
import { generateResponse, gatherSystemContext } from './responder';
import { saveMessage } from './messageHistory';
import { logger, dbLog } from '../utils/logger';

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

async function handleMessage(userId: string, text: string): Promise<void> {
  if (text === 'ping') {
    await sendLineMessage(userId, 'pong');
    return;
  }

  // --- 開発エージェントのルーティング ---
  const activeDevConv = getActiveConversation(userId);

  if (activeDevConv) {
    // 古い会話を自動期限切れ（30分）
    const updatedAt = new Date(activeDevConv.updated_at + 'Z').getTime();
    const now = Date.now();
    const staleMinutes = Math.floor((now - updatedAt) / 60000);

    if (staleMinutes > 30 && (activeDevConv.status === 'hearing' || activeDevConv.status === 'defining')) {
      dbLog('info', 'webhook', `開発会話を自動期限切れ: ${activeDevConv.id} (${staleMinutes}分経過)`, { convId: activeDevConv.id });
      cancelConversation(activeDevConv.id);
      // フォールスルーして通常応答
    } else {
      dbLog('info', 'webhook', `開発会話あり: status=${activeDevConv.status}, topic=${activeDevConv.topic.slice(0, 30)}`, { convId: activeDevConv.id });

      // キャンセル（自然な表現に対応）
      if (/開発(キャンセル|中止|やめ)|やめて|やめる|キャンセル|別の話/.test(text)) {
        dbLog('info', 'webhook', 'ルーティング → 開発キャンセル');
        await devAgent.handleMessage(userId, text);
        return;
      }

      switch (activeDevConv.status) {
        case 'hearing':
          // ヒアリング中: 基本的に開発への返答として扱う
          dbLog('info', 'webhook', 'ルーティング → 開発ヒアリング');
          await devAgent.handleMessage(userId, text);
          return;

        case 'defining':
          // 要件定義中: OKか修正指示のみ開発へルーティング
          if (isDefiningResponse(text)) {
            dbLog('info', 'webhook', `ルーティング → 開発要件定義 (${text.slice(0, 20)})`);
            await devAgent.handleMessage(userId, text);
            return;
          }
          dbLog('info', 'webhook', 'defining中だが開発と無関係 → 通常応答');
          // フォールスルー
          break;

        case 'approved':
        case 'implementing':
        case 'testing':
          // 実装中: 通常応答にフォールスルー（ブロックしない）
          dbLog('info', 'webhook', `実装中(${activeDevConv.status}) → 通常応答にフォールスルー`);
          break;
      }
    }
  }

  // 新規開発依頼の検出
  const isDevRequest = /開発して|実装して|母艦に.*追加して|新しいエージェントを作って|機能を追加して/.test(text);
  if (isDevRequest) {
    dbLog('info', 'webhook', 'ルーティング → 新規開発依頼');
    await devAgent.handleMessage(userId, text);
    return;
  }

  // --- 通常の会話処理 ---
  saveMessage(userId, 'user', text);
  dbLog('info', 'webhook', 'ルーティング → 通常応答');

  try {
    const systemContext = await gatherSystemContext();

    const response = await generateResponse(text, {
      systemStatus: systemContext,
    }, userId);

    // DEV_AGENT トリガー
    if (response.trim() === 'DEV_AGENT') {
      dbLog('info', 'webhook', 'Claude判定 → DEV_AGENT トリガー');
      await devAgent.handleMessage(userId, text);
      return;
    }

    // タスク実行が必要か判定
    const needsTask = await shouldCreateTask(text, response);

    if (needsTask) {
      dbLog('info', 'webhook', 'タスクキューへ投入');
      const interpreted = await interpretTask(text);

      if (interpreted.confirmation_needed) {
        const clarifyResponse = await generateResponse(
          `ユーザーの指示「${text}」について確認が必要です: ${interpreted.clarification_question}`,
          { rawContext: '確認事項をユーザーに自然に質問してください。' },
          userId,
        );
        await sendLineMessage(userId, clarifyResponse);
        saveMessage(userId, 'assistant', clarifyResponse);
        return;
      }

      for (const task of interpreted.tasks) {
        enqueueTask(task);
      }

      const taskNames = interpreted.tasks.map(t => t.description).join('\n');
      const queueResponse = await generateResponse(
        `「${text}」を受けて以下のタスクをキューに追加しました:\n${taskNames}\n\n推定API呼び出し: ${interpreted.estimated_api_calls}回`,
        { rawContext: 'タスクが正常にキューに入ったことをユーザーに伝えてください。' },
        userId,
      );
      await sendLineMessage(userId, queueResponse);
      saveMessage(userId, 'assistant', queueResponse);
    } else {
      await sendLineMessage(userId, response);
      saveMessage(userId, 'assistant', response);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('メッセージ処理エラー', { err: errMsg, text });
    dbLog('error', 'webhook', `処理エラー: ${errMsg.slice(0, 200)}`, { text });

    const errorResponse = await generateResponse(
      `エラーが発生しました: ${errMsg.slice(0, 200)}`,
      { rawContext: 'エラーをユーザーに伝え、次に何をすべきか提案してください。' },
      userId,
    ).catch(() => `エラーが発生しました。ダッシュボードで確認してください: ${config.admin.baseUrl}/admin`);

    await sendLineMessage(userId, errorResponse);
    saveMessage(userId, 'assistant', errorResponse);
  }
}

/** defining フェーズへのメッセージかどうかを判定（Claude不使用） */
function isDefiningResponse(text: string): boolean {
  // 承認パターン
  if (/^(ok|OK|Ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで)$/i.test(text.trim())) {
    return true;
  }
  // 明示的な修正指示（「〜に変えて」「〜を追加して」「〜は不要」等）
  if (/変えて|修正して|追加して|削除して|不要|変更して|直して|ここを|要件/.test(text)) {
    return true;
  }
  return false;
}

async function shouldCreateTask(userMessage: string, aiResponse: string): Promise<boolean> {
  const actionKeywords = /分析して|最適化して|チェックして|レポート|調べて|改善して|提案して|比較して|監査して|スクリプト|自動化/;
  return actionKeywords.test(userMessage);
}
