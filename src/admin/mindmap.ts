import { Router } from 'express';
import express from 'express';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';
import { renderMindmapPage } from './mindmapView';

export const mindmapRouter = Router();

mindmapRouter.use(express.json());

mindmapRouter.get('/', (_req, res) => {
  res.send(renderMindmapPage());
});

mindmapRouter.get('/api/memories', (_req, res) => {
  try {
    const db = getDB();

    const memories = db.prepare(
      'SELECT id, user_id, type, key, content, importance, embedding, created_at, updated_at FROM memories'
    ).all().map((row: any) => {
      const { embedding, ...rest } = row;
      return { ...rest, table: 'memories', has_embedding: embedding !== null };
    });

    const agentMemories = db.prepare(
      'SELECT id, agent, type, key, content, source, importance, embedding, created_at, updated_at FROM agent_memories'
    ).all().map((row: any) => {
      const { embedding, ...rest } = row;
      return { ...rest, table: 'agent_memories', has_embedding: embedding !== null };
    });

    res.json([...memories, ...agentMemories]);
  } catch (err) {
    logger.error('GET /api/memories error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

mindmapRouter.post('/api/memories', (req, res) => {
  try {
    const db = getDB();
    const { table, user_id, agent, type, key, content, source, importance } = req.body;

    if (table === 'memories') {
      const result = db.prepare(
        'INSERT INTO memories (user_id, type, key, content, importance) VALUES (?, ?, ?, ?, ?)'
      ).run(user_id ?? null, type ?? null, key ?? null, content ?? null, importance ?? 3);
      res.json({ id: result.lastInsertRowid });
    } else if (table === 'agent_memories') {
      const result = db.prepare(
        'INSERT INTO agent_memories (agent, type, key, content, source, importance) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(agent ?? null, type ?? null, key ?? null, content ?? null, source ?? null, importance ?? 3);
      res.json({ id: result.lastInsertRowid });
    } else {
      res.status(400).json({ error: 'Invalid table parameter' });
    }
  } catch (err) {
    logger.error('POST /api/memories error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

mindmapRouter.put('/api/memories/:id', (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const { table, content, importance } = req.body;

    if (table === 'memories') {
      db.prepare(
        "UPDATE memories SET content = ?, importance = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(content ?? null, importance ?? 3, id);
    } else if (table === 'agent_memories') {
      db.prepare(
        "UPDATE agent_memories SET content = ?, importance = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(content ?? null, importance ?? 3, Number(id));
    } else {
      res.status(400).json({ error: 'Invalid table parameter' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('PUT /api/memories/:id error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

mindmapRouter.delete('/api/memories/:id', (req, res) => {
  try {
    const db = getDB();
    const { id } = req.params;
    const { table } = req.body;

    if (table === 'memories') {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    } else if (table === 'agent_memories') {
      db.prepare('DELETE FROM agent_memories WHERE id = ?').run(Number(id));
    } else {
      res.status(400).json({ error: 'Invalid table parameter' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('DELETE /api/memories/:id error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});
