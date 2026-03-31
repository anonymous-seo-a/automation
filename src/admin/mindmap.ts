// NOTE: このルーターは adminAuth ミドルウェア適用済みの /admin 配下にマウントすること
// app.use('/admin/mindmap', adminAuth, mindmapRouter);
import { Router, Request, Response } from 'express';
import express from 'express';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';
import { renderMindmapPage } from './mindmapView';

export const mindmapRouter = Router();

// 親の Express アプリが express.json() をグローバル適用していない場合に備えて適用する
// 親側で適用済みの場合は二重パースになるが動作上無害
mindmapRouter.use(express.json());

// GET / → マインドマップHTML
mindmapRouter.get('/', (_req: Request, res: Response) => {
  try {
    const html = renderMindmapPage();
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    logger.error('mindmap GET / error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/memories → ツリー構造JSON
mindmapRouter.get('/api/memories', (_req: Request, res: Response) => {
  try {
    const db = getDB();

    // LIMIT 500: レコード数増加時のメモリ・レスポンスサイズ肥大化を防ぐ上限
    const memories = db.prepare(
      'SELECT id, user_id, type, key, content, created_at, updated_at FROM memories LIMIT 500'
    ).all() as Array<{ id: number; user_id: string; type: string; key: string; content: string; created_at: string; updated_at: string }>;

    const agentMemories = db.prepare(
      'SELECT id, agent, type, key, content, source, created_at, updated_at FROM agent_memories LIMIT 500'
    ).all() as Array<{ id: number; agent: string; type: string; key: string; content: string; source: string; created_at: string; updated_at: string }>;

    const knowledge = db.prepare(
      'SELECT id, file_name, section, content, version, updated_at FROM knowledge LIMIT 500'
    ).all() as Array<{ id: string; file_name: string; section: string | null; content: string; version: number; updated_at: string }>;

    // Helper: group array by a key
    function groupBy<T>(arr: T[], keyFn: (item: T) => string): Map<string, T[]> {
      const map = new Map<string, T[]>();
      for (const item of arr) {
        const k = keyFn(item);
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(item);
      }
      return map;
    }

    let idCounter = 0;
    function nextId(prefix: string): string {
      return prefix + '_' + (++idCounter);
    }

    // ユーザー記憶: user_id → type → 個別ノード
    const userByUserId = groupBy(memories, m => m.user_id);
    const userChildren = Array.from(userByUserId.entries()).map(([userId, rows]) => {
      const byType = groupBy(rows, r => r.type);
      const typeChildren = Array.from(byType.entries()).map(([type, typeRows]) => {
        const leafChildren = typeRows.map(r => ({
          id: nextId('u'),
          depth: 4,
          label: r.key + ': ' + r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          name: r.key,
          content: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          summary: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          fullContent: r.content,
          key: r.key,
          memType: 'user',
          memId: r.id,
          dbType: 'user',
          dbId: r.id,
        }));
        return {
          id: nextId('ut'),
          depth: 3,
          label: type,
          name: type,
          children: leafChildren,
        };
      });
      return {
        id: nextId('uu'),
        depth: 2,
        label: userId,
        name: userId,
        children: typeChildren,
      };
    });

    // エージェント記憶: agent → type → 個別ノード
    const agentByAgent = groupBy(agentMemories, m => m.agent);
    const agentChildren = Array.from(agentByAgent.entries()).map(([agent, rows]) => {
      const byType = groupBy(rows, r => r.type);
      const typeChildren = Array.from(byType.entries()).map(([type, typeRows]) => {
        const leafChildren = typeRows.map(r => ({
          id: nextId('a'),
          depth: 4,
          label: r.key + ': ' + r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          name: r.key,
          content: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          summary: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          fullContent: r.content,
          key: r.key,
          memType: 'agent',
          memId: r.id,
          dbType: 'agent',
          dbId: r.id,
        }));
        return {
          id: nextId('at'),
          depth: 3,
          label: type,
          name: type,
          children: leafChildren,
        };
      });
      return {
        id: nextId('aa'),
        depth: 2,
        label: agent,
        name: agent,
        children: typeChildren,
      };
    });

    // ナレッジ: file_name → section → 個別ノード
    const knowledgeByFile = groupBy(knowledge, k => k.file_name);
    const knowledgeChildren = Array.from(knowledgeByFile.entries()).map(([fileName, rows]) => {
      const bySection = groupBy(rows, r => r.section || '(未分類)');
      const sectionChildren = Array.from(bySection.entries()).map(([section, sectionRows]) => {
        const leafChildren = sectionRows.map(r => ({
          id: nextId('k'),
          depth: 4,
          // section は NULL になりうるためフォールバック
          label: (r.section || '(未分類)') + ': ' + r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          name: r.section || '(未分類)',
          content: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          summary: r.content.slice(0, 50) + (r.content.length > 50 ? '...' : ''),
          fullContent: r.content,
          key: r.section || '(未分類)',
          memType: 'knowledge',
          memId: r.id,
          dbType: 'knowledge',
          dbId: r.id,
        }));
        return {
          id: nextId('ks'),
          depth: 3,
          label: section,
          name: section,
          children: leafChildren,
        };
      });
      return {
        id: nextId('kf'),
        depth: 2,
        label: fileName,
        name: fileName,
        children: sectionChildren,
      };
    });

    const tree = {
      id: 'root',
      depth: 0,
      label: '母艦の記憶',
      name: '母艦の記憶',
      children: [
        { id: 'user_root', depth: 1, label: 'ユーザー記憶', name: 'ユーザー記憶', children: userChildren },
        { id: 'agent_root', depth: 1, label: 'エージェント記憶', name: 'エージェント記憶', children: agentChildren },
        { id: 'knowledge_root', depth: 1, label: 'ナレッジ', name: 'ナレッジ', children: knowledgeChildren },
      ],
    };

    res.json(tree);
  } catch (err) {
    logger.error('mindmap GET /api/memories error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/memories/:type/:id → content更新
mindmapRouter.put('/api/memories/:type/:id', (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;
    const { content } = req.body as { content: string };

    if (typeof content !== 'string' || content.trim() === '') {
      res.status(400).json({ error: 'content is required and must be non-empty' });
      return;
    }

    // user/agent は INTEGER PK のため、ハンドラ入り口で一括 NaN チェック
    let numericId: number | undefined;
    if (type === 'user' || type === 'agent') {
      numericId = parseInt(id, 10);
      if (isNaN(numericId)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
    }

    const db = getDB();
    let result: { changes: number };

    if (type === 'user') {
      result = db.prepare(
        "UPDATE memories SET content = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(content, numericId) as { changes: number };
    } else if (type === 'agent') {
      result = db.prepare(
        "UPDATE agent_memories SET content = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(content, numericId) as { changes: number };
    } else if (type === 'knowledge') {
      result = db.prepare(
        "UPDATE knowledge SET content = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(content, id) as { changes: number };
    } else {
      res.status(400).json({ error: 'Invalid type' });
      return;
    }

    if (result.changes === 0) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('mindmap PUT /api/memories error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/memories/:type/:id → レコード削除
mindmapRouter.delete('/api/memories/:type/:id', (req: Request, res: Response) => {
  try {
    const { type, id } = req.params;

    // user/agent は INTEGER PK のため、ハンドラ入り口で一括 NaN チェック
    let numericId: number | undefined;
    if (type === 'user' || type === 'agent') {
      numericId = parseInt(id, 10);
      if (isNaN(numericId)) {
        res.status(400).json({ error: 'Invalid id' });
        return;
      }
    }

    const db = getDB();
    let result: { changes: number };

    if (type === 'user') {
      result = db.prepare('DELETE FROM memories WHERE id = ?').run(numericId) as { changes: number };
    } else if (type === 'agent') {
      result = db.prepare('DELETE FROM agent_memories WHERE id = ?').run(numericId) as { changes: number };
    } else if (type === 'knowledge') {
      result = db.prepare('DELETE FROM knowledge WHERE id = ?').run(id) as { changes: number };
    } else {
      res.status(400).json({ error: 'Invalid type' });
      return;
    }

    if (result.changes === 0) {
      res.status(404).json({ error: 'Record not found' });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error('mindmap DELETE /api/memories error', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});
