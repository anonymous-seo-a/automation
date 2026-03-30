/**
 * チーム記憶管理モジュール
 * エージェントごとの記憶を管理する
 */
import { getDB } from '../../db/database';
import { logger } from '../../utils/logger';

export type AgentRole = 'pm' | 'engineer' | 'reviewer' | 'deployer';
export type MemoryType = 'learning' | 'pattern' | 'preference' | 'evaluation';

export interface AgentMemory {
  id?: number;
  agent: AgentRole;
  type: MemoryType;
  key: string;
  content: string;
  source: string;
  embedding?: Buffer | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * エージェント記憶を1件保存（embedding なし・同期版）
 */
export function saveAgentMemory(
  agent: AgentRole,
  type: MemoryType,
  key: string,
  content: string,
  source: string
): void {
  try {
    const db = getDB();
    const existing = db.prepare(
      'SELECT id FROM agent_memories WHERE agent = ? AND key = ?'
    ).get(agent, key) as { id: number } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE agent_memories
        SET type = ?, content = ?, source = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(type, content, source, existing.id);
    } else {
      db.prepare(`
        INSERT INTO agent_memories (agent, type, key, content, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(agent, type, key, content, source);
    }
  } catch (err) {
    logger.error('saveAgentMemory failed', { agent, key, error: err });
    throw err;
  }
}

/**
 * 動的にembeddingモジュールからgetEmbedding関数を取得する
 * モジュールが存在しない場合やエクスポートされていない場合はnullを返す
 */
async function tryGetEmbeddingFunction(): Promise<((text: string) => Promise<number[]>) | null> {
  try {
    const embeddingModule = await import('../../memory/embedding');
    // モジュールのエクスポートを動的にチェック
    const mod = embeddingModule as Record<string, unknown>;
    // getEmbedding があればそれを使う
    if (typeof mod['getEmbedding'] === 'function') {
      return mod['getEmbedding'] as (text: string) => Promise<number[]>;
    }
    // embed という名前の場合もチェック
    if (typeof mod['embed'] === 'function') {
      return mod['embed'] as (text: string) => Promise<number[]>;
    }
    // generateEmbedding という名前の場合もチェック
    if (typeof mod['generateEmbedding'] === 'function') {
      return mod['generateEmbedding'] as (text: string) => Promise<number[]>;
    }
    // default export をチェック
    if (typeof mod['default'] === 'function') {
      return mod['default'] as (text: string) => Promise<number[]>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * エージェント記憶をバッチ保存（embedding 付き・非同期版）
 * embedding モジュールが利用可能な場合は embedding を生成してから保存する
 */
export async function saveAgentMemoriesBatch(
  entries: Array<{
    agent: AgentRole;
    type: MemoryType;
    key: string;
    content: string;
    source: string;
  }>
): Promise<void> {
  const db = getDB();

  // embedding 生成を試みる
  let embeddings: Array<Buffer | null> = entries.map(() => null);

  try {
    const embeddingFn = await tryGetEmbeddingFunction();
    if (embeddingFn) {
      const results: Array<Buffer | null> = [];
      for (const entry of entries) {
        try {
          const emb = await embeddingFn(entry.content);
          if (emb && Array.isArray(emb)) {
            const buf = Buffer.from(new Float32Array(emb).buffer);
            results.push(buf);
          } else {
            results.push(null);
          }
        } catch {
          results.push(null);
        }
      }
      embeddings = results;
    } else {
      logger.warn('Embedding function not available, saving without embeddings');
    }
  } catch {
    logger.warn('Embedding module not available, saving without embeddings');
  }

  const upsert = db.prepare(`
    INSERT INTO agent_memories (agent, type, key, content, source, embedding, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(agent, key) DO UPDATE SET
      type = excluded.type,
      content = excluded.content,
      source = excluded.source,
      embedding = excluded.embedding,
      updated_at = datetime('now')
  `);

  const transaction = db.transaction(() => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const emb = embeddings[i];
      upsert.run(entry.agent, entry.type, entry.key, entry.content, entry.source, emb);
    }
  });

  transaction();
  logger.info(`saveAgentMemoriesBatch: saved ${entries.length} entries`);
}

/**
 * エージェント記憶を取得
 */
export function getAgentMemories(
  agent: AgentRole,
  type?: MemoryType
): AgentMemory[] {
  try {
    const db = getDB();
    if (type) {
      return db.prepare(
        'SELECT * FROM agent_memories WHERE agent = ? AND type = ? ORDER BY updated_at DESC'
      ).all(agent, type) as AgentMemory[];
    }
    return db.prepare(
      'SELECT * FROM agent_memories WHERE agent = ? ORDER BY updated_at DESC'
    ).all(agent) as AgentMemory[];
  } catch (err) {
    logger.error('getAgentMemories failed', { agent, type, error: err });
    return [];
  }
}

/**
 * エージェント記憶をキーで取得
 */
export function getAgentMemoryByKey(
  agent: AgentRole,
  key: string
): AgentMemory | undefined {
  try {
    const db = getDB();
    return db.prepare(
      'SELECT * FROM agent_memories WHERE agent = ? AND key = ?'
    ).get(agent, key) as AgentMemory | undefined;
  } catch (err) {
    logger.error('getAgentMemoryByKey failed', { agent, key, error: err });
    return undefined;
  }
}

/**
 * エージェント記憶を削除
 */
export function deleteAgentMemory(agent: AgentRole, key: string): boolean {
  try {
    const db = getDB();
    const result = db.prepare(
      'DELETE FROM agent_memories WHERE agent = ? AND key = ?'
    ).run(agent, key);
    return result.changes > 0;
  } catch (err) {
    logger.error('deleteAgentMemory failed', { agent, key, error: err });
    return false;
  }
}

/**
 * ビルドエラーからの学習を記録
 */
export function recordBuildLearning(
  agent: AgentRole,
  errorSummary: string,
  fixApplied: string
): void {
  try {
    const key = `build_learning_${Date.now()}`;
    const content = `エラー: ${errorSummary}\n修正: ${fixApplied}`;
    saveAgentMemory(agent, 'learning', key, content, 'build_error');
  } catch (err) {
    logger.warn('recordBuildLearning failed', { agent, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * レビューリジェクトからの学習を記録
 */
export function recordRejectLearning(
  agent: AgentRole,
  rejectSummary: string,
  feedback: string
): void {
  try {
    const key = `reject_learning_${Date.now()}`;
    const content = `リジェクト理由: ${rejectSummary}\nフィードバック: ${feedback}`;
    saveAgentMemory(agent, 'learning', key, content, 'review_reject');
  } catch (err) {
    logger.warn('recordRejectLearning failed', { agent, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * エージェントの記憶コンテキストをプロンプト注入用テキストとして構築
 */
export function buildAgentMemoryContext(agent: AgentRole): string {
  try {
    const memories = getAgentMemories(agent);
    if (memories.length === 0) return '';

    const learnings = memories.filter(m => m.type === 'learning').slice(0, 5);
    const patterns = memories.filter(m => m.type === 'pattern').slice(0, 3);
    const preferences = memories.filter(m => m.type === 'preference').slice(0, 3);

    let context = `## ${agent}の記憶・学習\n`;

    if (learnings.length > 0) {
      context += '\n### 過去の学習\n';
      for (const l of learnings) {
        context += `- ${l.content.slice(0, 150)}\n`;
      }
    }

    if (patterns.length > 0) {
      context += '\n### 認識しているパターン\n';
      for (const p of patterns) {
        context += `- ${p.content.slice(0, 150)}\n`;
      }
    }

    if (preferences.length > 0) {
      context += '\n### 設定・嗜好\n';
      for (const pr of preferences) {
        context += `- ${pr.content.slice(0, 150)}\n`;
      }
    }

    return context;
  } catch (err) {
    logger.warn('buildAgentMemoryContext failed', { agent, error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}
