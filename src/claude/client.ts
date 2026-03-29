import { config } from '../config';
import { logger } from '../utils/logger';
import { trackUsage, isOverBudget } from './budgetTracker';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
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

  logger.info('Claude API呼び出し', { model, taskId: params.taskId });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error('Claude API error', { status: response.status, err, model });
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data: ClaudeResponse = await response.json();

  const text = data.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n');

  const usage = {
    input: data.usage.input_tokens,
    output: data.usage.output_tokens,
  };

  await trackUsage(model, usage.input, usage.output, params.taskId);

  return { text, usage };
}
