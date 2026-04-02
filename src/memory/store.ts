import { getDB } from '../db/database';
import { logger } from '../utils/logger';
import { embed, embedQuery, cosineSimilarity, embeddingToSql, parseEmbedding } from './embedding';
import { getMemoriesCache, addToMemoriesCache, isCacheInitialized } from './embeddingCache';
import { hybridSearch } from './hybridSearch';
import { detectContradiction } from './contradictionDetector';

export type MemoryType = 'profile' | 'project' | 'memo' | 'session_summary' | 'consolidated';

export interface Memory {
  id: number;
  user_id: string;
  type: MemoryType;
  key: string;
  content: string;
  importance: number;
  embedding: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}

/** タイプ別デフォルト重要度 */
function getDefaultImportance(type: MemoryType): number {
  switch (type) {
    case 'consolidated': return 5;
    case 'profile': return 4;
    case 'project': return 3;
    case 'session_summary': return 2;
    case 'memo': return 2;
    default: return 3;
  }
}

/** 記憶を保存（embedding付き） */
export async function saveMemoryWithEmbedding(
  userId: string,
  type: MemoryType,
  key: string,
  content: string,
  importance?: number,
): Promise<void> {
  try {
    const db = getDB();
    const imp = importance ?? getDefaultImportance(type);
    let embeddingSql: string | null = null;
    let vec: number[] | null = null;

    try {
      // contentのみをembedする（keyにタイムスタンプ等が含まれるとノイズになる）
      vec = await embed(content);
      embeddingSql = embeddingToSql(vec);
    } catch (err) {
      logger.warn('Embedding取得失敗（テキストのみ保存）', { err: err instanceof Error ? err.message : String(err) });
    }

    // Phase 2.5: 矛盾検出（embedding がある場合のみ）
    if (embeddingSql) {
      try {
        const contradiction = await detectContradiction(
          'memories', content, embeddingSql, 'user_id', userId,
        );
        if (contradiction.hasContradiction) {
          logger.info('矛盾検出・上書き', {
            userId, type, key,
            contradictedId: contradiction.contradictedId,
            explanation: contradiction.explanation,
          });
        }
      } catch (err) {
        logger.warn('矛盾検出スキップ', { err: err instanceof Error ? err.message : String(err) });
      }
    }

    await db.prepare(`
      INSERT INTO memories (user_id, type, key, content, importance, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, type, key) DO UPDATE SET
        content = excluded.content,
        importance = excluded.importance,
        embedding = excluded.embedding,
        updated_at = NOW()
    `).run(userId, type, key, content, imp, embeddingSql);

    // キャッシュ更新
    if (vec && isCacheInitialized()) {
      const saved = await db.prepare(
        'SELECT id FROM memories WHERE user_id = ? AND type = ? AND key = ?'
      ).get(userId, type, key) as { id: number } | undefined;
      if (saved) {
        addToMemoriesCache(userId, saved.id, type, key, vec, imp);
      }
    }

    logger.info('記憶保存', { userId, type, key, importance: imp });
  } catch (err) {
    logger.error('記憶保存失敗', { userId, type, key, err });
  }
}

/** 記憶保存（embedding無し） */
export async function saveMemory(
  userId: string,
  type: MemoryType,
  key: string,
  content: string,
  importance?: number,
): Promise<void> {
  try {
    const db = getDB();
    const imp = importance ?? getDefaultImportance(type);
    await db.prepare(`
      INSERT INTO memories (user_id, type, key, content, importance)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, type, key) DO UPDATE SET
        content = excluded.content,
        importance = excluded.importance,
        updated_at = NOW()
    `).run(userId, type, key, content, imp);
  } catch (err) {
    logger.error('記憶保存失敗', { userId, type, key, err });
  }
}

/** 後方互換エイリアス */
export const saveMemorySync = saveMemory;

