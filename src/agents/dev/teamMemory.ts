import { getDB } from '../../db/database';
import { logger } from '../../utils/logger';
import { embed, embedBatch, embedQuery, cosineSimilarity, embeddingToBuffer, bufferToEmbedding } from '../../memory/embedding';
import { getAgentCache, addToAgentCache, removeFromAgentCache, isCacheInitialized } from '../../memory/embeddingCache';
import { callClaude } from '../../claude/client';
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
  importance: number;
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

/** タイプ別デフォルト重要度 */
function getDefaultAgentImportance(type: MemoryType, source?: string): number {
  if (type === 'pattern') return 5;
  if (type === 'evaluation' && source === 'daiki_feedback') return 4;
  if (type === 'learning') return 3;
  if (type === 'preference') return 2;
  return 3;
}

// ============================================================
// 保存
// ============================================================

/** 記憶を保存（同期版、embedding無し — 高頻度記録用） */
export function saveAgentMemory(
  agent: AgentRole, type: MemoryType, key: string, content: string,
  source?: string, importance?: number,
): void {
  const db = getDB();
  const imp = importance ?? getDefaultAgentImportance(type, source);
  db.prepare(`
    INSERT INTO agent_memories (agent, type, key, content, source, importance)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, type, key) DO UPDATE SET
      content = excluded.content, source = excluded.source,
      importance = excluded.importance, updated_at = datetime('now')
  `).run(agent, type, key, content, source || null, imp);
}

/** 記憶を保存（非同期版、embedding付き） */
export async function saveAgentMemoryWithEmbedding(
  agent: AgentRole, type: MemoryType, key: string, content: string,
  source?: string, importance?: number,
): Promise<void> {
  const db = getDB();
  const imp = importance ?? getDefaultAgentImportance(type, source);
  let embeddingBuf: Buffer | null = null;
  let vec: number[] | null = null;

  try {
    // contentのみをembedする（keyにタイムスタンプやハッシュが含まれるとノイズになる）
    vec = await embed(content);
    embeddingBuf = embeddingToBuffer(vec);
  } catch (err) {
    logger.warn('Agent embedding取得失敗（テキストのみ保存）', {
      agent, key, err: err instanceof Error ? err.message : String(err),
    });
  }

  db.prepare(`
    INSERT INTO agent_memories (agent, type, key, content, source, importance, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, type, key) DO UPDATE SET
      content = excluded.content, source = excluded.source,
      importance = excluded.importance, embedding = excluded.embedding,
      updated_at = datetime('now')
  `).run(agent, type, key, content, source || null, imp, embeddingBuf);

  // キャッシュ更新
  if (vec && isCacheInitialized()) {
    const saved = db.prepare(
      'SELECT id FROM agent_memories WHERE agent = ? AND type = ? AND key = ?'
    ).get(agent, type, key) as { id: number } | undefined;
    if (saved) {
      addToAgentCache(agent, saved.id, type, key, vec, imp);
    }
  }
}

