import { callClaude } from '../claude/client';
import { getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { getRecentHistory } from './messageHistory';
import { buildSmartContext } from '../memory/store';
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

    // 記憶コンテキストを追加（意味検索で関連記憶のみ注入）
    let memoryBlock = '';
    if (userId) {
      try {
        memoryBlock = await buildSmartContext(userId, userMessage);
      } catch (err) {
        logger.warn('スマートコンテキスト構築失敗', { err: err instanceof Error ? err.message : String(err) });
      }
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
    const { saveMemoryWithEmbedding } = await import('../memory/store');

    const { text } = await callClaude({
      system: `会話からユーザーに関する情報を抽出してJSON配列で返してください。

出力形式（JSON配列のみ。説明文不要）:
[{"type":"profile","key":"キー名","content":"内容"}]

type:
- profile: 名前、職業、スキル、好み、関心事、性格
- project: 取り組んでいるプロジェクト、目標、技術スタック、サービス名

抽出ルール:
- 少しでもユーザーの人物像やプロジェクトに関する情報があれば積極的に抽出する
- 「こんにちは」だけ等、本当に何も情報がない場合のみ [] を返す
- keyは日本語で短く（例: "職業", "関心事", "プロジェクト名"）
- 1つの会話から複数抽出してよい`,
      messages: [
        { role: 'user', content: `ユーザー: ${userMessage}\nアシスタント: ${assistantResponse}` },
      ],
      model: 'default',
      maxTokens: 500,
    });

    logger.info('自動記憶抽出結果', { raw: text.slice(0, 200) });

    // JSONパース（マークダウンコードブロック対応）
    let jsonStr = text.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrMatch) jsonStr = arrMatch[0];

    const memories = JSON.parse(jsonStr) as Array<{ type: 'profile' | 'project'; key: string; content: string }>;
    if (!Array.isArray(memories)) return;

    for (const mem of memories) {
      if (mem.type && mem.key && mem.content) {
        await saveMemoryWithEmbedding(userId, mem.type, mem.key, mem.content);
        logger.info('自動記憶保存', { userId, type: mem.type, key: mem.key });
      }
    }
  } catch (err) {
    logger.warn('自動記憶抽出失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}
