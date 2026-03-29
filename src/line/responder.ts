import { callClaude } from '../claude/client';
import { getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { config } from '../config';
import { logger } from '../utils/logger';

const RESPONDER_PROMPT = `あなたは「母艦」という名前のAIアシスタントです。
LINEを通じてユーザーと会話しています。

## 性格・トーン
- 簡潔で的確。余計な前置きや敬語の過剰使用はしない
- 親しみやすいが、ビジネスパートナーとしての距離感
- ユーザーは忙しいので、要点を先に伝える
- 絵文字は控えめに、要所で使う

## あなたの機能
- SEOサイト（soico.jp/no1/）の最適化・分析（soicoエージェント）
- 母艦システム自体の開発・拡張（devエージェント）
- タスクの管理・状況確認
- API予算の管理

## コンテキスト情報
ユーザーのメッセージに応じて、以下のシステム情報が提供されます。
この情報を使って自然な会話で回答してください。

## 管理ダッシュボード
詳細な情報は ${config.admin.baseUrl}/admin で確認できます。

## 回答ルール
- 長い分析結果がある場合は3行以内に要約し、「詳細はダッシュボードで確認できます」と付ける
- タスクの実行結果は、ユーザーにとって意味のある部分だけを伝える
- エラーが発生した場合は、ユーザーが次に何をすべきかを明確に伝える
- 開発依頼（「開発して」「実装して」「母艦に機能を追加して」等）は、あなたが直接対応せず "DEV_AGENT" とだけ返す
- 分からない質問には正直に分からないと言う`;

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
      contextBlock += `\n## タスク実行結果\nタスク: ${context.taskResult.description}\n出力:\n${context.taskResult.output.slice(0, 2000)}`;
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

    const { text } = await callClaude({
      system: RESPONDER_PROMPT + contextBlock,
      messages: [{ role: 'user', content: userMessage }],
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
