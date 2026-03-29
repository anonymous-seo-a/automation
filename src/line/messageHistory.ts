import { getDB } from '../db/database';
import { logger } from '../utils/logger';

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** ユーザーまたはアシスタントのメッセージを保存 */
export function saveMessage(userId: string, role: 'user' | 'assistant', content: string): void {
  try {
    const db = getDB();
    db.prepare(
      'INSERT INTO message_history (user_id, role, content) VALUES (?, ?, ?)'
    ).run(userId, role, content);
  } catch (err) {
    logger.error('メッセージ履歴保存失敗', { userId, role, err });
  }
}

/** 直近N件の会話履歴を取得（Claude messages形式で返す） */
export function getRecentHistory(userId: string, limit = 20): HistoryMessage[] {
  const db = getDB();
  const rows = db.prepare(
    'SELECT role, content FROM message_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit) as HistoryMessage[];

  // DESC で取得しているので逆順にして時系列順にする
  return rows.reverse();
}

/** 古い履歴を削除（7日より前） */
export function cleanOldHistory(): void {
  const db = getDB();
  db.prepare(
    "DELETE FROM message_history WHERE created_at < datetime('now', '-7 days')"
  ).run();
}
