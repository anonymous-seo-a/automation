import { Router, Request, Response } from 'express';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';

export const mindmapApiRouter = Router();

// GET /agents — agent_memories テーブルから DISTINCT な agent 一覧を返す
mindmapApiRouter.get('/agents', (req: Request, res: Response) => {
  try {
    logger.debug('mindmapApi GET /agents called');
    const db = getDB();

    const rows = db.prepare(`
      SELECT DISTINCT agent FROM agent_memories ORDER BY agent
    `).all() as Array<{ agent: string }>;

    logger.debug('mindmapApi /agents query result', { count: rows.length });

    const agents = rows.map(r => r.agent);
    res.json({ agents });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmapApi GET /agents エラー', { error: msg });
    res.status(500).json({ error: 'エージェント一覧の取得に失敗しました', detail: msg });
  }
});

// GET /graph?agent=xxx — ノード・エッジ構造の JSON を返す
mindmapApiRouter.get('/graph', (req: Request, res: Response) => {
  try {
    const agent = req.query.agent as string | undefined;
    logger.debug('mindmapApi GET /graph called', { agent });

    if (!agent) {
      res.status(400).json({ error: 'agent クエリパラメータは必須です' });
      return;
    }

    const db = getDB();

    const rows = db.prepare(`
      SELECT id, type, key, content
      FROM agent_memories
      WHERE agent = ?
      ORDER BY type, key
    `).all(agent) as Array<{ id: number; type: string; key: string; content: string }>;

    logger.debug('mindmapApi /graph query result', { agent, count: rows.length });

    if (rows.length === 0) {
      res.json({ nodes: [], edges: [] });
      return;
    }

    // ルートノード（エージェント）
    const rootId = `agent_${agent}`;
    const nodes: Array<{ id: string; label: string; group: string; data?: Record<string, unknown> }> = [
      { id: rootId, label: agent, group: 'root' },
    ];
    const edges: Array<{ source: string; target: string; label?: string }> = [];

    // タイプハブノード（type ごとに1つ）
    const types = [...new Set(rows.map(r => r.type))];
    for (const type of types) {
      const typeId = `type_${agent}_${type}`;
      nodes.push({ id: typeId, label: type, group: 'type' });
      edges.push({ source: rootId, target: typeId });
    }

    // 記憶ノード（各行）
    for (const row of rows) {
      const nodeId = `mem_${row.id}`;
      const typeId = `type_${agent}_${row.type}`;
      nodes.push({
        id: nodeId,
        label: row.key,
        group: row.type,
        data: { content: row.content, type: row.type, key: row.key },
      });
      edges.push({ source: typeId, target: nodeId });
    }

    res.json({ nodes, edges });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmapApi GET /graph エラー', { error: msg });
    res.status(500).json({ error: 'グラフデータの取得に失敗しました', detail: msg });
  }
});
