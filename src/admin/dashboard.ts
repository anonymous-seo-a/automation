import { Router, Request, Response } from 'express';
import express from 'express';
import { getDB } from '../db/database';
import { config } from '../config';
import { listAgents } from '../agents/router';
import { renderPage } from './views';
import { setupLiveRoutes } from './liveView';
import { memoryMapRouter } from './memoryMap';

export const adminRouter = Router();

// 認証なし（将来必要になったら追加）

adminRouter.use(express.json());

// ライブオフィスビュー
setupLiveRoutes(adminRouter);

// 記憶マインドマップ
adminRouter.use('/memory-map', memoryMapRouter);

// ダッシュボードトップ
adminRouter.get('/', (_req: Request, res: Response) => {
  try {
  const db = getDB();

  const taskCounts = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status
  `).all() as Array<{ status: string; cnt: number }>;

  const recentTasks = db.prepare(`
    SELECT id, agent, description, status, priority, created_at, completed_at
    FROM tasks ORDER BY created_at DESC LIMIT 20
  `).all() as Array<Record<string, unknown>>;

  const devConvs = db.prepare(`
    SELECT id, status, topic, created_at, updated_at
    FROM dev_conversations ORDER BY created_at DESC LIMIT 10
  `).all() as Array<Record<string, unknown>>;

  const apiUsage = db.prepare(`
    SELECT
      SUM(cost_usd) as total_cost,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as call_count
    FROM api_usage
    WHERE created_at >= date('now', 'start of day')
  `).get() as Record<string, unknown> || {};

  const monthlyUsage = db.prepare(`
    SELECT SUM(cost_usd) as total_cost, COUNT(*) as call_count
    FROM api_usage
    WHERE created_at >= date('now', 'start of month')
  `).get() as Record<string, unknown> || {};

  const recentLogs = db.prepare(`
    SELECT level, source, message, created_at
    FROM logs ORDER BY created_at DESC LIMIT 30
  `).all() as Array<Record<string, unknown>>;

  const agents = listAgents();

  res.send(renderPage('dashboard', {
    uptime: process.uptime(),
    env: config.server.env,
    agents,
    taskCounts,
    recentTasks,
    devConvs,
    apiUsage,
    monthlyUsage,
    recentLogs,
  }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`<h1>ダッシュボードエラー</h1><pre>${errMsg}</pre>`);
  }
});

// タスク詳細
adminRouter.get('/tasks/:id', (req: Request, res: Response) => {
  const db = getDB();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!task) {
    res.status(404).send('タスクが見つかりません');
    return;
  }
  res.send(renderPage('task-detail', { task }));
});

// 開発結果一覧
adminRouter.get('/dev', (req: Request, res: Response) => {
  try {
    const db = getDB();
    const filter = (req.query.filter as string) || 'all';

    let whereClause = '';
    if (filter === 'deployed') whereClause = "WHERE status = 'deployed'";
    else if (filter === 'failed') whereClause = "WHERE status = 'failed'";
    else if (filter === 'active') whereClause = "WHERE status NOT IN ('deployed', 'failed')";

    const convs = db.prepare(`
      SELECT id, status, topic, generated_files, created_at, updated_at
      FROM dev_conversations ${whereClause} ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;

    // 統計
    const allCounts = db.prepare(`
      SELECT status, COUNT(*) as cnt FROM dev_conversations GROUP BY status
    `).all() as Array<{ status: string; cnt: number }>;

    const total = allCounts.reduce((s, r) => s + r.cnt, 0);
    const deployed = allCounts.find(r => r.status === 'deployed')?.cnt || 0;
    const failed = allCounts.find(r => r.status === 'failed')?.cnt || 0;
    const active = total - deployed - failed;

    // 差し戻し回数（会話IDごと）
    const rejectRows = db.prepare(`
      SELECT task_id, COUNT(*) as cnt FROM team_conversations
      WHERE conversation_type = 'reject' GROUP BY task_id
    `).all() as Array<{ task_id: string; cnt: number }>;
    const rejectCounts: Record<string, number> = {};
    for (const r of rejectRows) rejectCounts[r.task_id] = r.cnt;

    res.send(renderPage('dev-list', {
      convs,
      filter,
      stats: { total, deployed, failed, active },
      rejectCounts,
    }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`<h1>エラー</h1><pre>${errMsg}</pre>`);
  }
});

// 開発会話詳細（強化版）
adminRouter.get('/dev/:id', (req: Request, res: Response) => {
  try {
    const db = getDB();
    const conv = db.prepare('SELECT * FROM dev_conversations WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!conv) {
      res.status(404).send('会話が見つかりません');
      return;
    }

    // チーム会話（task_id と dev_conversation_id 両方で検索）
    const teamConversations = db.prepare(`
      SELECT conversation_type, participants, log, decision, created_at
      FROM team_conversations
      WHERE task_id = ? OR dev_conversation_id = ?
      ORDER BY created_at
    `).all(req.params.id, req.params.id) as Array<Record<string, unknown>>;

    // メトリクス（コンテキスト付き）
    const metrics = db.prepare(`
      SELECT agent, metric_type, value, context, created_at
      FROM task_metrics WHERE task_id = ? ORDER BY created_at
    `).all(req.params.id) as Array<Record<string, unknown>>;

    // エージェント学習記録（この会話に関連する学習）
    const agentLearnings = db.prepare(`
      SELECT agent, type, key, content, source, created_at
      FROM agent_memories
      WHERE (key LIKE ? OR content LIKE ?)
        AND type IN ('learning', 'pattern')
      ORDER BY created_at DESC LIMIT 30
    `).all(`%${req.params.id.slice(0, 8)}%`, `%${req.params.id.slice(0, 8)}%`) as Array<Record<string, unknown>>;

    // エージェント評価
    const evaluations = db.prepare(`
      SELECT evaluator, target, sentiment, aspect, raw_feedback, created_at
      FROM agent_evaluations
      WHERE context LIKE ?
      ORDER BY created_at DESC LIMIT 20
    `).all(`%${req.params.id.slice(0, 8)}%`) as Array<Record<string, unknown>>;

    // ログ（200件に拡大）
    const devLogs = db.prepare(`
      SELECT level, message, created_at FROM logs
      WHERE source = 'dev-agent' AND (message LIKE ? OR message LIKE ?)
      ORDER BY created_at DESC LIMIT 200
    `).all(`%${req.params.id.slice(0, 8)}%`, `%convId%${req.params.id}%`) as Array<Record<string, unknown>>;

    res.send(renderPage('dev-detail', {
      conv, teamConversations, metrics, devLogs, agentLearnings, evaluations,
    }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`<h1>エラー</h1><pre>${errMsg}</pre>`);
  }
});

// チーム分析・改善ページ
adminRouter.get('/insights', (_req: Request, res: Response) => {
  try {
    const db = getDB();

    // エージェント別パフォーマンス
    const agentMetrics = db.prepare(`
      SELECT agent, metric_type, COUNT(*) as cnt
      FROM task_metrics
      GROUP BY agent, metric_type
      ORDER BY agent, cnt DESC
    `).all() as Array<{ agent: string; metric_type: string; cnt: number }>;

    // 頻出エラーパターン（agent_memories type='pattern'）
    const patterns = db.prepare(`
      SELECT agent, key, content, source, updated_at
      FROM agent_memories
      WHERE type = 'pattern'
      ORDER BY updated_at DESC LIMIT 20
    `).all() as Array<Record<string, unknown>>;

    // 直近の学習記録
    const recentLearnings = db.prepare(`
      SELECT agent, key, content, source, created_at
      FROM agent_memories
      WHERE type = 'learning'
      ORDER BY created_at DESC LIMIT 30
    `).all() as Array<Record<string, unknown>>;

    // 差し戻し理由の集計（team_conversations type='reject'）
    const rejectSummary = db.prepare(`
      SELECT log, created_at
      FROM team_conversations
      WHERE conversation_type = 'reject'
      ORDER BY created_at DESC LIMIT 30
    `).all() as Array<Record<string, unknown>>;

    // エージェント評価の推移
    const evalTrend = db.prepare(`
      SELECT target, aspect, AVG(sentiment) as avg_sentiment, COUNT(*) as cnt
      FROM agent_evaluations
      GROUP BY target, aspect
      ORDER BY target, cnt DESC
    `).all() as Array<Record<string, unknown>>;

    // 開発の成功/失敗統計
    const devStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'deployed' THEN 1 ELSE 0 END) as deployed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(CASE WHEN status = 'deployed'
          THEN (julianday(updated_at) - julianday(created_at)) * 1440
          ELSE NULL END) as avg_deploy_min
      FROM dev_conversations
      WHERE created_at >= date('now', '-30 days')
    `).get() as Record<string, unknown>;

    // ルーティング修正履歴
    const routingCorrections = db.prepare(`
      SELECT message, dev_phase, auto_target, corrected_target, created_at
      FROM routing_corrections
      ORDER BY created_at DESC LIMIT 20
    `).all() as Array<Record<string, unknown>>;

    // 相談会話（consult）の一覧
    const consultConvs = db.prepare(`
      SELECT task_id, participants, log, decision, created_at
      FROM team_conversations
      WHERE conversation_type = 'consult'
      ORDER BY created_at DESC LIMIT 20
    `).all() as Array<Record<string, unknown>>;

    res.send(renderPage('insights', {
      agentMetrics, patterns, recentLearnings, rejectSummary,
      evalTrend, devStats, routingCorrections, consultConvs,
    }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.status(500).send(`<h1>エラー</h1><pre>${errMsg}</pre>`);
  }
});

// 開発会話の強制キャンセル
adminRouter.post('/dev/:id/cancel', (req: Request, res: Response) => {
  const db = getDB();
  const conv = db.prepare('SELECT * FROM dev_conversations WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!conv) {
    res.status(404).send('会話が見つかりません');
    return;
  }
  db.prepare("UPDATE dev_conversations SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.redirect('/admin/dev');
});

// 全開発会話の強制リセット
adminRouter.post('/dev/reset-all', (_req: Request, res: Response) => {
  const db = getDB();
  db.prepare("UPDATE dev_conversations SET status = 'failed', updated_at = datetime('now') WHERE status NOT IN ('deployed', 'failed')").run();
  res.redirect('/admin/dev');
});

// ナレッジ一覧
adminRouter.get('/knowledge', (_req: Request, res: Response) => {
  const db = getDB();
  const items = db.prepare(`
    SELECT id, file_name, section, content, version, updated_at
    FROM knowledge ORDER BY file_name, rowid
  `).all() as Array<Record<string, unknown>>;
  res.send(renderPage('knowledge', { items }));
});
