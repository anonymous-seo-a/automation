import { Router, Request, Response } from 'express';
import * as line from '@line/bot-sdk';
import { config } from '../config';
import { isAuthorizedUser } from './auth';
import { sendLineMessage } from './sender';
import { interpretTask } from '../interpreter/taskInterpreter';
import { enqueueTask } from '../queue/taskQueue';
import { getActiveConversation } from '../agents/dev/conversation';
import { DevAgent } from '../agents/dev/devAgent';
import { generateResponse, gatherSystemContext } from './responder';
import { saveMessage } from './messageHistory';
import { callClaude } from '../claude/client';
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

// ping だけはAPI不要のヘルスチェックとして残す
async function handleMessage(userId: string, text: string): Promise<void> {
  if (text === 'ping') {
    await sendLineMessage(userId, 'pong 🏓');
    return;
  }

  // 開発エージェントへの分岐
  const activeDevConv = getActiveConversation(userId);

  if (activeDevConv) {
    // 開発キャンセル（自然な表現にも対応）
    if (/開発(キャンセル|中止|やめ)|やめて|やめる|キャンセル/.test(text)) {
      await devAgent.handleMessage(userId, text);
      return;
    }

    // hearing/defining フェーズ: メッセージが開発の文脈かどうかをClaudeに判定させる
    if (activeDevConv.status === 'hearing' || activeDevConv.status === 'defining') {
      const isDevRelated = await isRelatedToDevConversation(text, activeDevConv.topic);
      if (isDevRelated) {
        await devAgent.handleMessage(userId, text);
        return;
      }
      // 開発と無関係 → 通常応答にフォールスルー
    } else if (activeDevConv.status === 'implementing' || activeDevConv.status === 'testing' || activeDevConv.status === 'approved') {
      // 実装中は状況を伝えつつ、通常応答にもフォールスルー
      // devAgentに渡すと「実装中です」しか返さないので、通常応答で柔軟に対応
    }
  }

  const isDevRequest = /開発して|実装して|母艦に.*追加して|新しいエージェントを作って|機能を追加して/.test(text);
  if (isDevRequest) {
    await devAgent.handleMessage(userId, text);
    return;
  }

  // ユーザーのメッセージを履歴に保存
  saveMessage(userId, 'user', text);

  // 全てのメッセージをClaude経由で処理
  try {
    // システム状況を収集
    const systemContext = await gatherSystemContext();

    // Claudeで意図を判定しつつ自然な応答を生成（会話履歴付き）
    const response = await generateResponse(text, {
      systemStatus: systemContext,
    }, userId);

    // DEV_AGENT トリガーの場合（Claudeが開発依頼と判断）
    if (response.trim() === 'DEV_AGENT') {
      await devAgent.handleMessage(userId, text);
      return;
    }

    // タスク実行が必要か判定
    const needsTask = await shouldCreateTask(text, response);

    if (needsTask) {
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
      // タスク不要 → そのまま応答
      await sendLineMessage(userId, response);
      saveMessage(userId, 'assistant', response);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('メッセージ処理エラー', { err: errMsg, text });

    const errorResponse = await generateResponse(
      `エラーが発生しました: ${errMsg.slice(0, 200)}`,
      { rawContext: 'エラーをユーザーに伝え、次に何をすべきか提案してください。' },
      userId,
    ).catch(() => `エラーが発生しました。ダッシュボードで詳細を確認してください: ${config.admin.baseUrl}/admin`);

    await sendLineMessage(userId, errorResponse);
    saveMessage(userId, 'assistant', errorResponse);
  }
}

async function shouldCreateTask(userMessage: string, aiResponse: string): Promise<boolean> {
  const actionKeywords = /分析して|最適化して|チェックして|レポート|調べて|改善して|提案して|比較して|監査して|スクリプト|自動化/;
  return actionKeywords.test(userMessage);
}

async function isRelatedToDevConversation(message: string, topic: string): Promise<boolean> {
  try {
    const { text } = await callClaude({
      system: `ユーザーのメッセージが、進行中の開発会話（トピック: 「${topic}」）への返答かどうか判定してください。
開発への返答・質問・指示なら "YES"、全く別の話題なら "NO" とだけ返してください。`,
      messages: [{ role: 'user', content: message }],
      model: 'default',
      maxTokens: 8,
    });
    return text.trim().toUpperCase().includes('YES');
  } catch {
    // 判定失敗時は開発会話として扱う（安全側）
    return true;
  }
}
