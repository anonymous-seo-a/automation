import { Router, Request, Response } from 'express';
import express from 'express';
import { getDB } from '../db/database';
import { config } from '../config';
import { listAgents } from '../agents/router';
import { renderPage } from './views';

export const adminRouter = Router();

// BASIC認証
adminRouter.use((req: Request, res: Response, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Mothership Admin"');
    res.status(401).send('認証が必要です');
    return;
  }
  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === 'admin' && pass === config.admin.password) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Mothership Admin"');
    res.status(401).send('認証失敗');
  }
});

adminRouter.use(express.json());

// ダッシュボードトップ
adminRouter.get('/', (_req: Request, res: Response) => {
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

// 開発会話詳細
adminRouter.get('/dev/:id', (req: Request, res: Response) => {
  const db = getDB();
  const conv = db.prepare('SELECT * FROM dev_conversations WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!conv) {
    res.status(404).send('会話が見つかりません');
    return;
  }
  res.send(renderPage('dev-detail', { conv }));
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
