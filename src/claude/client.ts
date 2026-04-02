import { config } from '../config';
import { logger } from '../utils/logger';
import { trackUsage, isOverBudget } from './budgetTracker';

const API_TIMEOUT_MS = 60_000; // 60秒（デフォルト）
const OPUS_TIMEOUT_MS = 120_000; // Opusは応答が遅いため120秒
const MAX_RETRIES = 4;
const RETRY_DELAYS = [2000, 5000, 15000, 30000]; // 通常リトライ
const OVERLOAD_RETRY_DELAYS = [5000, 15000, 45000, 90000]; // 529（サーバー過負荷）専用: より長いバックオフ

// ── メッセージ型定義 ──

/** テキストのみのcontent */
interface TextContent {
  type: 'text';
  text: string;
}

/** 画像（base64）のcontent */
interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string; // base64エンコード済み
  };
}

type ContentBlock = TextContent | ImageContent;

/** messagesの1エントリ。contentがstringならテキストのみ、配列なら複合（テキスト+画像） */
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  stop_reason?: string;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function callClaude(params: {
  messages: ClaudeMessage[];
  system?: string;
  model?: 'default' | 'opus';
  maxTokens?: number;
  taskId?: string;
  timeoutMs?: number;
  /** web_searchツールを有効にする */
  enableWebSearch?: boolean;
  /** 拡張思考を有効にする（Quiet-STaR代替: PM/レビュアーの重要判断用） */
  enableThinking?: boolean;
  /** 拡張思考のトークン予算（デフォルト: 5000） */
  thinkingBudget?: number;
}): Promise<{ text: string; thinking?: string; usage: { input: number; output: number } }> {

  if (await isOverBudget()) {
    throw new Error('BUDGET_EXCEEDED: APIの日次または月次予算上限に達しました');
  }

  const model = params.model === 'opus'
    ? config.claude.opusModel
    : config.claude.defaultModel;

  // Opusモデルはデフォルトで長めのタイムアウトを使用
  const defaultTimeout = params.model === 'opus' ? OPUS_TIMEOUT_MS : API_TIMEOUT_MS;

  // web_searchツール
  const tools = params.enableWebSearch
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
    : undefined;

  let lastError: Error | null = null;
  let retryDelayOverride: number | null = null;
  let lastStatus: number | null = null; // 直前のHTTPステータス（529判定用）

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 529(overloaded)は専用の長いバックオフを使う
      const baseDelays = lastStatus === 529 ? OVERLOAD_RETRY_DELAYS : RETRY_DELAYS;
      const delay = retryDelayOverride || baseDelays[attempt - 1] || 3000;
      retryDelayOverride = null; // 使用後リセット
      logger.warn(`Claude API リトライ ${attempt}/${MAX_RETRIES}（${delay}ms待機, status=${lastStatus}）`, { model });
      await sleep(delay);
    }

    try {
      logger.info('Claude API呼び出し', { model, taskId: params.taskId, attempt, webSearch: !!params.enableWebSearch });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs || defaultTimeout);

      const body: Record<string, unknown> = {
        model,
        max_tokens: params.maxTokens || 4096,
        system: params.system || undefined,
        messages: params.messages,
      };
      if (tools) {
        body.tools = tools;
      }
      if (params.enableThinking) {
        body.thinking = { type: 'enabled', budget_tokens: params.thinkingBudget || 5000 };
        body.temperature = 1; // 拡張思考使用時はtemperature=1が必須
      }

      let response: Response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.claude.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '(response body unreadable)');

        if (isRetryable(response.status) && attempt < MAX_RETRIES) {
          lastStatus = response.status;
          // Retry-Afterヘッダーがあればそちらを優先（ローカル変数で上書き、定数は汚染しない）
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter && response.status === 429) {
            const waitSec = parseInt(retryAfter, 10);
            if (!isNaN(waitSec) && waitSec > 0 && waitSec <= 120) {
              retryDelayOverride = waitSec * 1000;
            }
          }
          logger.warn('Claude API リトライ可能エラー', { status: response.status, errBody: errBody.slice(0, 200) });
          lastError = new Error(`Claude API ${response.status}: ${errBody.slice(0, 500)}`);
          continue;
        }

        logger.error('Claude API error', { status: response.status, err: errBody.slice(0, 500), model });
        throw new Error(`Claude API ${response.status}: ${errBody.slice(0, 500)}`);
      }

      let data: ClaudeResponse;
      try {
        data = await response.json() as ClaudeResponse;
      } catch (parseErr) {
        throw new Error(`Claude API レスポンスのJSONパース失敗: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }

      if (!data.content || !Array.isArray(data.content)) {
        throw new Error(`Claude API レスポンス形式が不正: content配列がありません`);
      }

      // 拡張思考のthinkingブロックを抽出（存在する場合）
      const thinkingBlock = data.content.find(c => c.type === 'thinking');
      const thinking = thinkingBlock && 'thinking' in thinkingBlock
        ? (thinkingBlock as { type: string; thinking: string }).thinking
        : undefined;

      const text = data.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!)
        .join('\n');

      if (!text) {
        throw new Error('Claude API: テキスト応答が空です');
      }

      const usage = {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
      };

      await trackUsage(model, usage.input, usage.output, params.taskId);

      return { text, thinking, usage };

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(`Claude API タイムアウト（${(params.timeoutMs || defaultTimeout) / 1000}秒）`);
        if (attempt < MAX_RETRIES) {
          logger.warn('Claude API タイムアウト → リトライ', { attempt });
          continue;
        }
      }

      // リトライ不可のエラー or 最終試行
      if (attempt >= MAX_RETRIES) {
        throw lastError || err;
      }

      // 予算超過やパースエラーはリトライしない
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('BUDGET_EXCEEDED') || errMsg.includes('パース') || errMsg.includes('形式が不正')) {
        throw err;
      }

      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError || new Error('Claude API: 予期しないリトライループ終了');
}
