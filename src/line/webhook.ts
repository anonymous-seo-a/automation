import { Router, Request, Response } from 'express';
import * as line from '@line/bot-sdk';
import { config } from '../config';
import { isAuthorizedUser } from './auth';
import { sendLineMessage } from './sender';
import { interpretTask } from '../interpreter/taskInterpreter';
import { enqueueTask } from '../queue/taskQueue';
import { getActiveConversation, cancelConversation, getConversation } from '../agents/dev/conversation';
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

/** 脱出意図の検出（最優先で処理） */
function wantsToExit(text: string): boolean {
  return /リセット|reset|キャンセル|やめ|中止|中断|ストップ|stop|もういい|いらない|別の話|終わり|終了/i.test(text);
}

async function handleMessage(userId: string, text: string): Promise<void> {
  if (text === 'ping') {
    await sendLineMessage(userId, 'pong');
    return;
  }

  const activeDevConv = getActiveConversation(userId);

  // ★ 脱出チェック（最優先）
  if (activeDevConv && wantsToExit(text)) {
    cancelConversation(activeDevConv.id);
    dbLog('info', 'webhook', `開発脱出: "${text}" → conv ${activeDevConv.id} をキャンセル`);
    await sendLineMessage(userId, '開発を中止しました。何でも聞いてください。');
    return;
  }

  // ★ defining フェーズ: OKか修正指示のみdevへ
  if (activeDevConv && activeDevConv.status === 'defining') {
    if (isDefiningResponse(text)) {
      dbLog('info', 'webhook', `ルーティング → defining応答: "${text.slice(0, 20)}"`);
      await devAgent.handleMessage(userId, text);
      return;
    }
    dbLog('info', 'webhook', 'defining中だが無関係 → 通常応答');
  }

  // ★ hearing フェーズ: responderに判断を委ねる（後述のDEV_AGENTトリガー経由）
  // hearing中のメッセージはauto-captureしない。代わりにresponderが文脈を見て判断。

  // ★ 新規開発依頼
  if (!activeDevConv && /開発して|実装して|母艦に.*追加して|新しいエージェントを作って|機能を追加して/.test(text)) {
    dbLog('info', 'webhook', 'ルーティング → 新規開発依頼');
    await devAgent.handleMessage(userId, text);
    return;
  }

  // --- 通常応答（hearing中もここを通る） ---
  saveMessage(userId, 'user', text);
  dbLog('info', 'webhook', 'ルーティング → 通常応答');

  try {
    const systemContext = await gatherSystemContext();

    // 進行中の開発情報をコンテキストに含める
    let devContext = '';
    if (activeDevConv) {
      devContext = `\n## 進行中の開発\nトピック: ${activeDevConv.topic}\n状態: ${activeDevConv.status}`;
      if (activeDevConv.status === 'hearing') {
        // 直近のエージェントの質問を含めてresponderに判断材料を与える
        try {
          const log = JSON.parse(activeDevConv.hearing_log) as Array<{ role: string; message: string }>;
          const lastAgentMsg = [...log].reverse().find(e => e.role === 'agent');
          if (lastAgentMsg) {
            devContext += `\nエージェントの最後の質問:\n${lastAgentMsg.message}`;
          }
        } catch { /* ignore */ }
        devContext += '\n\nユーザーのメッセージがこの開発への回答であれば "DEV_AGENT" と返してください。無関係な話題なら普通に回答してください。';
      }
    }

    const response = await generateResponse(text, {
      systemStatus: systemContext,
      rawContext: devContext || undefined,
    }, userId);

    // DEV_AGENT トリガー
    if (response.trim() === 'DEV_AGENT') {
      dbLog('info', 'webhook', 'responder判定 → DEV_AGENT');
      await devAgent.handleMessage(userId, text);
      return;
    }

    // タスク実行判定
    if (shouldCreateTask(text)) {
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

function isDefiningResponse(text: string): boolean {
  if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで)$/i.test(text.trim())) return true;
  if (/変えて|修正して|追加して|削除して|不要|変更して|直して|ここを|要件/.test(text)) return true;
  return false;
}

function shouldCreateTask(userMessage: string): boolean {
  return /分析して|最適化して|チェックして|レポート|調べて|改善して|提案して|比較して|監査して|スクリプト|自動化/.test(userMessage);
}
