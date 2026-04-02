/**
 * Phase 2.5: 矛盾検出（Mem0式）
 * 記憶保存時にpgvectorで類似記憶を検索し、LLMで矛盾判定。
 * 矛盾時はスナップショット保存+上書き。
 */

import { getRawPool } from '../db/database';
import { callClaude } from '../claude/client';
import { logger } from '../utils/logger';

/** 矛盾検出の結果 */
export interface ContradictionResult {
  hasContradiction: boolean;
  contradictedId?: number;
  explanation?: string;
}

/**
 * 記憶保存前に矛盾を検出する。
 * pgvectorでコサイン距離の近い既存記憶を検索し、LLMで矛盾判定を行う。
 *
 * @param table       対象テーブル ('memories' | 'agent_memories')
 * @param newContent  新規記憶の内容テキスト
 * @param newEmbeddingSql  pgvector形式の埋め込みベクトル文字列 '[0.1,0.2,...]'
 * @param filterColumn  フィルタ対象のカラム名 ('user_id' | 'agent')
 * @param filterValue   フィルタの値 (ユーザーIDまたはエージェント名)
 */
export async function detectContradiction(
  table: 'memories' | 'agent_memories',
  newContent: string,
  newEmbeddingSql: string,
  filterColumn: string,
  filterValue: string,
): Promise<ContradictionResult> {
  try {
    const pool = getRawPool();

    // pgvectorでコサイン距離が近い上位3件を取得
    // <=> はコサイン距離を返す（0に近いほど類似度が高い）
    const sql = `
      SELECT id, key, content
      FROM ${table}
      WHERE ${filterColumn} = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2
      LIMIT 3
    `;
    const { rows } = await pool.query(sql, [filterValue, newEmbeddingSql]);

    if (rows.length === 0) {
      return { hasContradiction: false };
    }

    // コサイン距離 < 0.2 のもの（= コサイン類似度 > 0.8）のみを対象にする
    // pgvectorの <=> はORDER BY用であり、距離値はSELECTで取得する必要がある
    // ここでは上位3件を取得済みなので、距離を再計算して閾値フィルタする
    const distSql = `
      SELECT id, key, content, (embedding <=> $1) AS distance
      FROM ${table}
      WHERE id = ANY($2)
    `;
    const ids = rows.map((r: any) => r.id);
    const { rows: withDistance } = await pool.query(distSql, [newEmbeddingSql, ids]);

    const similar = withDistance.filter((r: any) => r.distance < 0.2);

    if (similar.length === 0) {
      return { hasContradiction: false };
    }

    // LLMで矛盾判定（最も類似度が高い=距離が小さいものから順に判定）
    similar.sort((a: any, b: any) => a.distance - b.distance);

    for (const existing of similar) {
      try {
        const { text } = await callClaude({
          system: '2つの記憶が矛盾しているか判定してください。矛盾している場合は{"contradiction":true,"explanation":"理由"}、していない場合は{"contradiction":false}をJSON形式で返してください。',
          messages: [
            {
              role: 'user',
              content: `既存記憶: ${existing.content}\n新規記憶: ${newContent}`,
            },
          ],
          model: 'default',
          maxTokens: 200,
        });

        // JSONパース
        const jsonMatch = text.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]) as {
            contradiction: boolean;
            explanation?: string;
          };

          if (result.contradiction) {
            // 矛盾を検出 — スナップショットを保存してから返す
            await saveSnapshot(table, existing.id, {
              id: existing.id,
              key: existing.key,
              content: existing.content,
            });

            logger.info('矛盾検出: スナップショット保存完了', {
              table,
              recordId: existing.id,
              explanation: result.explanation,
            });

            return {
              hasContradiction: true,
              contradictedId: existing.id,
              explanation: result.explanation,
            };
          }
        }
      } catch (err) {
        logger.warn('矛盾判定LLM呼び出し失敗', {
          table,
          existingId: existing.id,
          err: err instanceof Error ? err.message : String(err),
        });
        // 1件の判定失敗では中断せず、次の候補を試行
        continue;
      }
    }

    return { hasContradiction: false };
  } catch (err) {
    logger.warn('矛盾検出処理失敗（スキップ）', {
      table,
      err: err instanceof Error ? err.message : String(err),
    });
    // 矛盾検出の失敗は記憶保存をブロックしない
    return { hasContradiction: false };
  }
}

/**
 * 上書き前のスナップショットを memory_snapshots テーブルに保存する。
 * ロールバック用途。
 */
async function saveSnapshot(
  tableName: string,
  recordId: number,
  contentBefore: Record<string, unknown>,
): Promise<void> {
  try {
    const pool = getRawPool();
    await pool.query(
      `INSERT INTO memory_snapshots (table_name, record_id, content_before, operation)
       VALUES ($1, $2, $3, $4)`,
      [tableName, recordId, JSON.stringify(contentBefore), 'contradiction_overwrite'],
    );
  } catch (err) {
    logger.error('スナップショット保存失敗', {
      tableName,
      recordId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
