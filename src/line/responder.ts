import { callClaude, ClaudeMessage } from '../claude/client';
import { getStatusReport } from '../queue/taskQueue';
import { getBudgetReport } from '../claude/budgetTracker';
import { getRecentHistory } from './messageHistory';
import { buildSmartContext } from '../memory/store';
import { buildBunshinPrompt } from './bunshinPrompt';
import { buildSelfAwarenessContext } from '../github/client';
import { buildDevHistorySummary } from '../agents/dev/conversation';
import { config } from '../config';
import { logger } from '../utils/logger';

/** 開発に関する質問か判定（過去開発履歴を注入するため） */
function isDevRelatedQuery(text: string): boolean {
  const keywords = [
    '何作った', '何を作った', '何開発した', '何を開発した',
    '最近の開発', '開発履歴', '開発実績', '過去の開発',
    '前に作った', '前作った', '作ったもの', '開発したもの',
    '何を実装', '何実装した', '実装一覧', '機能一覧',
    'どんな機能', 'どの機能', '何がある', '何ができ',
  ];
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/** ユーザーがシステム自身について質問しているか判定 */
function isSelfReferentialQuery(text: string): boolean {
  const keywords = [
    '母艦', 'システム', 'ボット', 'bot',
    'あなた', 'お前', '君',
    '機能', 'できること', '何ができ',
    '最新', 'アップデート', '更新', '変更',
    'バージョン', 'コミット', 'commit',
    '開発状況', '実装', 'ステータス', 'status',
    '自分', '自己紹介', 'github', 'GitHub',
  ];
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

export interface ResponderContext {
  systemStatus?: string;
  budgetReport?: string;
  taskResult?: { description: string; output: string; execResult?: string };
  errorInfo?: { description: string; error: string; retryCount?: number; maxRetries?: number };
  rawContext?: string;
}

export interface ImageData {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export async function generateResponse(
  userMessage: string,
  context?: ResponderContext,
  userId?: string,
  image?: ImageData,
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
    const messages: ClaudeMessage[] = [];

    if (userId) {
      const history = getRecentHistory(userId);
      for (const msg of history) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // 現在のメッセージを追加（画像がある場合は複合contentブロック）
    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: userMessage },
        ],
      });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    // 記憶コンテキストを追加（意味検索で関連記憶のみ注入）
    let memoryContext = '';
    if (userId) {
      try {
        memoryContext = await buildSmartContext(userId, userMessage);
      } catch (err) {
        logger.warn('スマートコンテキスト構築失敗', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    // 自己参照的な質問にはGitHub情報を注入
    if (isSelfReferentialQuery(userMessage)) {
      try {
        const selfContext = await buildSelfAwarenessContext();
        contextBlock += `\n${selfContext}`;
      } catch (err) {
        logger.warn('GitHub自己認識コンテキスト取得失敗', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    // 開発に関する質問には過去開発履歴を注入
    if (isDevRelatedQuery(userMessage)) {
      const devHistory = buildDevHistorySummary(10);
      if (devHistory) {
        contextBlock += `\n${devHistory}`;
      }
    }

    // 分身プロンプト構築（ナレッジ + 記憶を注入）
    const systemPrompt = buildBunshinPrompt(memoryContext) + contextBlock;

    const { text } = await callClaude({
      system: systemPrompt,
      messages,
      model: 'default',
      enableWebSearch: true,
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