/** 意味検索: クエリに関連する記憶をTop-K取得（時間減衰+重要度考慮） */
export async function searchByMeaning(
  userId: string,
  query: string,
  topK = 10,
): Promise<MemorySearchResult[]> {
  try {
    const queryVec = await embedQuery(query);

    // キャッシュが使えればキャッシュから検索（DB I/Oゼロ）
    if (isCacheInitialized()) {
      const cached = getMemoriesCache(userId);
      const scored: Array<{ id: number; score: number }> = [];

      for (const item of cached) {
        const similarity = cosineSimilarity(queryVec, item.embedding);
        const daysSince = (Date.now() - new Date(item.updated_at).getTime()) / (1000 * 60 * 60 * 24);
        const timeDecay = Math.exp(-daysSince / 60); // 分身は60日で半減
        const impBoost = (item.importance || 3) / 5; // 0.2〜1.0
        const score = similarity * 0.6 + timeDecay * 0.2 + impBoost * 0.2;
        scored.push({ id: item.id, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const topIds = scored.slice(0, topK);

      // top結果のidでDBから完全なMemoryを取得
      const db = getDB();
      const results: MemorySearchResult[] = [];
      for (const r of topIds) {
        const full = await db.prepare('SELECT * FROM memories WHERE id = ?').get(r.id) as Memory;
        if (full) results.push({ memory: full, score: r.score });
      }
      return results;
    }

    // キャッシュ未初期化時はPhase 3.5ハイブリッド検索（BM25 + Semantic + Graph RRF統合）
    const hybridResults = await hybridSearch(query, 'memories', 'user_id', userId, topK);
    if (hybridResults.length > 0) {
      const db = getDB();
      const results: MemorySearchResult[] = [];
      for (const r of hybridResults) {
        const full = await db.prepare('SELECT * FROM memories WHERE id = ?').get(r.id) as Memory;
        if (full) results.push({ memory: full, score: r.score });
      }
      return results;
    }

    // ハイブリッド検索が空の場合のフォールバック
    const db = getDB();
    const fallback = await db.prepare(
      "SELECT * FROM memories WHERE user_id = ? AND updated_at >= NOW() - INTERVAL '60 days' ORDER BY importance DESC, updated_at DESC LIMIT ?"
    ).all(userId, topK) as Memory[];
    return fallback.map(m => ({ memory: m, score: 0.5 }));
  } catch (err) {
    logger.warn('意味検索失敗、キーワード検索にフォールバック', { err: err instanceof Error ? err.message : String(err) });
    return keywordSearchFallback(userId, query, topK);
  }
}

/** キーワード検索（フォールバック用） */
async function keywordSearchFallback(
  userId: string,
  query: string,
  limit: number,
): Promise<MemorySearchResult[]> {
  const db = getDB();
  const rows = await db.prepare(
    'SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR content LIKE ?) ORDER BY importance DESC, updated_at DESC LIMIT ?'
  ).all(userId, `%${query}%`, `%${query}%`, limit) as Memory[];

  return rows.map(m => ({ memory: m, score: 0.5 }));
}

/** 全記憶を取得 */
export async function getAllMemories(userId: string, type?: MemoryType): Promise<Memory[]> {
  const db = getDB();
  if (type) {
    return await db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND type = ? ORDER BY importance DESC, updated_at DESC'
    ).all(userId, type) as Memory[];
  }
  return await db.prepare(
    'SELECT * FROM memories WHERE user_id = ? ORDER BY type, importance DESC, updated_at DESC'
  ).all(userId) as Memory[];
}

/** 記憶を削除 */
export async function deleteMemory(userId: string, type: MemoryType, key: string): Promise<boolean> {
  const db = getDB();
  const result = await db.prepare(
    'DELETE FROM memories WHERE user_id = ? AND type = ? AND key = ?'
  ).run(userId, type, key);
  return result.changes > 0;
}

/** 記憶の件数 */
export async function getMemoryCount(userId: string): Promise<number> {
  const db = getDB();
  const row = await db.prepare(
    'SELECT COUNT(*) as cnt FROM memories WHERE user_id = ?'
  ).get(userId) as { cnt: number };
  return row.cnt;
}

/** スマートコンテキスト構築: 現在のメッセージに関連する記憶だけ注入 */
export async function buildSmartContext(userId: string, currentMessage: string): Promise<string> {
  const allMemories = await getAllMemories(userId);
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
    // embedding使えない場合は重要度順で直近の記憶を使う
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
