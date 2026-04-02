/**
 * Phase 3.5: ハイブリッド3重検索 + HippoRAG PageRank
 * Level 1: BM25キーワード検索（pg_trgm）
 * Level 2: セマンティック検索（pgvector）
 * Level 3: グラフ探索 + Personalized PageRank（再帰CTE）
 * 統合: Reciprocal Rank Fusion
 */
import { getRawPool } from '../db/database';
import { embedQuery, embeddingToSql } from './embedding';
import { logger } from '../utils/logger';

export interface SearchResult {
  id: number;
  content: string;
  key: string;
  type: string;
  score: number;
}

interface GraphSearchResult {
  id: number;
  label: string;
  node_type: string;
  metadata: any;
  pagerank_score: number;
}

// ============================================================
// Level 1: pg_trgm キーワード検索
// ============================================================

export async function keywordSearch(
  query: string,
  table: 'memories' | 'agent_memories',
  filterColumn: string,
  filterValue: string,
  limit = 10,
): Promise<SearchResult[]> {
  try {
    const pool = getRawPool();
    const sql = `
      SELECT id, content, key, type,
             similarity(content, $1) AS sim
      FROM ${table}
      WHERE ${filterColumn} = $2
        AND content % $1
      ORDER BY sim DESC
      LIMIT $3
    `;
    const { rows } = await pool.query(sql, [query, filterValue, limit]);
    return rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      key: r.key,
      type: r.type,
      score: parseFloat(r.sim) || 0,
    }));
  } catch (err) {
    logger.debug('Level1 キーワード検索失敗', {
      table,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ============================================================
// Level 2: pgvector セマンティック検索
// ============================================================

export async function semanticSearch(
  queryVecSql: string,
  table: 'memories' | 'agent_memories',
  filterColumn: string,
  filterValue: string,
  limit = 10,
): Promise<SearchResult[]> {
  try {
    const pool = getRawPool();
    const sql = `
      SELECT id, content, key, type,
             1 - (embedding <=> $1::vector) AS score
      FROM ${table}
      WHERE ${filterColumn} = $2
        AND embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `;
    const { rows } = await pool.query(sql, [queryVecSql, filterValue, limit]);
    return rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      key: r.key,
      type: r.type,
      score: parseFloat(r.score) || 0,
    }));
  } catch (err) {
    logger.debug('Level2 セマンティック検索失敗', {
      table,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ============================================================
// Level 3: グラフ探索 + Personalized PageRank（再帰CTE）
// ============================================================

export async function graphSearchWithPageRank(
  queryVecSql: string,
  limit = 10,
): Promise<GraphSearchResult[]> {
  try {
    const pool = getRawPool();

    // まずknowledge_nodesにデータがあるか確認（空テーブルなら即return）
    const countResult = await pool.query(
      'SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE embedding IS NOT NULL',
    );
    if (parseInt(countResult.rows[0]?.cnt || '0', 10) === 0) {
      return [];
    }

    const sql = `
      WITH RECURSIVE
      seed AS (
        SELECT id, 1.0 / COUNT(*) OVER () AS rank
        FROM knowledge_nodes
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      ),
      ppr AS (
        SELECT id, rank, 0 AS iteration FROM seed
        UNION ALL
        SELECT
          ke.target_node_id AS id,
          0.85 * SUM(ppr.rank * ke.weight / GREATEST(out_deg.cnt, 1)) AS rank,
          ppr.iteration + 1 AS iteration
        FROM ppr
        JOIN knowledge_edges ke ON ke.source_node_id = ppr.id
        JOIN (
          SELECT source_node_id, COUNT(*) AS cnt
          FROM knowledge_edges
          GROUP BY source_node_id
        ) out_deg ON out_deg.source_node_id = ppr.id
        WHERE ppr.iteration < 3
        GROUP BY ke.target_node_id, ppr.iteration
      )
      SELECT
        kn.id, kn.label, kn.node_type, kn.metadata,
        SUM(ppr.rank) AS pagerank_score
      FROM ppr
      JOIN knowledge_nodes kn ON kn.id = ppr.id
      GROUP BY kn.id, kn.label, kn.node_type, kn.metadata
      ORDER BY pagerank_score DESC
      LIMIT $2
    `;

    const { rows } = await pool.query(sql, [queryVecSql, limit]);
    return rows.map((r: any) => ({
      id: r.id,
      label: r.label,
      node_type: r.node_type,
      metadata: r.metadata,
      pagerank_score: parseFloat(r.pagerank_score) || 0,
    }));
  } catch (err) {
    logger.debug('Level3 グラフ検索失敗', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ============================================================
// Reciprocal Rank Fusion（RRF）統合
// ============================================================

const RRF_K = 60; // RRFの定数k

/**
 * ハイブリッド3重検索: BM25 + Semantic + Graph を RRF で統合
 *
 * @param query 検索クエリ文字列
 * @param table 対象テーブル
 * @param filterColumn フィルタカラム名（user_id / agent）
 * @param filterValue フィルタ値
 * @param limit 返却件数上限
 */
export async function hybridSearch(
  query: string,
  table: 'memories' | 'agent_memories',
  filterColumn: string,
  filterValue: string,
  limit = 10,
): Promise<SearchResult[]> {
  try {
    // 1. embedding取得
    const queryVec = await embedQuery(query);
    const queryVecSql = embeddingToSql(queryVec);

    // 2. Level 1 + Level 2 を並列実行
    const [kwResults, semResults] = await Promise.all([
      keywordSearch(query, table, filterColumn, filterValue, limit * 2),
      semanticSearch(queryVecSql, table, filterColumn, filterValue, limit * 2),
    ]);

    // 3. Level 3 グラフ検索（オプション）
    let graphResults: GraphSearchResult[] = [];
    try {
      graphResults = await graphSearchWithPageRank(queryVecSql, limit);
    } catch {
      // グラフ検索失敗は無視
    }

    // 4. RRF統合
    // 各結果リストでのrank（0始まり）からRRFスコアを計算
    const fusedScores = new Map<number, { result: SearchResult; rrfScore: number }>();

    // Level 1: キーワード検索結果
    for (let rank = 0; rank < kwResults.length; rank++) {
      const r = kwResults[rank];
      const rrfContribution = 1 / (RRF_K + rank + 1);
      const existing = fusedScores.get(r.id);
      if (existing) {
        existing.rrfScore += rrfContribution;
      } else {
        fusedScores.set(r.id, { result: r, rrfScore: rrfContribution });
      }
    }

    // Level 2: セマンティック検索結果
    for (let rank = 0; rank < semResults.length; rank++) {
      const r = semResults[rank];
      const rrfContribution = 1 / (RRF_K + rank + 1);
      const existing = fusedScores.get(r.id);
      if (existing) {
        existing.rrfScore += rrfContribution;
      } else {
        fusedScores.set(r.id, { result: r, rrfScore: rrfContribution });
      }
    }

    // Level 3: グラフ検索結果（knowledge_nodesのIDはmemories/agent_memoriesのIDと異なるため
    // metadata内のsource_idで対応付けを試みる。対応がなければグラフスコアは加算のみ）
    // グラフ結果はメモリIDとは直接対応しないが、
    // メタデータにsource_id（memories/agent_memories参照）があれば対応付ける
    if (graphResults.length > 0) {
      for (let rank = 0; rank < graphResults.length; rank++) {
        const gr = graphResults[rank];
        const rrfContribution = 1 / (RRF_K + rank + 1);
        // metadata.source_idがあり、それがfusedScoresに存在すれば加算
        const sourceId = gr.metadata?.source_id ? parseInt(gr.metadata.source_id, 10) : null;
        if (sourceId && fusedScores.has(sourceId)) {
          fusedScores.get(sourceId)!.rrfScore += rrfContribution;
        }
        // 対応するメモリがない場合、グラフ結果のlabelをcontentとして追加
        // （ただしtableのidではないので、対応がない場合はスキップ）
      }
    }

    // 5. スコア順にソートしてtop-limit返却
    const sorted = [...fusedScores.values()]
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit);

    logger.debug('ハイブリッド検索完了', {
      table,
      query: query.slice(0, 50),
      kwHits: kwResults.length,
      semHits: semResults.length,
      graphHits: graphResults.length,
      fusedCount: sorted.length,
    });

    return sorted.map(({ result, rrfScore }) => ({
      ...result,
      score: rrfScore,
    }));
  } catch (err) {
    logger.warn('ハイブリッド検索失敗', {
      table,
      err: err instanceof Error ? err.message : String(err),
    });
    // ハイブリッド検索が完全に失敗した場合は空配列を返す
    // 呼び出し元が既存のフォールバックを使うことを期待
    return [];
  }
}
