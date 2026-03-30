import { config } from '../config';
import { logger } from '../utils/logger';
import { trackUsage, isOverBudget } from './budgetTracker';

const API_TIMEOUT_MS = 60_000; // 60秒
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 3000]; // 指数バックオフ

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
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
}): Promise<{ text: string; usage: { input: number; output: number } }> {

  if (await isOverBudget()) {
    throw new Error('BUDGET_EXCEEDED: APIの日次または月次予算上限に達しました');
  }

  const model = params.model === 'opus'
    ? config.claude.opusModel
    : config.claude.defaultModel;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] || 3000;
      logger.warn(`Claude API リトライ ${attempt}/${MAX_RETRIES}（${delay}ms待機）`, { model });
      await sleep(delay);
    }

    try {
      logger.info('Claude API呼び出し', { model, taskId: params.taskId, attempt });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.claude.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: params.maxTokens || 4096,
            system: params.system || undefined,
            messages: params.messages,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => '(response body unreadable)');

        if (isRetryable(response.status) && attempt < MAX_RETRIES) {
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

      return { text, usage };

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(`Claude API タイムアウト（${API_TIMEOUT_MS / 1000}秒）`);
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
