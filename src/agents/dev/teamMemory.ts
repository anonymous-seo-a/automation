import { getDB } from '../../db/database';
import { logger } from '../../utils/logger';

export type AgentRole = 'pm' | 'engineer' | 'reviewer' | 'deployer';
export type MemoryType = 'evaluation' | 'learning' | 'preference' | 'pattern';

export interface AgentMemory {
  id: number;
  agent: AgentRole;
  type: MemoryType;
  key: string;
  content: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

/** 記憶を保存（同じagent+type+keyがあれば上書き） */
export function saveAgentMemory(
  agent: AgentRole, type: MemoryType, key: string, content: string, source?: string
): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO agent_memories (agent, type, key, content, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent, type, key) DO UPDATE SET
      content = excluded.content, source = excluded.source, updated_at = datetime('now')
  `).run(agent, type, key, content, source || null);
}

/** 指定メンバーの全記憶を取得 */
export function getAgentMemories(agent: AgentRole, type?: MemoryType): AgentMemory[] {
  const db = getDB();
  if (type) {
    return db.prepare(
      'SELECT * FROM agent_memories WHERE agent = ? AND type = ? ORDER BY updated_at DESC'
    ).all(agent, type) as AgentMemory[];
  }
  return db.prepare(
    'SELECT * FROM agent_memories WHERE agent = ? ORDER BY type, updated_at DESC'
  ).all(agent) as AgentMemory[];
}

/** 直近N日の記憶のみ取得 */
export function getRecentAgentMemories(agent: AgentRole, days: number = 30): AgentMemory[] {
  const db = getDB();
  return db.prepare(
    `SELECT * FROM agent_memories WHERE agent = ? AND updated_at >= datetime('now', '-' || ? || ' days') ORDER BY updated_at DESC`
  ).all(agent, days) as AgentMemory[];
}

/** ビルドエラー解決時の学習記録 */
export function recordBuildLearning(agent: AgentRole, error: string, solution: string): void {
  saveAgentMemory(agent, 'learning', `build_fix_${Date.now()}`,
    `エラー: ${error.slice(0, 200)}\n解決: ${solution.slice(0, 200)}`, 'build_error');
}

/** 差し戻し修正時の学習記録 */
export function recordRejectLearning(agent: AgentRole, issue: string, fix: string): void {
  saveAgentMemory(agent, 'learning', `reject_fix_${Date.now()}`,
    `指摘: ${issue.slice(0, 200)}\n修正: ${fix.slice(0, 200)}`, 'review_reject');
}

/** 繰り返しパターンの検出・記録 */
export function checkAndRecordPattern(agent: AgentRole, errorType: string, details: string): void {
  const existing = getDB().prepare(
    `SELECT COUNT(*) as cnt FROM agent_memories WHERE agent = ? AND type = 'learning' AND content LIKE ?`
  ).get(agent, `%${errorType}%`) as { cnt: number };

  if (existing.cnt >= 1) {
    saveAgentMemory(agent, 'pattern', `recurring_${errorType}`,
      `繰り返し発生: ${errorType}\n詳細: ${details}\n→ 事前に確認すること`, 'auto_detect');
  }
}

/** メンバーのプロンプトに注入する記憶テキストを構築 */
export function buildAgentMemoryContext(agent: AgentRole): string {
  try {
    const memories = getRecentAgentMemories(agent);
    if (memories.length === 0) return '';

    const sections: Record<MemoryType, string[]> = {
      evaluation: [], learning: [], preference: [], pattern: [],
    };

    for (const m of memories) {
      sections[m.type as MemoryType]?.push(`- ${m.content}`);
    }

    const parts: string[] = [];
    if (sections.learning.length > 0) parts.push(`## 学んだこと\n${sections.learning.slice(0, 10).join('\n')}`);
    if (sections.pattern.length > 0) parts.push(`## ⚠️ 繰り返しパターン\n${sections.pattern.slice(0, 5).join('\n')}`);
    if (sections.preference.length > 0) parts.push(`## Daikiの好み\n${sections.preference.slice(0, 10).join('\n')}`);
    if (sections.evaluation.length > 0) parts.push(`## 最近の評価\n${sections.evaluation.slice(0, 5).join('\n')}`);

    return parts.join('\n\n');
  } catch (err) {
    logger.warn('記憶コンテキスト構築失敗', { agent, err: err instanceof Error ? err.message : String(err) });
    return '';
  }
}
