import { getDB } from '../db/database';
import { parseEmbedding } from './embedding';
import { logger } from '../utils/logger';

interface CachedEmbedding {
  id: number;
  type: string;
  key: string;
  embedding: number[];
  importance: number;
  updated_at: string;
}

// テーブル別にキャッシュを持つ
const memoriesCache = new Map<string, CachedEmbedding[]>(); // key: user_id
const agentMemoriesCache = new Map<string, CachedEmbedding[]>(); // key: agent role

let initialized = false;

/** 起動時にDBから全embeddingをメモリにロード */
export async function initEmbeddingCache(): Promise<void> {
  const db = getDB();

  // memories テーブル
  const memories = await db.prepare(
    'SELECT id, user_id, type, key, embedding, importance, updated_at FROM memories WHERE embedding IS NOT NULL'
  ).all() as Array<{ id: number; user_id: string; type: string; key: string; embedding: string; importance: number; updated_at: string }>;

  for (const row of memories) {
    const userId = row.user_id;
    if (!memoriesCache.has(userId)) memoriesCache.set(userId, []);
    try {
      memoriesCache.get(userId)!.push({
        id: row.id,
        type: row.type,
        key: row.key,
        embedding: parseEmbedding(row.embedding),
        importance: row.importance || 3,
        updated_at: row.updated_at,
      });
    } catch {
      // 壊れたembeddingは無視
    }
  }

  // agent_memories テーブル
  const agentMems = await db.prepare(
    'SELECT id, agent, type, key, embedding, importance, updated_at FROM agent_memories WHERE embedding IS NOT NULL'
  ).all() as Array<{ id: number; agent: string; type: string; key: string; embedding: string; importance: number; updated_at: string }>;

  for (const row of agentMems) {
    const agent = row.agent;
    if (!agentMemoriesCache.has(agent)) agentMemoriesCache.set(agent, []);
    try {
      agentMemoriesCache.get(agent)!.push({
        id: row.id,
        type: row.type,
        key: row.key,
        embedding: parseEmbedding(row.embedding),
        importance: row.importance || 3,
        updated_at: row.updated_at,
      });
    } catch {
      // 壊れたembeddingは無視
    }
  }

  initialized = true;
  const totalMemories = [...memoriesCache.values()].reduce((sum, arr) => sum + arr.length, 0);
  const totalAgent = [...agentMemoriesCache.values()].reduce((sum, arr) => sum + arr.length, 0);
  logger.info('Embeddingキャッシュ初期化完了', { memories: totalMemories, agentMemories: totalAgent });
}

/** 記憶保存時にキャッシュにも追加 */
export function addToMemoriesCache(
  userId: string, id: number, type: string, key: string,
  embedding: number[], importance: number,
): void {
  if (!memoriesCache.has(userId)) memoriesCache.set(userId, []);
  const cache = memoriesCache.get(userId)!;
  const entry: CachedEmbedding = { id, type, key, embedding, importance, updated_at: new Date().toISOString() };
  const idx = cache.findIndex(c => c.id === id);
  if (idx >= 0) {
    cache[idx] = entry;
  } else {
    cache.push(entry);
  }
}

/** エージェント記憶保存時にキャッシュにも追加 */
export function addToAgentCache(
  agent: string, id: number, type: string, key: string,
  embedding: number[], importance: number,
): void {
  if (!agentMemoriesCache.has(agent)) agentMemoriesCache.set(agent, []);
  const cache = agentMemoriesCache.get(agent)!;
  const entry: CachedEmbedding = { id, type, key, embedding, importance, updated_at: new Date().toISOString() };
  const idx = cache.findIndex(c => c.id === id);
  if (idx >= 0) {
    cache[idx] = entry;
  } else {
    cache.push(entry);
  }
}

/** 記憶削除時にキャッシュからも除去 */
export function removeFromMemoriesCache(userId: string, id: number): void {
  const cache = memoriesCache.get(userId);
  if (cache) {
    const idx = cache.findIndex(c => c.id === id);
    if (idx >= 0) cache.splice(idx, 1);
  }
}

export function removeFromAgentCache(agent: string, id: number): void {
  const cache = agentMemoriesCache.get(agent);
  if (cache) {
    const idx = cache.findIndex(c => c.id === id);
    if (idx >= 0) cache.splice(idx, 1);
  }
}

/** キャッシュからembedding一覧を取得（DBアクセスなし） */
export function getMemoriesCache(userId: string): CachedEmbedding[] {
  return memoriesCache.get(userId) || [];
}

export function getAgentCache(agent: string): CachedEmbedding[] {
  return agentMemoriesCache.get(agent) || [];
}

export function isCacheInitialized(): boolean {
  return initialized;
}
