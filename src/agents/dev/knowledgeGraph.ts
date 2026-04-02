/**
 * Phase 4.5: デプロイ履歴ナレッジグラフ
 * HippoRAG + Graphiti（時間的知識グラフ）に基づく。
 * デプロイ成功/失敗時にグラフを構築し、類似過去開発を検索。
 */
import { getDB, getRawPool } from '../../db/database';
import { embed, embedQuery, embeddingToSql } from '../../memory/embedding';
import { DevConversation } from './conversation';
import { logger } from '../../utils/logger';
import path from 'path';

// ── Helper: find or create a node ────────────────────

async function findOrCreateNode(
  sourceType: string,
  sourceId: string,
  label: string,
  nodeType: string,
  metadata?: Record<string, unknown>,
  embeddingSql?: string | null,
): Promise<number> {
  const db = getDB();

  // 既存ノードを検索
  const existing = await db.prepare(
    `SELECT id FROM knowledge_nodes WHERE source_type = ? AND source_id = ?`
  ).get(sourceType, sourceId) as { id: number } | undefined;

  if (existing) return existing.id;

  // 新規ノードを挿入（embeddingはpgvectorなのでraw poolで直接クエリ）
  const pool = getRawPool();
  const metaJson = metadata ? JSON.stringify(metadata) : null;

  if (embeddingSql) {
    const result = await pool.query(
      `INSERT INTO knowledge_nodes (source_type, source_id, label, node_type, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [sourceType, sourceId, label, nodeType, metaJson, embeddingSql]
    );
    return result.rows[0].id;
  } else {
    const result = await pool.query(
      `INSERT INTO knowledge_nodes (source_type, source_id, label, node_type, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [sourceType, sourceId, label, nodeType, metaJson]
    );
    return result.rows[0].id;
  }
}

// ── Helper: create edge (upsert) ─────────────────────

async function createEdge(
  sourceNodeId: number,
  targetNodeId: number,
  relationType: string,
  weight: number = 1.0,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const pool = getRawPool();
  const metaJson = metadata ? JSON.stringify(metadata) : null;

  await pool.query(
    `INSERT INTO knowledge_edges (source_node_id, target_node_id, relation_type, weight, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_node_id, target_node_id, relation_type)
     DO UPDATE SET weight = $4, metadata = COALESCE($5, knowledge_edges.metadata)`,
    [sourceNodeId, targetNodeId, relationType, weight, metaJson]
  );
}

// ── Record a deploy to the knowledge graph ───────────

export async function recordDeployToGraph(
  conv: DevConversation,
  success: boolean,
): Promise<void> {
  try {
    // 1. トピック+要件のembeddingを生成
    const textToEmbed = `${conv.topic}\n${conv.requirements || ''}`.slice(0, 2000);
    let embSql: string | null = null;
    try {
      const vec = await embed(textToEmbed);
      embSql = embeddingToSql(vec);
    } catch (err) {
      logger.warn('ナレッジグラフ: embedding生成失敗（ノードはembeddingなしで作成）', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. デプロイノードを作成
    const deployNodeId = await findOrCreateNode(
      'dev_conversation',
      conv.id,
      conv.topic,
      'deploy',
      { success, status: conv.status, created_at: conv.created_at },
      embSql,
    );

    // 3. generated_files をパースしてファイルノード+エッジを作成
    let generatedFiles: string[] = [];
    try {
      const parsed = JSON.parse(conv.generated_files || '[]');
      if (Array.isArray(parsed)) generatedFiles = parsed;
    } catch { /* ignore */ }

    for (const filePath of generatedFiles) {
      const fileName = path.basename(filePath);
      const fileNodeId = await findOrCreateNode(
        'file',
        filePath,
        fileName,
        'file',
        { full_path: filePath },
      );
      await createEdge(deployNodeId, fileNodeId, 'generated');
    }

    // 4. 失敗時: エラーノードを作成してリンク
    if (!success) {
      let errorReason = 'デプロイ失敗（ヘルスチェックNG）';
      try {
        const hearingLog = JSON.parse(conv.hearing_log || '[]');
        if (Array.isArray(hearingLog) && hearingLog.length > 0) {
          // 最後のエージェントメッセージからエラー情報を抽出
          const lastAgentMsg = [...hearingLog]
            .reverse()
            .find((e: { role: string; message: string }) => e.role === 'agent');
          if (lastAgentMsg) {
            errorReason = lastAgentMsg.message.slice(0, 500);
          }
        }
      } catch { /* ignore */ }

      const errorNodeId = await findOrCreateNode(
        'error',
        `error-${conv.id}`,
        errorReason.slice(0, 200),
        'error',
        { reason: errorReason, conv_id: conv.id },
      );
      await createEdge(deployNodeId, errorNodeId, 'caused_by');
    }

    // 5. 類似デプロイをベクトル検索でリンク
    if (embSql) {
      try {
        const pool = getRawPool();
        const similar = await pool.query(
          `SELECT id FROM knowledge_nodes
           WHERE node_type = 'deploy'
             AND embedding IS NOT NULL
             AND id != $1
           ORDER BY embedding <=> $2
           LIMIT 3`,
          [deployNodeId, embSql]
        );

        for (const row of similar.rows) {
          await createEdge(deployNodeId, row.id, 'similar_to', 0.8);
        }
      } catch (err) {
        logger.warn('ナレッジグラフ: 類似デプロイ検索失敗', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('ナレッジグラフ: デプロイ記録完了', {
      convId: conv.id,
      success,
      nodeId: deployNodeId,
      fileCount: generatedFiles.length,
    });
  } catch (err) {
    logger.warn('ナレッジグラフ: recordDeployToGraph失敗', {
      err: err instanceof Error ? err.message : String(err),
      convId: conv.id,
    });
  }
}

// ── Find similar deploy experiences ──────────────────

export async function findSimilarDeployExperiences(topic: string): Promise<string> {
  try {
    // 1. トピックをembedding化
    let queryVecSql: string;
    try {
      const vec = await embedQuery(topic);
      queryVecSql = embeddingToSql(vec);
    } catch {
      return '';
    }

    // 2. 類似デプロイノードを検索
    const pool = getRawPool();
    const results = await pool.query(
      `SELECT id, label, metadata, pagerank
       FROM knowledge_nodes
       WHERE node_type = 'deploy'
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $1
       LIMIT 5`,
      [queryVecSql]
    );

    if (results.rows.length === 0) return '';

    // 3. 各デプロイに紐づくファイル・エラーノードを取得
    const lines: string[] = [];

    for (const row of results.rows) {
      const meta = typeof row.metadata === 'string'
        ? JSON.parse(row.metadata)
        : (row.metadata || {});
      const success = meta.success !== false;
      const statusIcon = success ? '成功' : '失敗';

      // 接続ノードを取得
      const edges = await pool.query(
        `SELECT kn.label, kn.node_type, ke.relation_type
         FROM knowledge_edges ke
         JOIN knowledge_nodes kn ON kn.id = ke.target_node_id
         WHERE ke.source_node_id = $1
           AND ke.relation_type IN ('generated', 'caused_by')`,
        [row.id]
      );

      const files = edges.rows
        .filter((e: { node_type: string }) => e.node_type === 'file')
        .map((e: { label: string }) => e.label);
      const errors = edges.rows
        .filter((e: { node_type: string }) => e.node_type === 'error')
        .map((e: { label: string }) => e.label);

      let line = `- [${statusIcon}] ${row.label}`;
      if (files.length > 0) {
        line += ` → ${files.join(', ')}`;
      }
      if (errors.length > 0) {
        line += ` | エラー: ${errors[0]}`;
      }
      lines.push(line);
    }

    if (lines.length === 0) return '';

    return `## 類似過去開発（ナレッジグラフ）\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn('ナレッジグラフ: findSimilarDeployExperiences失敗', {
      err: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

// ── Update PageRank scores ───────────────────────────

export async function updatePageRank(): Promise<void> {
  try {
    const pool = getRawPool();

    // ノード数を取得
    const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM knowledge_nodes`);
    const nodeCount = parseInt(countResult.rows[0].cnt, 10);
    if (nodeCount === 0) return;

    // 初期化: 全ノードを 1/N に設定
    await pool.query(
      `UPDATE knowledge_nodes SET pagerank = $1`,
      [1.0 / nodeCount]
    );

    const d = 0.85;
    const baseRank = (1 - d) / nodeCount;

    // 5回イテレーションで収束
    for (let iter = 0; iter < 5; iter++) {
      await pool.query(
        `UPDATE knowledge_nodes kn
         SET pagerank = $1 + $2 * COALESCE(
           (SELECT SUM(src.pagerank * ke.weight / GREATEST(od.cnt, 1))
            FROM knowledge_edges ke
            JOIN knowledge_nodes src ON src.id = ke.source_node_id
            JOIN (
              SELECT source_node_id, COUNT(*) as cnt
              FROM knowledge_edges
              GROUP BY source_node_id
            ) od ON od.source_node_id = ke.source_node_id
            WHERE ke.target_node_id = kn.id
           ), 0)`,
        [baseRank, d]
      );
    }

    logger.info('ナレッジグラフ: PageRank更新完了', { nodeCount });
  } catch (err) {
    logger.warn('ナレッジグラフ: PageRank更新失敗', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
