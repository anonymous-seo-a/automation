import { callClaude } from '../claude/client';
import { getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { getRecentHistory } from './messageHistory';
import { buildMemoryContext } from './memory';
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
- 会話の記憶（プロフィール・プロジェクト・メモを自動/手動で記憶）
- 雑談、相談、何でも

## 記憶機能
あなたには記憶機能がある。システムプロンプトの末尾にユーザーの記憶情報が含まれている場合、それを活用して会話する。
- ユーザーが「覚えて: 〇〇」と送ると明示的にメモ保存される
- 「何覚えてる？」で記憶一覧を表示
- 「忘れて: 〇〇」で記憶を削除
- 会話からプロフィールやプロジェクト情報が自動的に記憶される
記憶機能について聞かれたら、上記の使い方を教えてあげる。

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

    // 記憶コンテキストを追加
    let memoryBlock = '';
    if (userId) {
      memoryBlock = buildMemoryContext(userId);
    }

    const { text } = await callClaude({
      system: RESPONDER_PROMPT + memoryBlock + contextBlock,
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

/** 会話から自動で記憶すべき情報を抽出 */
export async function extractMemories(
  userId: string,
  userMessage: string,
  assistantResponse: string
): Promise<void> {
  try {
    const { saveMemory } = await import('./memory');

    const { text } = await callClaude({
      system: `あなたは会話から重要な情報を抽出するアナリストです。
以下のJSON形式で、記憶すべき情報があれば返してください。なければ空配列を返してください。

[{"type": "profile"|"project", "key": "簡潔なキー名", "content": "記憶する内容"}]

## 抽出基準
- profile: ユーザーの名前、職業、好み、スキル、関心事など個人情報
- project: 進行中のプロジェクト、目標、締切、技術的な決定事項

## ルール
- 雑談や挨拶からは抽出しない
- 既に明らかな事実（「はい」「了解」等）は記憶しない
- JSON配列のみ返す。説明文は不要`,
      messages: [
        { role: 'user', content: `ユーザー: ${userMessage}\nアシスタント: ${assistantResponse}` },
      ],
      model: 'default',
      maxTokens: 500,
    });

    const memories = JSON.parse(text) as Array<{ type: 'profile' | 'project'; key: string; content: string }>;
    if (!Array.isArray(memories)) return;

    for (const mem of memories) {
      if (mem.type && mem.key && mem.content) {
        saveMemory(userId, mem.type, mem.key, mem.content);
        logger.info('自動記憶保存', { userId, type: mem.type, key: mem.key });
      }
    }
  } catch (err) {
    // 自動記憶の失敗は致命的ではないのでログだけ
    logger.debug('自動記憶抽出スキップ', { err: err instanceof Error ? err.message : String(err) });
  }
}
