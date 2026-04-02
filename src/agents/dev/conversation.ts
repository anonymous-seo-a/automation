import { getDB } from '../../db/database';
import { v4 as uuidv4 } from 'uuid';

export type ConversationStatus =
  | 'hearing'
  | 'defining'
  | 'approved'
  | 'implementing'
  | 'testing'
  | 'stuck'
  | 'deployed'
  | 'failed';

export interface DevConversation {
  id: string;
  user_id: string;
  status: ConversationStatus;
  topic: string;
  hearing_log: string;
  requirements: string | null;
  generated_files: string;
  created_at: string;
  updated_at: string;
}

export function getActiveConversation(userId: string): DevConversation | null {
  const db = getDB();
  // ステータス別タイムアウト:
  //   hearing/defining: 10分（ユーザー応答待ち）
  //   approved/implementing/testing/stuck: 30分（処理中 or クラッシュ復旧）
  const row = db.prepare(`
    SELECT * FROM dev_conversations
    WHERE user_id = ?
      AND status NOT IN ('deployed', 'failed')
      AND NOT (
        status IN ('hearing', 'defining')
        AND updated_at < datetime('now', '-10 minutes')
      )
      AND NOT (
        status IN ('approved', 'implementing', 'testing', 'stuck')
        AND updated_at < datetime('now', '-30 minutes')
      )
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) as DevConversation | undefined;

  // タイムアウトした会話を failed に遷移（次回の新規会話をブロックしないよう）
  if (!row) {
    db.prepare(`
      UPDATE dev_conversations
      SET status = 'failed', updated_at = datetime('now')
      WHERE user_id = ?
        AND status NOT IN ('deployed', 'failed')
        AND (
          (status IN ('hearing', 'defining') AND updated_at < datetime('now', '-10 minutes'))
          OR
          (status IN ('approved', 'implementing', 'testing', 'stuck') AND updated_at < datetime('now', '-30 minutes'))
        )
    `).run(userId);
  }

  return row || null;
}

export function createConversation(userId: string, topic: string): DevConversation {
  const db = getDB();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO dev_conversations (id, user_id, status, topic)
    VALUES (?, ?, 'hearing', ?)
  `).run(id, userId, topic);
  return getConversation(id)!;
}

export function getConversation(id: string): DevConversation | null {
  const db = getDB();
  const row = db.prepare(
    `SELECT * FROM dev_conversations WHERE id = ?`
  ).get(id) as DevConversation | undefined;
  return row || null;
}

export function updateConversationStatus(id: string, status: ConversationStatus): void {
  const db = getDB();
  db.prepare(`
    UPDATE dev_conversations
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, id);
}

export function appendHearingLog(id: string, role: 'user' | 'agent', message: string): void {
  const db = getDB();
  const conv = getConversation(id);
  if (!conv) return;

  let log: Array<{ role: string; message: string }> = [];
  try {
    log = JSON.parse(conv.hearing_log);
  } catch {
    log = [];
  }
  log.push({ role, message });

  db.prepare(`
    UPDATE dev_conversations
    SET hearing_log = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(log), id);
}

export function setRequirements(id: string, requirements: string): void {
  const db = getDB();
  db.prepare(`
    UPDATE dev_conversations
    SET requirements = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(requirements, id);
}

export function setGeneratedFiles(id: string, files: string[]): void {
  const db = getDB();
  db.prepare(`
    UPDATE dev_conversations
    SET generated_files = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(files), id);
}

/** updated_at のみ更新（タイムアウト防止用ハートビート） */
export function touchConversation(id: string): void {
  const db = getDB();
  db.prepare(`UPDATE dev_conversations SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function cancelConversation(id: string): void {
  const db = getDB();
  db.prepare(`
    UPDATE dev_conversations
    SET status = 'failed', updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function getHearingRound(id: string): number {
  const conv = getConversation(id);
  if (!conv) return 0;
  try {
    const log = JSON.parse(conv.hearing_log) as Array<{ role: string }>;
    return log.filter(e => e.role === 'user').length;
  } catch {
    return 0;
  }
}

// ============================================================
// 過去開発履歴参照 (D4)
// ============================================================

export interface DeployedProject {
  id: string;
  topic: string;
  requirements: string | null;
  generated_files: string;
  created_at: string;
  updated_at: string;
}

/** 直近のデプロイ済み開発を取得 */
export function getDeployedConversations(limit: number = 5): DeployedProject[] {
  const db = getDB();
  return db.prepare(`
    SELECT id, topic, requirements, generated_files, created_at, updated_at
    FROM dev_conversations
    WHERE status = 'deployed'
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as DeployedProject[];
}

/** ファイルパスで関連する過去開発を検索（エンジニア/レビュアー用オンデマンド） */
export function searchDeployedByFilePath(filePath: string, limit: number = 3): DeployedProject[] {
  const db = getDB();
  // generated_files はJSON配列。部分一致で検索
  return db.prepare(`
    SELECT id, topic, requirements, generated_files, created_at, updated_at
    FROM dev_conversations
    WHERE status = 'deployed'
      AND generated_files LIKE ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`%${filePath}%`, limit) as DeployedProject[];
}

/** トピックのキーワードで過去開発を検索 */
export function searchDeployedByKeyword(keyword: string, limit: number = 5): DeployedProject[] {
  const db = getDB();
  return db.prepare(`
    SELECT id, topic, requirements, generated_files, created_at, updated_at
    FROM dev_conversations
    WHERE status = 'deployed'
      AND (topic LIKE ? OR requirements LIKE ?)
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`%${keyword}%`, `%${keyword}%`, limit) as DeployedProject[];
}

/** 過去開発履歴のサマリーテキストを構築（PM/分身用） */
export function buildDevHistorySummary(limit: number = 5): string {
  const projects = getDeployedConversations(limit);
  if (projects.length === 0) return '';

  const lines = projects.map((p, i) => {
    const date = p.updated_at.slice(0, 10);
    let files = '';
    try {
      const arr = JSON.parse(p.generated_files) as string[];
      files = arr.map(f => f.split('/').pop()).join(', ');
    } catch {
      files = '(不明)';
    }
    return `${i + 1}. [${date}] ${p.topic} → ${files}`;
  });

  return `## 過去の開発実績（直近${projects.length}件）\n` + lines.join('\n');
}

/** 特定ファイルに関連する過去開発のコンテキストを構築（エンジニア/レビュアー用） */
export function buildRelatedDevContext(filePath: string): string {
  const related = searchDeployedByFilePath(filePath);
  if (related.length === 0) return '';

  const lines = related.map(p => {
    const date = p.updated_at.slice(0, 10);
    return `- [${date}] ${p.topic}`;
  });

  return `## このファイルに関連する過去の開発\n` + lines.join('\n');
}
