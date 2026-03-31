import { getDB } from '../db/database';
import { logger } from '../utils/logger';
import { embed, embedQuery, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from './embedding';

export type MemoryType = 'profile' | 'project' | 'memo' | 'session_summary' | 'consolidated';

export interface Memory {
  id: number;
  user_id: string;
  type: MemoryType;
  key: string;
  content: string;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}

/** 記憶を保存（embedding付き） */
export async function saveMemoryWithEmbedding(
  userId: string,
  type: MemoryType,
  key: string,
  content: string,
): Promise<void> {
  try {
    const db = getDB();
    let embeddingBuf: Buffer | null = null;

    try {
      const vec = await embed(`${key}: ${content}`);
      embeddingBuf = embeddingToBuffer(vec);
    } catch (err) {
      logger.warn('Embedding取得失敗（テキストのみ保存）', { err: err instanceof Error ? err.message : String(err) });
    }

    db.prepare(`
      INSERT INTO memories (user_id, type, key, content, embedding)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, type, key) DO UPDATE SET
        content = excluded.content,
        embedding = excluded.embedding,
        updated_at = datetime('now')
    `).run(userId, type, key, content, embeddingBuf);

    logger.info('記憶保存', { userId, type, key });
  } catch (err) {
    logger.error('記憶保存失敗', { userId, type, key, err });
  }
}

/** 同期版（embedding無し、互換性のため） */
export function saveMemorySync(
  userId: string,
  type: MemoryType,
  key: string,
  content: string,
): void {
  try {
    const db = getDB();
    db.prepare(`
      INSERT INTO memories (user_id, type, key, content)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, type, key) DO UPDATE SET
        content = excluded.content,
        updated_at = datetime('now')
    `).run(userId, type, key, content);
  } catch (err) {
    logger.error('記憶保存失敗', { userId, type, key, err });
  }
}

/** 意味検索: クエリに関連する記憶をTop-K取得 */
export async function searchByMeaning(
  userId: string,
  query: string,
  topK = 10,
): Promise<MemorySearchResult[]> {
  try {
    const db = getDB();
    const queryVec = await embedQuery(query);

    const rows = db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND embedding IS NOT NULL'
    ).all(userId) as Memory[];

    const scored: MemorySearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const memVec = bufferToEmbedding(row.embedding as Buffer);
      const score = cosineSimilarity(queryVec, memVec);
      scored.push({ memory: row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch (err) {
    logger.warn('意味検索失敗、キーワード検索にフォールバック', { err: err instanceof Error ? err.message : String(err) });
    return keywordSearchFallback(userId, query, topK);
  }
}

/** キーワード検索（フォールバック用） */
function keywordSearchFallback(
  userId: string,
  query: string,
  limit: number,
): MemorySearchResult[] {
  const db = getDB();
  const rows = db.prepare(
    'SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?'
  ).all(userId, `%${query}%`, `%${query}%`, limit) as Memory[];

  return rows.map(m => ({ memory: m, score: 0.5 }));
}

/** 全記憶を取得 */
export function getAllMemories(userId: string, type?: MemoryType): Memory[] {
  const db = getDB();
  if (type) {
    return db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND type = ? ORDER BY updated_at DESC'
    ).all(userId, type) as Memory[];
  }
  return db.prepare(
    'SELECT * FROM memories WHERE user_id = ? ORDER BY type, updated_at DESC'
  ).all(userId) as Memory[];
}

/** 記憶を削除 */
export function deleteMemory(userId: string, type: MemoryType, key: string): boolean {
  const db = getDB();
  const result = db.prepare(
    'DELETE FROM memories WHERE user_id = ? AND type = ? AND key = ?'
  ).run(userId, type, key);
  return result.changes > 0;
}

/** 記憶の件数 */
export function getMemoryCount(userId: string): number {
  const db = getDB();
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM memories WHERE user_id = ?'
  ).get(userId) as { cnt: number };
  return row.cnt;
}

/** スマートコンテキスト構築: 現在のメッセージに関連する記憶だけ注入 */
export async function buildSmartContext(userId: string, currentMessage: string): Promise<string> {
  const allMemories = getAllMemories(userId);
  if (allMemories.length === 0) return '';

  // consolidated（統合プロフィール）は常に含める
  const consolidated = allMemories.filter(m => m.type === 'consolidated');

  // それ以外は意味検索でTop10
  let relevant: MemorySearchResult[] = [];
  try {
    relevant = await searchByMeaning(userId, currentMessage, 10);
    // consolidatedと重複するものを除外
    const consolidatedIds = new Set(consolidated.map(m => m.id));
    relevant = relevant.filter(r => !consolidatedIds.has(r.memory.id));
  } catch {
    // embedding使えない場合は直近の記憶を使う
    const recent = allMemories
      .filter(m => m.type !== 'consolidated')
      .slice(0, 10);
    relevant = recent.map(m => ({ memory: m, score: 0 }));
  }

  const sections: string[] = [];

  if (consolidated.length > 0) {
    sections.push('## あなたが知っているユーザー情報\n' +
      consolidated.map(m => m.content).join('\n'));
  }

  if (relevant.length > 0) {
    sections.push('## 関連する記憶\n' +
      relevant.map(r => `- [${r.memory.type}] ${r.memory.key}: ${r.memory.content}`).join('\n'));
  }

  return sections.length > 0 ? '\n\n' + sections.join('\n\n') : '';
}
