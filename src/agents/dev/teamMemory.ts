import { getDB } from '../../db/database';
import { logger } from '../../utils/logger';
import { embed, embedBatch, embedQuery, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from '../../memory/embedding';
import * as crypto from 'crypto';

export type AgentRole = 'pm' | 'engineer' | 'reviewer' | 'deployer';
export type MemoryType = 'evaluation' | 'learning' | 'preference' | 'pattern';

export interface AgentMemory {
  id: number;
  agent: AgentRole;
  type: MemoryType;
  key: string;
  content: string;
  source: string | null;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
}

export interface AgentMemorySearchResult {
  memory: AgentMemory;
  score: number;
}

/** エラー文字列からカテゴリキーを生成（重複を防ぐ） */
function errorKey(error: string): string {
  const normalized = error
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '')
    .replace(/\d+/g, 'N')
    .trim()
    .slice(0, 100);
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
}

// ============================================================
// 保存
// ============================================================

/** 記憶を保存（同期版、embedding無し） */
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

/** 記憶を保存（非同期版、embedding付き） */
export async function saveAgentMemoryWithEmbedding(
  agent: AgentRole, type: MemoryType, key: string, content: string, source?: string
): Promise<void> {
  const db = getDB();
  let embeddingBuf: Buffer | null = null;

  try {
    const vec = await embed(`[${agent}/${type}] ${key}: ${content}`);
    embeddingBuf = embeddingToBuffer(vec);
  } catch (err) {
    logger.warn('Agent embedding取得失敗（テキストのみ保存）', {
      agent, key, err: err instanceof Error ? err.message : String(err),
    });
  }

  db.prepare(`
    INSERT INTO agent_memories (agent, type, key, content, source, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, type, key) DO UPDATE SET
      content = excluded.content, source = excluded.source,
      embedding = excluded.embedding, updated_at = datetime('now')
  `).run(agent, type, key, content, source || null, embeddingBuf);
}

