/**
 * Phase 6.5: Core Memory（MemGPT/Letta式）
 * 各エージェントの常時参照コア情報スロット。
 * Big Five性格特性によるペルソナアンカリングを含む。
 */
import { getDB } from '../db/database';
import { logger } from '../utils/logger';

/** 全コアメモリスロットを整形テキストで返す */
export async function getCoreMemory(agent: string): Promise<string> {
  const db = getDB();
  const rows: { slot: string; content: string }[] = await db
    .prepare('SELECT slot, content FROM core_memories WHERE agent = ? ORDER BY slot')
    .all(agent);
  if (rows.length === 0) return '';
  return rows.map((r) => `### ${r.slot}\n${r.content}`).join('\n\n');
}

/** 特定スロットの内容を取得 */
export async function getCoreMemorySlot(agent: string, slot: string): Promise<string | null> {
  const db = getDB();
  const row: { content: string } | undefined = await db
    .prepare('SELECT content FROM core_memories WHERE agent = ? AND slot = ?')
    .get(agent, slot);
  return row?.content ?? null;
}

/** スロットをupsert */
export async function setCoreMemorySlot(
  agent: string,
  slot: string,
  content: string,
  maxTokens = 500,
): Promise<void> {
  const db = getDB();
  await db
    .prepare(
      `INSERT INTO core_memories (agent, slot, content, max_tokens)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent, slot) DO UPDATE
         SET content = excluded.content, max_tokens = excluded.max_tokens, updated_at = NOW()`,
    )
    .run(agent, slot, content, maxTokens);
}

/** スロットを削除 */
export async function deleteCoreMemorySlot(agent: string, slot: string): Promise<boolean> {
  const db = getDB();
  const result = await db
    .prepare('DELETE FROM core_memories WHERE agent = ? AND slot = ?')
    .run(agent, slot);
  return result.changes > 0;
}

/** 全エージェントのデフォルトCore Memoryを初期化（既存は上書きしない） */
export async function initializeCoreMemories(): Promise<void> {
  const defaults: Record<string, string> = {
    pm: '開放性=高(新しいアプローチに柔軟), 誠実性=高(計画性重視), 外向性=中(必要な時にリード), 協調性=中(率直にフィードバック), 神経症傾向=低(冷静)',
    engineer:
      '開放性=中(既存パターン重視だが新手法も受容), 誠実性=高(品質こだわり), 外向性=低(黙々と実装), 協調性=高(フィードバックを素直に受容), 神経症傾向=低',
    reviewer:
      '開放性=低(基準に厳格), 誠実性=高(見逃さない), 外向性=中(指摘を明確に伝える), 協調性=中(妥協しないが建設的), 神経症傾向=低',
    deployer:
      '開放性=低(安全第一), 誠実性=高(チェックリスト厳守), 外向性=低(問題がなければ報告のみ), 協調性=高(チームに従う), 神経症傾向=中(慎重)',
  };

  const db = getDB();
  for (const [agent, personality] of Object.entries(defaults)) {
    await db
      .prepare(
        `INSERT INTO core_memories (agent, slot, content)
         VALUES (?, 'role', ?)
         ON CONFLICT(agent, slot) DO NOTHING`,
      )
      .run(agent, personality);
  }
  logger.info('Core Memory初期化完了（既存スロットは保持）');
}
