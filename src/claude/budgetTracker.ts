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
  try {
    const cost = calcCost(model, inputTokens, outputTokens);
    const db = getDB();
    await db.prepare(`
      INSERT INTO api_usage (model, input_tokens, output_tokens, cost_usd, task_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(model, inputTokens, outputTokens, cost, taskId || null);
  } catch (err) {
    logger.error('API使用量記録失敗', { model, err });
  }
}

export async function getDailySpend(): Promise<number> {
  const db = getDB();
  const row = await db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM api_usage
    WHERE created_at::date = CURRENT_DATE
  `).get() as { total: number };
  return row.total;
}

export async function getMonthlySpend(): Promise<number> {
  const db = getDB();
  const row = await db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM api_usage
    WHERE date_trunc('month', created_at) = date_trunc('month', NOW())
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

/** 週間使用量 */
export async function getWeeklySpend(): Promise<number> {
  const db = getDB();
  const row = await db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM api_usage
    WHERE created_at >= NOW() - INTERVAL '7 days'
  `).get() as { total: number };
  return row.total;
}

/** 今月のモデル別内訳 */
export async function getMonthlyBreakdown(): Promise<string> {
  const db = getDB();
  const byModel = await db.prepare(`
    SELECT model,
           COALESCE(SUM(cost_usd), 0) as total,
           COUNT(*) as calls
    FROM api_usage
    WHERE date_trunc('month', created_at) = date_trunc('month', NOW())
    GROUP BY model
    ORDER BY total DESC
  `).all() as Array<{ model: string; total: number; calls: number }>;

  if (byModel.length === 0) return '今月のAPI呼び出しはまだありません。';

  const monthlyTotal = byModel.reduce((sum, r) => sum + r.total, 0);
  return byModel.map(r => {
    const shortModel = r.model.includes('opus') ? 'Opus' : 'Sonnet';
    const pct = monthlyTotal > 0 ? ((r.total / monthlyTotal) * 100).toFixed(1) : '0';
    return `  ${shortModel}: $${r.total.toFixed(2)} (${pct}%) [${r.calls}回]`;
  }).join('\n');
}

/** 詳細レポート（LINEコマンド用） */
export async function getDetailedBudgetReport(): Promise<string> {
  const daily = await getDailySpend();
  const weekly = await getWeeklySpend();
  const monthly = await getMonthlySpend();
  const breakdown = await getMonthlyBreakdown();
  const budget = config.claude.monthlyBudgetUsd;
  const pct = budget > 0 ? ((monthly / budget) * 100).toFixed(1) : '0';

  return [
    `📊 API使用量`,
    ``,
    `今日: $${daily.toFixed(2)}`,
    `今週: $${weekly.toFixed(2)}`,
    `今月: $${monthly.toFixed(2)} / $${budget.toFixed(0)} (${pct}%)`,
    ``,
    `内訳（今月）:`,
    breakdown,
  ].join('\n');
}

/** 予算アラートチェック（定期実行用） */
export async function checkBudgetAlerts(): Promise<string | null> {
  const monthly = await getMonthlySpend();
  const budget = config.claude.monthlyBudgetUsd;
  const pct = budget > 0 ? (monthly / budget) * 100 : 0;

  if (pct >= 100) {
    return `API予算上限到達 ($${monthly.toFixed(2)}/$${budget.toFixed(0)})。開発エージェントの新規実行を停止します。`;
  } else if (pct >= 80) {
    return `API予算80%到達 ($${monthly.toFixed(2)}/$${budget.toFixed(0)})。残り$${(budget - monthly).toFixed(2)}です。`;
  }
  return null;
}
