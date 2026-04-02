import { Router, Request, Response } from 'express';
import { getDB } from '../db/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { cosineSimilarity, parseEmbedding } from '../memory/embedding';
import { renderPage } from './views';

export const mindmapRouter = Router();

const AGENT_LABELS: Record<string, string> = {
  soico: '分身',
  dev: 'エンジニア',
  pm: 'PM',
  reviewer: 'レビュワー',
  deployer: 'デプロイヤー',
};

type AgentMapping = {
  table: 'memories';
  userIdColumn: string;
} | {
  table: 'agent_memories';
  agentValue: string;
};

function getAgentMapping(agent: string): AgentMapping {
  if (agent === 'soico') {
    return { table: 'memories', userIdColumn: config.line.allowedUserId };
  }
  const agentMap: Record<string, string> = {
    dev: 'engineer',
    pm: 'pm',
    reviewer: 'reviewer',
    deployer: 'deployer',
  };
  return { table: 'agent_memories', agentValue: agentMap[agent] || agent };
}

function computeSimilarityLinks(
  rows: Array<{ id: number; embedding: string | null }>
): Array<{ source: number; target: number; similarity: number }> {
  const withEmbedding: Array<{ id: number; vec: number[] }> = [];

  for (const row of rows) {
    if (row.embedding && typeof row.embedding === 'string' && row.embedding.length > 2) {
      try {
        const vec = parseEmbedding(row.embedding);
        withEmbedding.push({ id: row.id, vec });
      } catch {
        // skip invalid
      }
    }
  }

  const links: Array<{ source: number; target: number; similarity: number }> = [];
  const THRESHOLD = 0.7;

  for (let i = 0; i < withEmbedding.length; i++) {
    for (let j = i + 1; j < withEmbedding.length; j++) {
      const sim = cosineSimilarity(withEmbedding[i].vec, withEmbedding[j].vec);
      if (sim >= THRESHOLD) {
        links.push({
          source: withEmbedding[i].id,
          target: withEmbedding[j].id,
          similarity: Math.round(sim * 1000) / 1000,
        });
      }
    }
  }

  return links;
}

mindmapRouter.get('/', (_req: Request, res: Response) => {
  try {
    res.send(renderPage('mindmap', {}));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmap ページ表示エラー', { error: msg });
    res.status(500).send('<h1>エラー</h1><pre>マインドマップの表示に失敗しました</pre>');
  }
});

