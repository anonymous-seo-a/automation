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

  // 強制リセット（どの状態でも効く）
  if (/^(リセット|reset)$/i.test(text)) {
    const conv = getActiveConversation(userId);
    if (conv) {
      cancelConversation(conv.id);
      dbLog('info', 'webhook', `強制リセット: ${conv.id}`);
      await sendLineMessage(userId, '開発会話をリセットしました。');
    } else {
      await sendLineMessage(userId, 'リセット対象はありません。');
    }
    return;
  }

  // --- 開発エージェント判定 ---
  const activeDevConv = getActiveConversation(userId);

  if (activeDevConv) {
    const createdAt = new Date(activeDevConv.created_at + 'Z').getTime();
    const staleMinutes = Math.floor((Date.now() - createdAt) / 60000);

    // 10分経過した hearing/defining は自動期限切れ
    if (staleMinutes > 10 && (activeDevConv.status === 'hearing' || activeDevConv.status === 'defining')) {
      cancelConversation(activeDevConv.id);
      dbLog('info', 'webhook', `自動期限切れ: ${activeDevConv.id} (${staleMinutes}分経過)`);
      // フォールスルー → 通常応答
    } else {
      dbLog('info', 'webhook', `開発会話あり: status=${activeDevConv.status}, topic=${activeDevConv.topic.slice(0, 30)}`);

      // キャンセル意図の検出
      if (isCancelIntent(text)) {
        cancelConversation(activeDevConv.id);
        dbLog('info', 'webhook', '開発キャンセル');
        await sendLineMessage(userId, '開発を中止しました。');
        return;
      }

      // フェーズ別ルーティング
      if (activeDevConv.status === 'hearing') {
        // 明らかに無関係なメッセージは通常応答にフォールスルー
        if (isOffTopic(text)) {
          dbLog('info', 'webhook', 'hearing中だが無関係 → 通常応答');
          // フォールスルー
        } else {
          dbLog('info', 'webhook', 'ルーティング → 開発ヒアリング');
          await devAgent.handleMessage(userId, text);
          return;
        }
      } else if (activeDevConv.status === 'defining') {
        if (isDefiningResponse(text)) {
          dbLog('info', 'webhook', 'ルーティング → 開発要件定義');
          await devAgent.handleMessage(userId, text);
          return;
        }
        dbLog('info', 'webhook', 'defining中だが無関係 → 通常応答');
        // フォールスルー
      } else {
        // implementing/testing/approved → 通常応答にフォールスルー
        dbLog('info', 'webhook', `${activeDevConv.status}中 → 通常応答`);
      }
    }
  }

  // 新規開発依頼
  if (/開発して|実装して|母艦に.*追加して|新しいエージェントを作って|機能を追加して/.test(text)) {
    dbLog('info', 'webhook', 'ルーティング → 新規開発依頼');
    await devAgent.handleMessage(userId, text);
    return;
  }

  // --- 通常の会話 ---
  saveMessage(userId, 'user', text);
  dbLog('info', 'webhook', 'ルーティング → 通常応答');

  try {
    const systemContext = await gatherSystemContext();

    // 開発進行中ならその情報も渡す
    const devInfo = activeDevConv
      ? `\n## 進行中の開発\nトピック: ${activeDevConv.topic}\n状態: ${activeDevConv.status}`
      : '';

    const response = await generateResponse(text, {
      systemStatus: systemContext,
      rawContext: devInfo || undefined,
    }, userId);

    if (response.trim() === 'DEV_AGENT') {
      dbLog('info', 'webhook', 'Claude判定 → DEV_AGENT');
      await devAgent.handleMessage(userId, text);
      return;
    }

    const needsTask = await shouldCreateTask(text);

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

/** キャンセル意図の検出（広めに） */
function isCancelIntent(text: string): boolean {
  return /開発(キャンセル|中止|やめ)|やめて|やめる|キャンセル|別の話|もういい|いらない|中断|ストップ|stop/i.test(text);
}

/** 開発と明らかに無関係なメッセージ */
function isOffTopic(text: string): boolean {
  // 挨拶・雑談・システム状況確認
  if (/^(おはよう|こんにちは|こんばんは|お疲れ|ありがとう|おつかれ|ただいま|hi|hello)/i.test(text)) return true;
  if (/予算|コスト|ダッシュボード|タスク(状況|一覧)|ログ|状態|ステータス/.test(text)) return true;
  if (/天気|ニュース|今日|明日/.test(text)) return true;
  return false;
}

/** defining フェーズへの応答か */
function isDefiningResponse(text: string): boolean {
  if (/^(ok|OK|Ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで)$/i.test(text.trim())) return true;
  if (/変えて|修正して|追加して|削除して|不要|変更して|直して|ここを|要件/.test(text)) return true;
  return false;
}

function shouldCreateTask(userMessage: string): boolean {
  return /分析して|最適化して|チェックして|レポート|調べて|改善して|提案して|比較して|監査して|スクリプト|自動化/.test(userMessage);
}
