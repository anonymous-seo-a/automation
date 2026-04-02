import { getDB } from '../db/database';
import { logger } from '../utils/logger';

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** ユーザーまたはアシスタントのメッセージを保存 */
export async function saveMessage(userId: string, role: 'user' | 'assistant', content: string): Promise<void> {
  try {
    const db = getDB();
    await db.prepare(
      'INSERT INTO message_history (user_id, role, content) VALUES (?, ?, ?)'
    ).run(userId, role, content);
  } catch (err) {
    logger.error('メッセージ履歴保存失敗', { userId, role, err });
  }
}

/** 直近N件の会話履歴を取得（Claude messages形式で返す） */
export async function getRecentHistory(userId: string, limit = 20): Promise<HistoryMessage[]> {
  const db = getDB();
  const rows = await db.prepare(
    'SELECT role, content FROM message_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, limit) as HistoryMessage[];

  // DESC で取得しているので逆順にして時系列順にする
  return rows.reverse();
}

/** 古い履歴を削除（7日より前） */
export async function cleanOldHistory(): Promise<void> {
  const db = getDB();
  await db.prepare(
    "DELETE FROM message_history WHERE created_at < NOW() - INTERVAL '7 days'"
  ).run();
}
