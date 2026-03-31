import { getDB } from '../../db/database';
import { callClaude } from '../../claude/client';
import { saveAgentMemory, AgentRole } from './teamMemory';
import { logger } from '../../utils/logger';

/** Daikiの発言からPMへの評価を自動抽出 */
export async function extractDaikiEvaluation(
  userMessage: string, lastTaskDescription?: string
): Promise<void> {
  try {
    const { text } = await callClaude({
      system: `ユーザーの発言が、直前の開発タスクやチーム成果への評価を含んでいるか判定してください。

含んでいる場合:
{"is_evaluation":true,"target":"pm","sentiment":-2〜+2の整数,"aspect":"品質/速度/設計/要件定義/コミュニケーション","summary":"評価の要約"}

含んでいない場合:
{"is_evaluation":false}

JSONのみ出力。`,
      messages: [{ role: 'user', content: `発言: "${userMessage}"\n直前のタスク: "${lastTaskDescription || '不明'}"` }],
      model: 'default',
      maxTokens: 200,
    });

    const parsed = safeParseJson(text);
    if (parsed?.is_evaluation && parsed.target) {
      saveEvaluation('daiki', parsed.target, parsed.sentiment || 0, parsed.aspect, lastTaskDescription, userMessage);
      saveAgentMemory(
        parsed.target as AgentRole, 'evaluation', `daiki_eval_${Date.now()}`,
        `Daiki: ${parsed.summary || userMessage}`, 'daiki_feedback', 4
      );
      logger.info('Daiki評価抽出', { target: parsed.target, sentiment: parsed.sentiment });
    }
  } catch (err) {
    logger.warn('Daiki評価抽出失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** PM -> 配下メンバーの評価（作業結果ベース） */
export async function pmEvaluateByMetrics(
  target: AgentRole, taskId: string, metrics: Record<string, number>
): Promise<void> {
  try {
    const { text } = await callClaude({
      system: `あなたはPMです。以下のメトリクスに基づいてメンバーの作業品質を評価してください。
JSONのみ出力: {"sentiment":-1〜+1の整数,"aspect":"品質/効率/自律性","note":"1文の所感"}`,
      messages: [{ role: 'user', content: `メンバー: ${target}\nメトリクス: ${JSON.stringify(metrics)}` }],
      model: 'default',
      maxTokens: 150,
    });

    const parsed = safeParseJson(text);
    if (parsed) {
      saveEvaluation('pm', target, parsed.sentiment || 0, parsed.aspect, taskId, parsed.note);
      saveAgentMemory(target, 'evaluation', `pm_eval_${Date.now()}`,
        `PM: ${parsed.note || '評価なし'}`, 'pm_evaluation', 3);
    }
  } catch (err) {
    logger.warn('PMメトリクス評価失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** PM -> 配下メンバーの評価（会話ベース） */
export async function pmEvaluateByConversation(
  target: AgentRole, conversation: string
): Promise<void> {
  try {
    const { text } = await callClaude({
      system: `あなたはPMです。相談でのメンバーの振る舞いを評価してください。
JSONのみ出力: {"sentiment":-1〜+1の整数,"aspect":"質問力/判断力/正確性/自律性","note":"1文の所感"}`,
      messages: [{ role: 'user', content: `メンバー: ${target}\n相談内容: ${conversation}` }],
      model: 'default',
      maxTokens: 150,
    });

    const parsed = safeParseJson(text);
    if (parsed) {
      saveEvaluation('pm', target, parsed.sentiment || 0, parsed.aspect, undefined, parsed.note);
    }
  } catch (err) {
    logger.warn('PM会話評価失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** 評価をDBに保存 */
function saveEvaluation(
  evaluator: string, target: string, sentiment: number,
  aspect?: string, context?: string, rawFeedback?: string
): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO agent_evaluations (evaluator, target, sentiment, aspect, context, raw_feedback)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(evaluator, target, sentiment, aspect || null, context || null, rawFeedback || null);
}

/** 直近の評価をプロンプト注入用テキストに変換 */
export function buildEvaluationContext(target: AgentRole): string {
  try {
    const db = getDB();
    const evals = db.prepare(`
      SELECT * FROM agent_evaluations
      WHERE target = ? AND created_at >= datetime('now', '-30 days')
      ORDER BY created_at DESC LIMIT 10
    `).all(target) as Array<{
      evaluator: string; sentiment: number; aspect: string;
      raw_feedback: string; created_at: string;
    }>;

    if (evals.length === 0) return '';

    const positive = evals.filter(e => e.sentiment > 0).length;
    const negative = evals.filter(e => e.sentiment < 0).length;
    const aspects = evals.filter(e => e.aspect).map(e => e.aspect);
    const topAspect = aspects.length > 0 ? mode(aspects) : null;
    const recentFeedback = evals.slice(0, 3)
      .filter(e => e.raw_feedback)
      .map(e => `「${e.raw_feedback.slice(0, 50)}」`);

    let text = `## 評価傾向（直近30日）\nポジティブ: ${positive}件 / ネガティブ: ${negative}件`;
    if (topAspect) text += `\nよく指摘される点: ${topAspect}`;
    if (recentFeedback.length > 0) text += `\n直近の声: ${recentFeedback.join(' / ')}`;
    if (negative > positive) text += '\n→ 品質を特に注意してください。';
    return text;
  } catch (err) {
    logger.warn('評価コンテキスト構築失敗', { target, err: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

/** タスクメトリクスを記録 */
export function recordMetric(
  taskId: string, agent: string, metricType: string, value: number = 1, context?: string
): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO task_metrics (task_id, agent, metric_type, value, context)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, agent, metricType, value, context || null);
}

/** タスクのメトリクスを集計 */
export function getTaskMetricsSummary(taskId: string): Record<string, number> {
  const db = getDB();
  const rows = db.prepare(`
    SELECT metric_type, SUM(value) as total FROM task_metrics WHERE task_id = ? GROUP BY metric_type
  `).all(taskId) as Array<{ metric_type: string; total: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) result[row.metric_type] = row.total;
  return result;
}

function mode(arr: string[]): string {
  const freq: Record<string, number> = {};
  for (const item of arr) freq[item] = (freq[item] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function safeParseJson(text: string): any {
  let s = text.trim();
  const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (m) s = m[1].trim();
  const o = s.match(/\{[\s\S]*\}/);
  if (o) s = o[0];
  try { return JSON.parse(s); } catch { return null; }
}
