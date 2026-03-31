import { Router, Request, Response } from 'express';
import express from 'express';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';
import { renderMindmapPage } from './mindmapView';

export const mindmapRouter = Router();

mindmapRouter.use(express.json());

// GET / - マインドマップページHTML
mindmapRouter.get('/', (_req: Request, res: Response) => {
  res.send(renderMindmapPage());
});

// GET /api/memories - memoriesとagent_memoriesの統合取得
mindmapRouter.get('/api/memories', (_req: Request, res: Response) => {
  try {
    const db = getDB();

    const memoriesRows = db.prepare(`
      SELECT id, user_id, type, key, content, embedding, created_at, updated_at
      FROM memories
    `).all() as Array<Record<string, unknown>>;

    const agentMemoriesRows = db.prepare(`
      SELECT id, agent, type, key, content, source, embedding, created_at, updated_at
      FROM agent_memories
    `).all() as Array<Record<string, unknown>>;

    const memories = memoriesRows.map(({ embedding, ...rest }) => ({
      ...rest,
      table: 'memories' as const,
      has_embedding: embedding !== null,
    }));

    const agentMemories = agentMemoriesRows.map(({ embedding, ...rest }) => ({
      ...rest,
      table: 'agent_memories' as const,
      has_embedding: embedding !== null,
    }));

    res.json([...memories, ...agentMemories]);
  } catch (err) {
    logger.error('mindmap GET /api/memories error', { err });
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/memories - 記憶新規追加
mindmapRouter.post('/api/memories', (req: Request, res: Response) => {
  try {
    const db = getDB();
    const { table, user_id, agent, type, key, content, source } = req.body as Record<string, string>;

    // importanceは現行スキーマに存在しないためスキップ（将来対応）

    if (table === 'memories') {
      if (!user_id || !type || !key || !content) {
        res.status(400).json({ error: 'missing required fields' });
        return;
      }
      // INSERT OR REPLACE は created_at をリセットするため ON CONFLICT DO UPDATE を使用
      db.prepare(`
        INSERT INTO memories (user_id, type, key, content, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id, type, key) DO UPDATE SET
          content = excluded.content,
          updated_at = datetime('now')
      `).run(user_id, type, key, content);
    } else if (table === 'agent_memories') {
      if (!agent || !type || !key || !content) {
        res.status(400).json({ error: 'missing required fields' });
        return;
      }
      // INSERT OR REPLACE は created_at をリセットするため ON CONFLICT DO UPDATE を使用
      db.prepare(`
        INSERT INTO agent_memories (agent, type, key, content, source, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(agent, type, key) DO UPDATE SET
          content = excluded.content,
          source = excluded.source,
          updated_at = datetime('now')
      `).run(agent, type, key, content, source ?? null);
    } else {
      res.status(400).json({ error: 'invalid table' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('mindmap POST /api/memories error', { err });
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/memories/:id - 記憶編集
mindmapRouter.put('/api/memories/:id', (req: Request, res: Response) => {
  try {
    const db = getDB();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const table = (req.query['table'] as string) || (req.body as Record<string, string>).table;
    const { content } = req.body as Record<string, string>;

    // importanceは現行スキーマに存在しないためスキップ（将来対応）

    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    if (table === 'memories') {
      const result = db.prepare(`
        UPDATE memories SET content = ?, updated_at = datetime('now') WHERE id = ?
      `).run(content, id);
      if (result.changes === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
    } else if (table === 'agent_memories') {
      const result = db.prepare(`
        UPDATE agent_memories SET content = ?, updated_at = datetime('now') WHERE id = ?
      `).run(content, id);
      if (result.changes === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
    } else {
      res.status(400).json({ error: 'invalid table' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('mindmap PUT /api/memories/:id error', { err });
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/memories/:id - 記憶削除
mindmapRouter.delete('/api/memories/:id', (req: Request, res: Response) => {
  try {
    const db = getDB();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const table = (req.query['table'] as string) || (req.body as Record<string, string>)?.table;

    if (table === 'memories') {
      const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      if (result.changes === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
    } else if (table === 'agent_memories') {
      const result = db.prepare('DELETE FROM agent_memories WHERE id = ?').run(id);
      if (result.changes === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
    } else {
      res.status(400).json({ error: 'invalid table' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('mindmap DELETE /api/memories/:id error', { err });
    res.status(500).json({ error: String(err) });
  }
});
