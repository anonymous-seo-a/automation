import { getDB } from '../db/database';
import { logger } from '../utils/logger';

export type MemoryType = 'profile' | 'project' | 'memo';

export interface Memory {
  id: number;
  user_id: string;
  type: MemoryType;
  key: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/** 記憶を保存（同じkey+typeなら上書き） */
export function saveMemory(userId: string, type: MemoryType, key: string, content: string): void {
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

/** 特定タイプの記憶を全取得 */
export function getMemories(userId: string, type?: MemoryType): Memory[] {
  try {
    const db = getDB();
    if (type) {
      return db.prepare(
        'SELECT * FROM memories WHERE user_id = ? AND type = ? ORDER BY updated_at DESC'
      ).all(userId, type) as Memory[];
    }
    return db.prepare(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY type, updated_at DESC'
    ).all(userId) as Memory[];
  } catch (err) {
    logger.error('記憶取得失敗', { userId, type, err });
    return [];
  }
}

/** キーワードで記憶を検索 */
export function searchMemories(userId: string, query: string): Memory[] {
  try {
    const db = getDB();
    return db.prepare(
      'SELECT * FROM memories WHERE user_id = ? AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT 10'
    ).all(userId, `%${query}%`, `%${query}%`) as Memory[];
  } catch (err) {
    logger.error('記憶検索失敗', { userId, query, err });
    return [];
  }
}

/** 記憶を削除 */
export function deleteMemory(userId: string, type: MemoryType, key: string): boolean {
  try {
    const db = getDB();
    const result = db.prepare(
      'DELETE FROM memories WHERE user_id = ? AND type = ? AND key = ?'
    ).run(userId, type, key);
    return result.changes > 0;
  } catch (err) {
    logger.error('記憶削除失敗', { userId, type, key, err });
    return false;
  }
}

/** Claudeのシステムプロンプトに含める記憶コンテキストを構築 */
export function buildMemoryContext(userId: string): string {
  const memories = getMemories(userId);
  if (memories.length === 0) return '';

  const sections: string[] = [];

  const profiles = memories.filter(m => m.type === 'profile');
  if (profiles.length > 0) {
    sections.push('## ユーザー情報\n' + profiles.map(m => `- ${m.key}: ${m.content}`).join('\n'));
  }

  const projects = memories.filter(m => m.type === 'project');
  if (projects.length > 0) {
    sections.push('## プロジェクト記憶\n' + projects.map(m => `- ${m.key}: ${m.content}`).join('\n'));
  }

  const memos = memories.filter(m => m.type === 'memo');
  if (memos.length > 0) {
    sections.push('## メモ\n' + memos.map(m => `- ${m.key}: ${m.content}`).join('\n'));
  }

  return '\n\n' + sections.join('\n\n');
}
