import { Router, Request, Response } from 'express';
import * as line from '@line/bot-sdk';
import { config } from '../config';
import { isAuthorizedUser } from './auth';
import { sendLineMessage } from './sender';
import { interpretTask } from '../interpreter/taskInterpreter';
import { enqueueTask, getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { getActiveConversation } from '../agents/dev/conversation';
import { DevAgent } from '../agents/dev/devAgent';
import { logger } from '../utils/logger';

const devAgent = new DevAgent();

const lineMiddlewareConfig = {
  channelSecret: config.line.channelSecret,
};

export const webhookRouter = Router();

webhookRouter.post(
  '/',
  line.middleware(lineMiddlewareConfig) as any,
  async (req: Request, res: Response) => {
    // LINE には即座に200を返す
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
        await handleMessage(userId, text);
      }
    } catch (err) {
      logger.error('Webhook処理エラー', { err });
    }
  }
);

async function handleMessage(userId: string, text: string): Promise<void> {
  // 特殊コマンド
  if (text === '状況' || text === 'status') {
    const report = getStatusReport();
    await sendLineMessage(userId, report);
    return;
  }

  if (text === '予算' || text === 'budget') {
    const report = await getBudgetReport();
    await sendLineMessage(userId, report);
    return;
  }

  if (text === 'ping') {
    await sendLineMessage(userId, 'pong 🏓 母艦稼働中');
    return;
  }

  // 開発キャンセル
  if (/^(開発キャンセル|開発中止)$/.test(text)) {
    await devAgent.handleMessage(userId, text);
    return;
  }

  // 開発エージェントへの分岐
  const activeDevConv = getActiveConversation(userId);
  if (activeDevConv) {
    // 進行中の開発会話がある場合は全メッセージをdevAgentに転送
    await devAgent.handleMessage(userId, text);
    return;
  }

  const isDevRequest = /開発して|実装して|母艦に.*追加して|新しいエージェントを作って|機能を追加して/.test(text);
  if (isDevRequest) {
    await devAgent.handleMessage(userId, text);
    return;
  }

  // 通常の指示 → タスク解釈
  await sendLineMessage(userId, '📋 指示を受け付けました。解析中...');

  try {
    const interpreted = await interpretTask(text);

    if (interpreted.confirmation_needed) {
      await sendLineMessage(userId,
        `❓ 確認が必要です:\n${interpreted.clarification_question}`
      );
      return;
    }

    if (interpreted.estimated_api_calls > 50) {
      await sendLineMessage(userId,
        `⚠️ 推定API呼び出し: ${interpreted.estimated_api_calls}回\n` +
        `コスト増の可能性があります。実行しますか？（「実行」と送信）`
      );
      return;
    }

    for (const task of interpreted.tasks) {
      enqueueTask(task);
    }

    await sendLineMessage(userId,
      `✅ ${interpreted.tasks.length}件のタスクをキューに追加しました。\n` +
      `完了次第LINEで報告します。`
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('タスク解釈エラー', { err: errMsg, text });
    await sendLineMessage(userId,
      `❌ 指示の解析に失敗しました:\n${errMsg.slice(0, 300)}`
    );
  }
}