/** 複数記憶を一括保存（バッチembedding） */
export async function saveAgentMemoriesBatch(
  entries: Array<{ agent: AgentRole; type: MemoryType; key: string; content: string; source?: string }>
): Promise<void> {
  if (entries.length === 0) return;

  // バッチでembedding取得
  const texts = entries.map(e => `[${e.agent}/${e.type}] ${e.key}: ${e.content}`);
  let embeddings: number[][] = [];
  try {
    embeddings = await embedBatch(texts);
  } catch (err) {
    logger.warn('バッチembedding取得失敗（テキストのみ保存）', {
      count: entries.length, err: err instanceof Error ? err.message : String(err),
    });
  }

  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO agent_memories (agent, type, key, content, source, embedding)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, type, key) DO UPDATE SET
      content = excluded.content, source = excluded.source,
      embedding = excluded.embedding, updated_at = datetime('now')
  `);

  const insertMany = db.transaction((items: typeof entries) => {
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      const embBuf = embeddings[i] ? embeddingToBuffer(embeddings[i]) : null;
      stmt.run(e.agent, e.type, e.key, e.content, e.source || null, embBuf);
    }
  });

  insertMany(entries);
  logger.info('エージェント記憶バッチ保存', { count: entries.length, withEmbedding: embeddings.length > 0 });
}

// ============================================================
// 検索
// ============================================================

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

/** セマンティック検索: タスク内容に関連する記憶をTop-K取得 */
export async function searchAgentMemories(
  agent: AgentRole, query: string, topK = 10
): Promise<AgentMemorySearchResult[]> {
  try {
    const db = getDB();
    const queryVec = await embedQuery(query);

    const rows = db.prepare(
      'SELECT * FROM agent_memories WHERE agent = ? AND embedding IS NOT NULL'
    ).all(agent) as AgentMemory[];

    const scored: AgentMemorySearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const memVec = bufferToEmbedding(row.embedding as Buffer);
      const score = cosineSimilarity(queryVec, memVec);
      scored.push({ memory: row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch (err) {
    logger.warn('エージェント意味検索失敗、テキスト検索にフォールバック', {
      agent, err: err instanceof Error ? err.message : String(err),
    });
    return keywordFallback(agent, query, topK);
  }
}

/** キーワードフォールバック検索 */
function keywordFallback(agent: AgentRole, query: string, limit: number): AgentMemorySearchResult[] {
  const db = getDB();
  const rows = db.prepare(
    'SELECT * FROM agent_memories WHERE agent = ? AND (key LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT ?'
  ).all(agent, `%${query}%`, `%${query}%`, limit) as AgentMemory[];
  return rows.map(m => ({ memory: m, score: 0.5 }));
}

// ============================================================
// 学習記録（同期版 — ホットパスで使用、embeddingはバックグラウンドで後追い）
// ============================================================

/** ビルドエラー解決時の学習記録 */
export function recordBuildLearning(
  agent: AgentRole, error: string, fixDescription: string, fixedFilePaths?: string[]
): void {
  const key = `build_fix_${errorKey(error)}`;
  const filesInfo = fixedFilePaths?.length ? `\n修正ファイル: ${fixedFilePaths.join(', ')}` : '';
  const content = `エラー: ${error.slice(0, 200)}\n解決: ${fixDescription.slice(0, 300)}${filesInfo}`;
  saveAgentMemory(agent, 'learning', key, content, 'build_error');
  embedAndUpdateAsync(agent, 'learning', key, content);
  checkAndRecordPattern(agent, extractErrorType(error), error.slice(0, 100));
}

/** テスト失敗解決時の学習記録 */
export function recordTestLearning(
  agent: AgentRole, testStage: string, error: string, fixDescription: string
): void {
  const key = `test_fix_${testStage}_${errorKey(error)}`;
  const content = `テスト(${testStage})エラー: ${error.slice(0, 200)}\n解決: ${fixDescription.slice(0, 300)}`;
  saveAgentMemory(agent, 'learning', key, content, 'test_error');
  embedAndUpdateAsync(agent, 'learning', key, content);
  checkAndRecordPattern(agent, `test_${testStage}_fail`, error.slice(0, 100));
}

/** 差し戻し修正時の学習記録 */
export function recordRejectLearning(agent: AgentRole, issue: string, fix: string): void {
  const key = `reject_fix_${errorKey(issue)}`;
  const content = `指摘: ${issue.slice(0, 200)}\n修正: ${fix.slice(0, 200)}`;
  saveAgentMemory(agent, 'learning', key, content, 'review_reject');
  embedAndUpdateAsync(agent, 'learning', key, content);
  checkAndRecordPattern(agent, 'review_reject', issue.slice(0, 100));
}

/** レビュアーが指摘パターンを記憶する */
export function recordReviewerLearning(
  reviewerFinding: string, severity: string, filePath: string
): void {
  const key = `review_pattern_${errorKey(reviewerFinding)}`;
  const content = `[${severity}] ${reviewerFinding.slice(0, 300)}\nファイル: ${filePath}`;
  saveAgentMemory('reviewer', 'learning', key, content, 'review_finding');
  embedAndUpdateAsync('reviewer', 'learning', key, content);
  checkAndRecordPattern('reviewer', `review_${severity}`, reviewerFinding.slice(0, 100));
}

/** デプロイヤーがテスト失敗パターンを記憶する */
export function recordDeployerLearning(
  stage: string, error: string, outcome: 'fixed' | 'escalated'
): void {
  const key = `deploy_${stage}_${errorKey(error)}`;
  const content = `${stage}失敗: ${error.slice(0, 200)}\n結果: ${outcome === 'fixed' ? '自動修正で解決' : 'エスカレーション'}`;
  saveAgentMemory('deployer', 'learning', key, content, 'deploy_failure');
  embedAndUpdateAsync('deployer', 'learning', key, content);
  checkAndRecordPattern('deployer', `deploy_${stage}_fail`, error.slice(0, 100));
}

/** PMの判断記録 */
export function recordPmLearning(
  key: string, content: string, source: string = 'pm_decision'
): void {
  const sliced = content.slice(0, 400);
  saveAgentMemory('pm', 'learning', `pm_${key}`, sliced, source);
  embedAndUpdateAsync('pm', 'learning', `pm_${key}`, sliced);
}

/** 同期保存後にバックグラウンドでembeddingを付与 */
function embedAndUpdateAsync(agent: AgentRole, type: MemoryType, key: string, content: string): void {
  embed(`[${agent}/${type}] ${key}: ${content}`)
    .then(vec => {
      const buf = embeddingToBuffer(vec);
      getDB().prepare(
        'UPDATE agent_memories SET embedding = ? WHERE agent = ? AND type = ? AND key = ?'
      ).run(buf, agent, type, key);
    })
    .catch(err => {
      logger.debug('Agent embedding非同期付与失敗', { agent, key, err: err instanceof Error ? err.message : String(err) });
    });
}

// ============================================================
// パターン検出
// ============================================================

/** エラー文字列から代表的なエラータイプを抽出 */
function extractErrorType(error: string): string {
  if (/TS\d+/.test(error)) return 'typescript_error';
  if (/Cannot find module/i.test(error)) return 'module_not_found';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(error)) return 'network_error';
  if (/起動前に終了|code:\s*1/i.test(error)) return 'startup_crash';
  if (/ヘルスチェック|health.*check/i.test(error)) return 'healthcheck_fail';
  if (/SQLITE|database/i.test(error)) return 'database_error';
  if (/permission denied|EACCES/i.test(error)) return 'permission_error';
  if (/out of memory|heap/i.test(error)) return 'memory_error';
  return 'unknown_error';
}

/** 繰り返しパターンの検出・記録 */
export function checkAndRecordPattern(agent: AgentRole, errorType: string, details: string): void {
  try {
    const existing = getDB().prepare(
      `SELECT COUNT(*) as cnt FROM agent_memories WHERE agent = ? AND type = 'learning' AND key LIKE ?`
    ).get(agent, `%${errorType}%`) as { cnt: number };

    if (existing.cnt >= 2) {
      saveAgentMemory(agent, 'pattern', `recurring_${errorType}`,
        `繰り返し発生(${existing.cnt}回): ${errorType}\n直近: ${details}\n→ 実装前に事前確認すること`, 'auto_detect');
    }
  } catch (err) {
    logger.warn('パターン検出失敗', { agent, errorType, err: err instanceof Error ? err.message : String(err) });
  }
}

// ============================================================
// コンテキスト構築
// ============================================================

/** メンバーのプロンプトに注入する記憶テキストを構築（同期版・フォールバック） */
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
    if (sections.pattern.length > 0) parts.push(`## ⚠️ 繰り返しパターン（最優先で回避せよ）\n${sections.pattern.slice(0, 5).join('\n')}`);
    if (sections.learning.length > 0) parts.push(`## 過去の学び\n${sections.learning.slice(0, 10).join('\n')}`);
    if (sections.preference.length > 0) parts.push(`## Daikiの好み\n${sections.preference.slice(0, 10).join('\n')}`);
    if (sections.evaluation.length > 0) parts.push(`## 最近の評価\n${sections.evaluation.slice(0, 5).join('\n')}`);

    return parts.join('\n\n');
  } catch (err) {
    logger.warn('記憶コンテキスト構築失敗', { agent, err: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

/** タスクに関連する記憶をセマンティック検索で注入（非同期版） */
export async function buildSmartAgentContext(agent: AgentRole, taskDescription: string): Promise<string> {
  try {
    // まずパターンと評価は常に全量取得（少量なので）
    const allMemories = getRecentAgentMemories(agent);
    const patterns = allMemories.filter(m => m.type === 'pattern');
    const evaluations = allMemories.filter(m => m.type === 'evaluation');
    const preferences = allMemories.filter(m => m.type === 'preference');

    // 学習はセマンティック検索で関連するものだけ取得
    let relevantLearnings: AgentMemorySearchResult[] = [];
    try {
      relevantLearnings = await searchAgentMemories(agent, taskDescription, 8);
      // pattern/evaluation/preferenceは既に取得済みなので除外
      relevantLearnings = relevantLearnings.filter(r =>
        r.memory.type === 'learning' && r.score > 0.3
      );
    } catch {
      // embedding検索失敗時は直近の学習を使う
      const recentLearnings = allMemories.filter(m => m.type === 'learning').slice(0, 8);
      relevantLearnings = recentLearnings.map(m => ({ memory: m, score: 0 }));
    }

    const parts: string[] = [];

    if (patterns.length > 0) {
      parts.push(`## ⚠️ 繰り返しパターン（最優先で回避せよ）\n${patterns.slice(0, 5).map(m => `- ${m.content}`).join('\n')}`);
    }
    if (relevantLearnings.length > 0) {
      parts.push(`## このタスクに関連する過去の学び\n${relevantLearnings.map(r => `- ${r.memory.content}`).join('\n')}`);
    }
    if (preferences.length > 0) {
      parts.push(`## Daikiの好み\n${preferences.slice(0, 10).map(m => `- ${m.content}`).join('\n')}`);
    }
    if (evaluations.length > 0) {
      parts.push(`## 最近の評価\n${evaluations.slice(0, 5).map(m => `- ${m.content}`).join('\n')}`);
    }

    return parts.join('\n\n');
  } catch (err) {
    logger.warn('スマートコンテキスト構築失敗、同期版にフォールバック', {
      agent, err: err instanceof Error ? err.message : String(err),
    });
    return buildAgentMemoryContext(agent);
  }
}
