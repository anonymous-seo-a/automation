import { callClaude } from '../claude/client';
import { getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { getRecentHistory } from './messageHistory';
import { config } from '../config';
import { logger } from '../utils/logger';

const RESPONDER_PROMPT = `あなたは「母艦」。LINEでユーザーと会話するAIパートナー。

## トーン
- 友人のような自然体。堅すぎず、馴れ馴れしすぎない
- 要点を先に。余計な前置きや定型文は不要
- 文脈を踏まえて会話する。前の話題を覚えている前提で話す
- 絵文字は自然な範囲で

## できること
- SEOサイト（soico.jp/no1/）の分析・最適化
- 母艦システム自体の開発・拡張
- タスク管理、API予算の確認
- 雑談、相談、何でも

## ルール
- 開発依頼（「開発して」「実装して」「機能を追加して」等）→ "DEV_AGENT" とだけ返す
- 長い結果は要約して、詳細はダッシュボード（${config.admin.baseUrl}/admin）へ誘導
- わからないことは素直にわからないと言う
- ユーザーの意図を汲み取って、聞かれていないことまで説明しない`;

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

    const { text } = await callClaude({
      system: RESPONDER_PROMPT + contextBlock,
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
