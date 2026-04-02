import { getDB } from '../db/database';
import { callClaude } from '../claude/client';
import { getRecentHistory } from '../line/messageHistory';
import { saveMemoryWithEmbedding } from './store';
import { logger, dbLog } from '../utils/logger';

export interface ConversationSession {
  id: number;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
  summary: string | null;
}

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30分
const END_SIGNALS = /おやすみ|また[ねー]|じゃあね|ばいばい|さようなら|落ちる|離れる|またあとで/;

// ユーザーごとの最終メッセージ時刻
const lastMessageTime = new Map<string, number>();

/** メッセージ受信時に呼ぶ。セッション追跡を更新。 */
export async function trackMessage(userId: string): Promise<void> {
  lastMessageTime.set(userId, Date.now());

  // アクティブセッションがなければ作成
  const db = getDB();
  const active = await db.prepare(
    "SELECT id FROM conversation_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get(userId) as { id: number } | undefined;

  if (!active) {
    await db.prepare(
      "INSERT INTO conversation_sessions (user_id, message_count) VALUES (?, 1)"
    ).run(userId);
  } else {
    await db.prepare(
      "UPDATE conversation_sessions SET message_count = message_count + 1 WHERE id = ?"
    ).run(active.id);
  }
}

/** 終了合図を検出したか */
export function isEndSignal(text: string): boolean {
  return END_SIGNALS.test(text);
}

/** セッションを明示的に終了し、要約を保存 */
export async function endSession(userId: string): Promise<void> {
  const db = getDB();
  const active = await db.prepare(
    "SELECT * FROM conversation_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
  ).get(userId) as ConversationSession | undefined;

  if (!active) return;
  if (active.message_count < 3) {
    // 3メッセージ未満は要約不要、静かに閉じる
    await db.prepare(
      "UPDATE conversation_sessions SET ended_at = NOW() WHERE id = ?"
    ).run(active.id);
    return;
  }

  try {
    const history = await getRecentHistory(userId, 40);
    if (history.length === 0) {
      await db.prepare(
        "UPDATE conversation_sessions SET ended_at = NOW() WHERE id = ?"
      ).run(active.id);
      return;
    }

    const historyText = history
      .map(m => `${m.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${m.content}`)
      .join('\n');

    const { text: summary } = await callClaude({
      system: `以下の会話を要約してください。要約には:
- 話したトピック（箇条書き）
- ユーザーが表明した意見・好み・感情
- 決まったこと・次のアクション
を含めてください。200文字以内で簡潔に。`,
      messages: [{ role: 'user', content: historyText }],
      model: 'default',
      maxTokens: 500,
    });

    // セッション終了＋要約保存
    await db.prepare(
      "UPDATE conversation_sessions SET ended_at = NOW(), summary = ? WHERE id = ?"
    ).run(summary, active.id);

    // 要約を記憶として保存（embedding付き）
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    await saveMemoryWithEmbedding(
      userId,
      'session_summary',
      `会話_${now}`,
      summary,
    );

    logger.info('セッション要約保存', { userId, sessionId: active.id, summary: summary.slice(0, 100) });
    dbLog('info', 'session', `セッション要約保存: ${summary.slice(0, 80)}`, { userId });
  } catch (err) {
    logger.error('セッション要約失敗', { err: err instanceof Error ? err.message : String(err) });
    await db.prepare(
      "UPDATE conversation_sessions SET ended_at = NOW() WHERE id = ?"
    ).run(active.id);
  }
}

/** 定期チェック: タイムアウトしたセッションを要約して閉じる */
export async function checkIdleSessions(): Promise<void> {
  const now = Date.now();

  for (const [userId, lastTime] of lastMessageTime.entries()) {
    if (now - lastTime >= SESSION_TIMEOUT_MS) {
      lastMessageTime.delete(userId);
      await endSession(userId);
    }
  }
}