/** 複数記憶を一括保存（バッチembedding） */
export async function saveAgentMemoriesBatch(
  entries: Array<{ agent: AgentRole; type: MemoryType; key: string; content: string; source?: string; importance?: number }>
): Promise<void> {
  if (entries.length === 0) return;

  // バッチでembedding取得 — contentのみ
  const texts = entries.map(e => e.content);
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
    INSERT INTO agent_memories (agent, type, key, content, source, importance, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, type, key) DO UPDATE SET
      content = excluded.content, source = excluded.source,
      importance = excluded.importance, embedding = excluded.embedding,
      updated_at = datetime('now')
  `);

  const insertMany = db.transaction((items: typeof entries) => {
    for (let i = 0; i < items.length; i++) {
      const e = items[i];
      const imp = e.importance ?? getDefaultAgentImportance(e.type, e.source);
      const embBuf = embeddings[i] ? embeddingToBuffer(embeddings[i]) : null;
      stmt.run(e.agent, e.type, e.key, e.content, e.source || null, imp, embBuf);
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
      'SELECT * FROM agent_memories WHERE agent = ? AND type = ? ORDER BY importance DESC, updated_at DESC'
    ).all(agent, type) as AgentMemory[];
  }
  return db.prepare(
    'SELECT * FROM agent_memories WHERE agent = ? ORDER BY type, importance DESC, updated_at DESC'
  ).all(agent) as AgentMemory[];
}

/** 直近N日の記憶のみ取得 */
export function getRecentAgentMemories(agent: AgentRole, days: number = 30): AgentMemory[] {
  const db = getDB();
  return db.prepare(
    `SELECT * FROM agent_memories WHERE agent = ? AND updated_at >= datetime('now', '-' || ? || ' days') ORDER BY importance DESC, updated_at DESC`
  ).all(agent, days) as AgentMemory[];
}

/** セマンティック検索（時間減衰+重要度考慮、キャッシュ対応） */
export async function searchAgentMemories(
  agent: AgentRole, query: string, topK = 10
): Promise<AgentMemorySearchResult[]> {
  try {
    const queryVec = await embedQuery(query);

    // キャッシュ対応
    if (isCacheInitialized()) {
      const cached = getAgentCache(agent);
      const scored: Array<{ id: number; score: number }> = [];

      for (const item of cached) {
        const similarity = cosineSimilarity(queryVec, item.embedding);
        const daysSince = (Date.now() - new Date(item.updated_at).getTime()) / (1000 * 60 * 60 * 24);
        const timeDecay = Math.exp(-daysSince / 30); // エージェントは30日で半減
        const impBoost = (item.importance || 3) / 5;
        const score = similarity * 0.6 + timeDecay * 0.2 + impBoost * 0.2;
        scored.push({ id: item.id, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const topIds = scored.slice(0, topK);

      const db = getDB();
      return topIds.map(r => {
        const full = db.prepare('SELECT * FROM agent_memories WHERE id = ?').get(r.id) as AgentMemory;
        return { memory: full, score: r.score };
      }).filter(r => r.memory);
    }

    // キャッシュ未初期化時はDB直接
    const db = getDB();
    const rows = db.prepare(
      'SELECT * FROM agent_memories WHERE agent = ? AND embedding IS NOT NULL'
    ).all(agent) as AgentMemory[];

    const scored: AgentMemorySearchResult[] = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const memVec = bufferToEmbedding(row.embedding as Buffer);
      const similarity = cosineSimilarity(queryVec, memVec);
      const daysSince = (Date.now() - new Date(row.updated_at).getTime()) / (1000 * 60 * 60 * 24);
      const timeDecay = Math.exp(-daysSince / 30);
      const impBoost = (row.importance || 3) / 5;
      const score = similarity * 0.6 + timeDecay * 0.2 + impBoost * 0.2;
      scored.push({ memory: row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  } catch (err) {
    logger.warn('エージェント意味検索失敗、フォールバック', {
      agent, err: err instanceof Error ? err.message : String(err),
    });
    // フォールバック: importance順 + 新しい順
    return getDB().prepare(
      "SELECT * FROM agent_memories WHERE agent = ? AND updated_at >= datetime('now', '-30 days') ORDER BY importance DESC, updated_at DESC LIMIT ?"
    ).all(agent, topK).map((m: any) => ({ memory: m as AgentMemory, score: 0.5 }));
  }
}

/** キーワードフォールバック検索 */
function keywordFallback(agent: AgentRole, query: string, limit: number): AgentMemorySearchResult[] {
  const db = getDB();
  const rows = db.prepare(
    'SELECT * FROM agent_memories WHERE agent = ? AND (key LIKE ? OR content LIKE ?) ORDER BY importance DESC, updated_at DESC LIMIT ?'
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

/** 差し戻し修正時の学習記録（ERL式ヒューリスティック形式）
 *  ナラティブ形式で「いつ・何が起きて・どうすべきだったか」を記録 */
export function recordRejectLearning(agent: AgentRole, issue: string, fix: string, filePath?: string): void {
  const key = `reject_fix_${errorKey(issue)}`;
  // ERL式: トリガー条件 + 失敗パターン + 推奨アクションの構造化ヒューリスティック
  const fileHint = filePath ? `\nファイル: ${filePath}` : '';
  const content = [
    `【過去の失敗経験】`,
    `状況: ${fileHint ? filePath + ' の実装中に' : '実装中に'}レビュアーから差し戻された`,
    `指摘内容: ${issue.slice(0, 300)}`,
    `教訓: ${fix.slice(0, 300)}`,
    `→ 同様のファイルを実装する際は、この指摘を事前に確認してから実装を開始すること`,
  ].join('\n');
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

/** 同期保存後にバックグラウンドでembeddingを付与（+ キャッシュ更新） */
function embedAndUpdateAsync(agent: AgentRole, type: MemoryType, key: string, content: string): void {
  // contentのみをembed
  embed(content)
    .then(vec => {
      const buf = embeddingToBuffer(vec);
      const db = getDB();
      db.prepare(
        'UPDATE agent_memories SET embedding = ? WHERE agent = ? AND type = ? AND key = ?'
      ).run(buf, agent, type, key);

      // キャッシュ更新
      if (isCacheInitialized()) {
        const saved = db.prepare(
          'SELECT id, importance FROM agent_memories WHERE agent = ? AND type = ? AND key = ?'
        ).get(agent, type, key) as { id: number; importance: number } | undefined;
        if (saved) {
          addToAgentCache(agent, saved.id, type, key, vec, saved.importance || 3);
        }
      }
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

/** 繰り返しパターンの検出・記録（importance: 5で保存）
 *  意味検索で類似の過去学習を探し、閾値以上の類似度のものが2件以上あればパターン化 */
export function checkAndRecordPattern(agent: AgentRole, errorType: string, details: string): void {
  // 非同期でセマンティック検索を実行（呼び出し元をブロックしない）
  checkAndRecordPatternAsync(agent, errorType, details).catch(err => {
    logger.warn('パターン検出失敗', { agent, errorType, err: err instanceof Error ? err.message : String(err) });
  });
}

async function checkAndRecordPatternAsync(agent: AgentRole, errorType: string, details: string): Promise<void> {
  const SIMILARITY_THRESHOLD = 0.4; // この閾値以上を「類似」とみなす
  const MIN_OCCURRENCES = 2;        // パターン化に必要な最小出現数

  try {
    // 意味検索で類似の学習記録を探す
    const query = `${errorType}: ${details}`;
    const results = await searchAgentMemories(agent, query, 10);

    // learning タイプのみ、かつ閾値以上の類似度のものをカウント
    const similar = results.filter(r =>
      r.memory.type === 'learning' && r.score >= SIMILARITY_THRESHOLD
    );

    if (similar.length >= MIN_OCCURRENCES) {
      // 既にパターンとして記録済みか確認
      const existingPattern = getDB().prepare(
        "SELECT id FROM agent_memories WHERE agent = ? AND type = 'pattern' AND key = ?"
      ).get(agent, `recurring_${errorType}`) as { id: number } | undefined;

      const content = `繰り返し発生(${similar.length}回検出): ${errorType}\n直近: ${details}\n類似事例: ${similar.slice(0, 3).map(r => r.memory.content.slice(0, 80)).join(' / ')}\n→ 実装前に事前確認すること`;

      if (existingPattern) {
        // 既存パターンを更新（最新情報で上書き）
        getDB().prepare(
          'UPDATE agent_memories SET content = ?, importance = 5, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(content, existingPattern.id);
      } else {
        saveAgentMemory(agent, 'pattern', `recurring_${errorType}`, content, 'auto_detect', 5);
      }
      logger.info('パターン検出', { agent, errorType, similarCount: similar.length });
    }
  } catch {
    // embedding未対応時はキーワードフォールバック（従来動作）
    const existing = getDB().prepare(
      `SELECT COUNT(*) as cnt FROM agent_memories WHERE agent = ? AND type = 'learning' AND key LIKE ?`
    ).get(agent, `%${errorType}%`) as { cnt: number };

    if (existing.cnt >= MIN_OCCURRENCES) {
      saveAgentMemory(agent, 'pattern', `recurring_${errorType}`,
        `繰り返し発生(${existing.cnt}回): ${errorType}\n直近: ${details}\n→ 実装前に事前確認すること`,
        'auto_detect', 5);
    }
  }
}

// ============================================================
// コンテキスト構築
// ============================================================

/** メンバーのプロンプトに注入する記憶テキストを構築（非同期版・意味検索対応） */
export async function buildAgentMemoryContext(agent: AgentRole, taskContext?: string): Promise<string> {
  try {
    // patternタイプは常に全件含める（致命的警告は見逃してはいけない）
    const patterns = getAgentMemories(agent, 'pattern');

    // それ以外はタスク文脈で意味検索
    let relevant: AgentMemory[] = [];
    if (taskContext) {
      const results = await searchAgentMemories(agent, taskContext, 10);
      // patternと重複するものを除外
      const patternIds = new Set(patterns.map(p => p.id));
      relevant = results.filter(r => !patternIds.has(r.memory.id)).map(r => r.memory);
    } else {
      // タスク文脈がない場合はimportance順で上位10件
      relevant = getDB().prepare(
        "SELECT * FROM agent_memories WHERE agent = ? AND type != 'pattern' AND updated_at >= datetime('now', '-30 days') ORDER BY importance DESC, updated_at DESC LIMIT 10"
      ).all(agent) as AgentMemory[];
    }

    const parts: string[] = [];

    if (patterns.length > 0) {
      parts.push(`## ⚠️ 絶対に忘れてはいけないこと\n${patterns.map(p => `- ${p.content}`).join('\n')}`);
    }

    if (relevant.length > 0) {
      // typeごとにグループ化
      const groups: Record<string, string[]> = {};
      for (const m of relevant) {
        const label = m.type === 'learning' ? '学んだこと' :
                      m.type === 'evaluation' ? '最近の評価' :
                      m.type === 'preference' ? 'Daikiの好み' : m.type;
        if (!groups[label]) groups[label] = [];
        groups[label].push(`- ${m.content}`);
      }
      for (const [label, items] of Object.entries(groups)) {
        parts.push(`## ${label}\n${items.join('\n')}`);
      }
    }

    return parts.join('\n\n');
  } catch (err) {
    logger.warn('記憶コンテキスト構築失敗', { agent, err: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

/** 後方互換: 同期版（キャッシュやtaskContextなし、フォールバック用） */
export function buildAgentMemoryContextSync(agent: AgentRole): string {
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
    logger.warn('記憶コンテキスト構築失敗（同期版）', { agent, err: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

// ============================================================
// エージェント記憶の統合（記憶が30件を超えたら実行）
// ============================================================

export async function consolidateAgentMemories(agent: AgentRole): Promise<void> {
  const allMemories = getAgentMemories(agent);
  if (allMemories.length < 30) return;

  const learnings = allMemories.filter(m => m.type === 'learning');
  if (learnings.length < 15) return;

  const memoryText = learnings
    .map(m => `[importance:${m.importance || 3}] ${m.key}: ${m.content}`)
    .join('\n');

  try {
    const { text } = await callClaude({
      system: `あなたはAIエージェントの記憶整理担当です。
以下のlearning記憶を整理してください。

ルール:
1. 同じ原因のエラー記憶は1つに統合（最も具体的な解決策を残す）
2. 3回以上出現するパターンはpatternに昇格（importance: 5）
3. 古くて一般的すぎる記憶は削除候補
4. 統合後の記憶は元より少なくなること

出力形式（JSONのみ）:
{
  "consolidated": [
    {"key": "統合後のキー", "content": "統合後の内容", "importance": 3, "type": "learning"}
  ],
  "promote_to_pattern": [
    {"key": "パターン名", "content": "パターンの説明", "importance": 5}
  ],
  "delete_keys": ["削除する元のキー1", "削除する元のキー2"]
}`,
      messages: [{ role: 'user', content: `エージェント: ${agent}\nlearning記憶（${learnings.length}件）:\n${memoryText}` }],
      model: 'default',
      maxTokens: 1500,
    });

    // パース
    let jsonStr = text.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    const result = JSON.parse(jsonStr) as {
      consolidated: Array<{ key: string; content: string; importance: number; type: string }>;
      promote_to_pattern: Array<{ key: string; content: string; importance: number }>;
      delete_keys: string[];
    };

    const db = getDB();

    // 1. delete_keysの記憶を削除（キャッシュも同期）
    if (result.delete_keys?.length > 0) {
      for (const key of result.delete_keys) {
        // DELETE前にIDを取得（DELETE後ではレコードが消えておりIDが取れない）
        const row = db.prepare(
          'SELECT id FROM agent_memories WHERE agent = ? AND key = ?'
        ).get(agent, key) as { id: number } | undefined;

        const deleted = db.prepare(
          "DELETE FROM agent_memories WHERE agent = ? AND type = 'learning' AND key = ?"
        ).run(agent, key);

        if (deleted.changes > 0 && row && isCacheInitialized()) {
          removeFromAgentCache(agent, row.id);
        }
      }
      logger.info('エージェント記憶削除', { agent, count: result.delete_keys.length });
    }

    // 2. consolidatedの記憶を保存
    if (result.consolidated?.length > 0) {
      for (const mem of result.consolidated) {
        await saveAgentMemoryWithEmbedding(
          agent, (mem.type || 'learning') as MemoryType, mem.key, mem.content,
          'consolidation', mem.importance || 3,
        );
      }
      logger.info('エージェント記憶統合', { agent, count: result.consolidated.length });
    }

    // 3. promote_to_patternの記憶をpatternとして保存
    if (result.promote_to_pattern?.length > 0) {
      for (const mem of result.promote_to_pattern) {
        await saveAgentMemoryWithEmbedding(
          agent, 'pattern', mem.key, mem.content,
          'consolidation', 5,
        );
      }
      logger.info('エージェント記憶パターン昇格', { agent, count: result.promote_to_pattern.length });
    }

    logger.info('エージェント記憶統合完了', {
      agent, before: learnings.length,
      deleted: result.delete_keys?.length || 0,
      consolidated: result.consolidated?.length || 0,
      promoted: result.promote_to_pattern?.length || 0,
    });
  } catch (err) {
    logger.warn('エージェント記憶統合失敗', { agent, err: err instanceof Error ? err.message : String(err) });
  }
}
