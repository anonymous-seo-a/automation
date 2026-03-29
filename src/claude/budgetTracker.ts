import { getDB } from '../db/database';
import { config } from '../config';
import { logger } from '../utils/logger';

// 料金テーブル（USD per 1M tokens）- 2026年3月最新
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6-20260312': { input: 3, output: 15 },
  'claude-opus-4-6-20260312': { input: 5, output: 25 },
  // フォールバック（エイリアスでの呼び出し時）
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 5, output: 25 },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6-20260312'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export async function trackUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  taskId?: string
): Promise<void> {
  const cost = calcCost(model, inputTokens, outputTokens);
  const db = getDB();
  db.prepare(`
    INSERT INTO api_usage (model, input_tokens, output_tokens, cost_usd, task_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(model, inputTokens, outputTokens, cost, taskId || null);
}

export async function getDailySpend(): Promise<number> {
  const db = getDB();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM api_usage
    WHERE date(created_at) = date('now')
  `).get() as { total: number };
  return row.total;
}

export async function getMonthlySpend(): Promise<number> {
  const db = getDB();
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM api_usage
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get() as { total: number };
  return row.total;
}

export async function isOverBudget(): Promise<boolean> {
  const daily = await getDailySpend();
  const monthly = await getMonthlySpend();
  const over = daily >= config.claude.dailyBudgetUsd
    || monthly >= config.claude.monthlyBudgetUsd;
  if (over) {
    logger.warn('Budget exceeded', { daily, monthly });
  }
  return over;
}

export async function getBudgetReport(): Promise<string> {
  const daily = await getDailySpend();
  const monthly = await getMonthlySpend();
  return [
    `💰 API使用状況`,
    `本日: $${daily.toFixed(4)} / $${config.claude.dailyBudgetUsd}`,
    `今月: $${monthly.toFixed(4)} / $${config.claude.monthlyBudgetUsd}`,
    ``,
    `📊 モデル別料金 (per 1M tokens)`,
    `Sonnet 4.6: $3 (入力) / $15 (出力)`,
    `Opus 4.6: $5 (入力) / $25 (出力)`,
  ].join('\n');
}
