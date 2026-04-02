/**
 * NOTE（PM確認・訂正済み）:
 * サブタスク説明には「pgvectorのvector型、pgドライバが文字列 '[0.1,0.2,...]' で返す →
 * parseFloat配列に変換」と記載されていたが、これは誤り。
 * 本プロジェクトのDBはSQLite（better-sqlite3）であり、embeddingカラムはBLOB型（Buffer）。
 * bufferToEmbedding()による変換が正しい実装。PM確認済み。
 */
import { Router, Request, Response } from 'express';
import { getDB } from '../db/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { cosineSimilarity, bufferToEmbedding } from '../memory/embedding';

export const mindmapApiRouter = Router();

const AGENT_LABELS: Record<string, string> = {
  soico: '分身',
  dev: 'エンジニア',
  pm: 'PM',
  reviewer: 'レビュワー',
  deployer: 'デプロイヤー',
};

type AgentMapping =
  | { table: 'memories'; userId: string }
  | { table: 'agent_memories'; agentValue: string };

function getAgentMapping(agent: string): AgentMapping {
  if (agent === 'soico') {
    return { table: 'memories', userId: config.line.allowedUserId };
  }
  const agentMap: Record<string, string> = {
    dev: 'engineer',
    pm: 'pm',
    reviewer: 'reviewer',
    deployer: 'deployer',
  };
  return { table: 'agent_memories', agentValue: agentMap[agent] || agent };
}

interface MemoryRow {
  id: number;
  type: string;
  key: string;
  content: string;
  source: string | null;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
}

interface NodeResponse {
  id: number;
  key: string;
  content: string;
  type: string;
  source: string | null;
  importance: number;
  hasEmbedding: boolean;
  created_at: string;
  updated_at: string;
}

interface LinkResponse {
  source: number;
  target: number;
  similarity: number;
}

const SIMILARITY_THRESHOLD = 0.75;

function computeSimilarityLinks(
  rows: Array<{ id: number; embedding: Buffer | null }>
): LinkResponse[] {
  const withEmbedding: Array<{ id: number; vec: number[] }> = [];

  for (const row of rows) {
    if (row.embedding && Buffer.isBuffer(row.embedding) && row.embedding.byteLength >= 4) {
      try {
        const vec = bufferToEmbedding(row.embedding);
        withEmbedding.push({ id: row.id, vec });
      } catch {
        // skip invalid embeddings
      }
    }
  }

  const links: LinkResponse[] = [];

  for (let i = 0; i < withEmbedding.length; i++) {
    for (let j = i + 1; j < withEmbedding.length; j++) {
      const sim = cosineSimilarity(withEmbedding[i].vec, withEmbedding[j].vec);
      if (sim >= SIMILARITY_THRESHOLD) {
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

// GET /api/memories?agent=xxx
mindmapApiRouter.get('/api/memories', (req: Request, res: Response) => {
  try {
    const agent = (req.query.agent as string) || 'soico';

    if (!AGENT_LABELS[agent]) {
      res.status(400).json({ error: `不正なagent値: ${agent}` });
      return;
    }

    const mapping = getAgentMapping(agent);
    const db = getDB();

    let rawRows: MemoryRow[];

    if (mapping.table === 'memories') {
      rawRows = db.prepare(`
        SELECT id, type, key, content, NULL as source, -- memoriesテーブルにはsourceカラムが存在しないためNULLを補完
        embedding, created_at, updated_at
        FROM memories WHERE user_id = ? ORDER BY type, key
      `).all(mapping.userId) as MemoryRow[];
    } else {
      rawRows = db.prepare(`
        SELECT id, type, key, content, source, embedding, created_at, updated_at
        FROM agent_memories WHERE agent = ? ORDER BY type, key
      `).all(mapping.agentValue) as MemoryRow[];
    }

    if (rawRows.length === 0) {
      res.json({ nodes: [], links: [] });
      return;
    }

    const nodes: NodeResponse[] = rawRows.map(row => ({
      id: row.id,
      key: row.key,
      content: row.content,
      type: row.type,
      source: row.source,
      importance: 3,
      hasEmbedding: row.embedding != null && Buffer.isBuffer(row.embedding) && row.embedding.byteLength >= 4,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    const links = computeSimilarityLinks(
      rawRows.map(row => ({ id: row.id, embedding: row.embedding }))
    );

    res.json({ nodes, links });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('mindmapApi GET /api/memories エラー', { error: msg });
    res.status(500).json({ error: '記憶の取得に失敗しました' });
  }
});
