import { callClaude } from '../claude/client';
import { getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { getRecentHistory } from './messageHistory';
import { buildSmartContext } from '../memory/store';
import { buildBunshinPrompt } from './bunshinPrompt';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface ResponderContext {
  systemStatus?: string;
  budgetReport?: string;
  taskResult?: { description: string; output: string; execResult?: string };
  errorInfo?: { description: string; error: string; retryCount?: number; maxRetries?: number };
  rawContext?: string;
}

export async function generateResponse(
  userMessage: string,
  context?: ResponderContext,
  userId?: string,
): Promise<string> {
  try {
    let contextBlock = '';

    if (context?.systemStatus) {
      contextBlock += `\n## システム状況\n${context.systemStatus}`;
    }
    if (context?.budgetReport) {
      contextBlock += `\n## 予算状況\n${context.budgetReport}`;
    }
    if (context?.taskResult) {
      const output = (context.taskResult.output || '').slice(0, 2000);
      contextBlock += `\n## タスク実行結果\nタスク: ${context.taskResult.description}\n出力:\n${output}`;
      if (context.taskResult.execResult) {
        contextBlock += `\n実行結果:\n${context.taskResult.execResult.slice(0, 500)}`;
      }
    }
    if (context?.errorInfo) {
      contextBlock += `\n## エラー情報\nタスク: ${context.errorInfo.description}\nエラー: ${context.errorInfo.error}`;
      if (context.errorInfo.retryCount !== undefined) {
        contextBlock += `\nリトライ: ${context.errorInfo.retryCount}/${context.errorInfo.maxRetries}`;
      }
    }
    if (context?.rawContext) {
      contextBlock += `\n## 追加情報\n${context.rawContext}`;
    }

    // 会話履歴を構築
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (userId) {
      const history = getRecentHistory(userId);
      for (const msg of history) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // 現在のメッセージを追加
    messages.push({ role: 'user', content: userMessage });

    // 記憶コンテキストを追加（意味検索で関連記憶のみ注入）
    let memoryContext = '';
    if (userId) {
      try {
        memoryContext = await buildSmartContext(userId, userMessage);
      } catch (err) {
        logger.warn('スマートコンテキスト構築失敗', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    // 分身プロンプト構築（ナレッジ + 記憶を注入）
    const systemPrompt = buildBunshinPrompt(memoryContext) + contextBlock;

    const { text } = await callClaude({
      system: systemPrompt,
      messages,
      model: 'default',
    });

    return text;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Responder エラー', { err: errMsg });
    return `すみません、応答生成でエラーが発生しました。\n詳細はダッシュボードで確認してください: ${config.admin.baseUrl}/admin`;
  }
}

export async function gatherSystemContext(): Promise<string> {
  const status = getStatusReport();
  const budget = await getBudgetReport();
  return `${status}\n\n${budget}`;
}