mindmapRouter.get('/api/nodes', async (req: Request, res: Response) => {
  try {
    const agent = (req.query.agent as string) || 'soico';

    if (!AGENT_LABELS[agent]) {
      res.status(400).json({ error: `不正なagent値: ${agent}` });
      return;
    }

    const mapping = getAgentMapping(agent);
    const db = getDB();

    let rawRows: Array<Record<string, unknown>>;

    if (mapping.table === 'memories') {
      rawRows = await db.prepare(`
        SELECT id, type, key, content, embedding, created_at, updated_at
        FROM memories WHERE user_id = ? ORDER BY type, key
      `).all(mapping.userIdColumn) as Array<Record<string, unknown>>;
    } else {
      rawRows = await db.prepare(`
        SELECT id, type, key, content, embedding, created_at, updated_at
        FROM agent_memories WHERE agent = ? ORDER BY type, key
      `).all(mapping.agentValue) as Array<Record<string, unknown>>;
    }

    const nodes = rawRows.map(row => ({
      id: row.id as number,
      type: row.type as string,
      key: row.key as string,
      content: row.content as string,
      importance: 3,
      hasEmbedding: row.embedding != null && typeof row.embedding === 'string' && (row.embedding as string).length > 2,
    }));

    const embeddingRows = rawRows.map(row => ({
      id: row.id as number,
      embedding: (row.embedding as string | null),
    }));
    const links = computeSimilarityLinks(embeddingRows);

    const types = [...new Set(nodes.map(n => n.type))];

    res.json({
      center: { name: AGENT_LABELS[agent], agent },
      nodes,
      types,
      links,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmap api/nodes エラー', { error: msg });
    res.status(500).json({ error: 'ノード取得に失敗しました' });
  }
});

mindmapRouter.post('/api/nodes', async (req: Request, res: Response) => {
  try {
    const { agent, type, key, content } = req.body as {
      agent?: string; type?: string; key?: string; content?: string;
    };

    if (!agent || !type || !key || !content) {
      res.status(400).json({ error: 'agent, type, key, content は必須です' });
      return;
    }
    if (!AGENT_LABELS[agent]) {
      res.status(400).json({ error: `不正なagent値: ${agent}` });
      return;
    }

    const mapping = getAgentMapping(agent);
    const db = getDB();

    let insertedId: number;

    if (mapping.table === 'memories') {
      const row = await db.prepare(`
        INSERT INTO memories (user_id, type, key, content)
        VALUES (?, ?, ?, ?) RETURNING id
      `).get(mapping.userIdColumn, type, key, content) as { id: number };
      insertedId = row.id;
    } else {
      const row = await db.prepare(`
        INSERT INTO agent_memories (agent, type, key, content)
        VALUES (?, ?, ?, ?) RETURNING id
      `).get(mapping.agentValue, type, key, content) as { id: number };
      insertedId = row.id;
    }

    res.json({ id: insertedId, success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmap POST api/nodes エラー', { error: msg });
    res.status(500).json({ error: '記憶の追加に失敗しました' });
  }
});

mindmapRouter.put('/api/nodes/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: '不正なID' }); return; }

    const { agent, content } = req.body as { agent?: string; content?: string };
    if (!agent || !content) { res.status(400).json({ error: 'agent, content は必須です' }); return; }
    if (!AGENT_LABELS[agent]) { res.status(400).json({ error: `不正なagent値: ${agent}` }); return; }

    const mapping = getAgentMapping(agent);
    const db = getDB();
    let changes: number;

    if (mapping.table === 'memories') {
      const result = await db.prepare(`
        UPDATE memories SET content = ?, updated_at = NOW() WHERE id = ? AND user_id = ?
      `).run(content, id, mapping.userIdColumn);
      changes = result.changes;
    } else {
      const result = await db.prepare(`
        UPDATE agent_memories SET content = ?, updated_at = NOW() WHERE id = ? AND agent = ?
      `).run(content, id, mapping.agentValue);
      changes = result.changes;
    }

    if (changes === 0) { res.status(404).json({ error: '記憶が見つかりません' }); return; }
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmap PUT api/nodes エラー', { error: msg });
    res.status(500).json({ error: '記憶の更新に失敗しました' });
  }
});

mindmapRouter.delete('/api/nodes/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ error: '不正なID' }); return; }

    const agent = (req.query.agent as string) || (req.body as { agent?: string })?.agent;
    if (!agent) { res.status(400).json({ error: 'agent は必須です' }); return; }
    if (!AGENT_LABELS[agent]) { res.status(400).json({ error: `不正なagent値: ${agent}` }); return; }

    const mapping = getAgentMapping(agent);
    const db = getDB();
    let changes: number;

    if (mapping.table === 'memories') {
      const result = await db.prepare(`
        DELETE FROM memories WHERE id = ? AND user_id = ?
      `).run(id, mapping.userIdColumn);
      changes = result.changes;
    } else {
      const result = await db.prepare(`
        DELETE FROM agent_memories WHERE id = ? AND agent = ?
      `).run(id, mapping.agentValue);
      changes = result.changes;
    }

    if (changes === 0) { res.status(404).json({ error: '記憶が見つかりません' }); return; }
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmap DELETE api/nodes エラー', { error: msg });
    res.status(500).json({ error: '記憶の削除に失敗しました' });
  }
});
