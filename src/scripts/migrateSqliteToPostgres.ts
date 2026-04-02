/**
 * SQLite → PostgreSQL データ移行スクリプト
 *
 * 使い方:
 *   1. .env に DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD を設定
 *   2. .env に DB_PATH（SQLiteのパス）を設定
 *   3. npx tsx src/scripts/migrateSqliteToPostgres.ts
 *
 * 安全策:
 *   - PostgreSQL側のテーブルは runMigrations() で事前作成される
 *   - 既存レコードはON CONFLICT DO NOTHINGでスキップ（冪等）
 *   - embeddingはBLOB→pgvector文字列に変換
 *   - SERIAL列のシーケンスを移行後にリセット
 */
import dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import pg from 'pg';

// --- 接続情報 ---
const SQLITE_PATH = process.env.DB_PATH || './data/mothership.db';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'mothership_db',
  user: process.env.DB_USER || 'mothership',
  password: process.env.DB_PASSWORD || '',
  max: 5,
});

// --- ヘルパー ---

/** SQLiteのBLOB(Float32Array) → pgvector文字列 '[0.1,0.2,...]' */
function blobToVectorSql(buf: Buffer | null): string | null {
  if (!buf || buf.length === 0) return null;
  try {
    const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return '[' + Array.from(float32).join(',') + ']';
  } catch {
    return null;
  }
}

/** テーブルの行数を取得 */
function sqliteCount(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

/** バッチINSERT（冪等: ON CONFLICT DO NOTHING） */
async function batchInsert(
  client: pg.PoolClient,
  sql: string,
  rows: unknown[][],
  batchSize = 100,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const params of batch) {
      try {
        const result = await client.query(sql, params);
        inserted += result.rowCount ?? 0;
      } catch (err) {
        // 個別エラーはログして続行
        console.error(`  ⚠ INSERT失敗: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return inserted;
}

/** SERIALシーケンスをMAX(id)+1にリセット */
async function resetSequence(client: pg.PoolClient, table: string, column = 'id'): Promise<void> {
  try {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table}', '${column}'), COALESCE(MAX(${column}), 0) + 1, false) FROM ${table}`
    );
  } catch {
    // シーケンスがない場合（TEXT PKなど）は無視
  }
}

// --- メイン ---

async function main(): Promise<void> {
  console.log('=== SQLite → PostgreSQL データ移行 ===');
  console.log(`SQLite: ${SQLITE_PATH}`);
  console.log(`PostgreSQL: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  console.log('');

  // SQLite接続
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  sqlite.pragma('journal_mode = WAL');

  // PostgreSQL接続
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // --- 1. tasks (TEXT PK) ---
    {
      const table = 'tasks';
      const rows = sqlite.prepare('SELECT * FROM tasks').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO tasks (id, parent_id, agent, description, status, priority, retry_count, max_retries, input_data, output_data, error_log, requires_opus, created_at, updated_at, completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`;
      const params = rows.map(r => [r.id, r.parent_id, r.agent, r.description, r.status, r.priority, r.retry_count, r.max_retries, r.input_data, r.output_data, r.error_log, r.requires_opus, r.created_at, r.updated_at, r.completed_at]);
      const n = await batchInsert(client, sql, params);
      console.log(`  → ${n}行挿入`);
    }

    // --- 2. knowledge (TEXT PK) ---
    {
      const table = 'knowledge';
      const rows = sqlite.prepare('SELECT * FROM knowledge').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO knowledge (id, file_name, section, content, version, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`;
      const params = rows.map(r => [r.id, r.file_name, r.section, r.content, r.version, r.updated_at]);
      const n = await batchInsert(client, sql, params);
      console.log(`  → ${n}行挿入`);
    }

    // --- 3. knowledge_history (SERIAL) ---
    {
      const table = 'knowledge_history';
      const count = sqliteCount(sqlite, table);
      if (count > 0) {
        const rows = sqlite.prepare('SELECT * FROM knowledge_history').all() as any[];
        console.log(`📋 ${table}: ${rows.length}行`);
        const sql = `INSERT INTO knowledge_history (id, knowledge_id, content_before, content_after, changed_by, changed_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`;
        const params = rows.map(r => [r.id, r.knowledge_id, r.content_before, r.content_after, r.changed_by, r.changed_at]);
        const n = await batchInsert(client, sql, params);
        await resetSequence(client, table);
        console.log(`  → ${n}行挿入`);
      } else {
        console.log(`📋 ${table}: 0行（スキップ）`);
      }
    }

    // --- 4. api_usage (SERIAL) ---
    {
      const table = 'api_usage';
      const rows = sqlite.prepare('SELECT * FROM api_usage').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO api_usage (id, model, input_tokens, output_tokens, cost_usd, task_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`;
      const params = rows.map(r => [r.id, r.model, r.input_tokens, r.output_tokens, r.cost_usd, r.task_id, r.created_at]);
      const n = await batchInsert(client, sql, params);
      await resetSequence(client, table);
      console.log(`  → ${n}行挿入`);
    }

    // --- 5. logs (SERIAL) ---
    {
      const table = 'logs';
      const rows = sqlite.prepare('SELECT * FROM logs').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO logs (id, level, source, message, metadata, created_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`;
      const params = rows.map(r => [r.id, r.level, r.source, r.message, r.metadata, r.created_at]);
      const n = await batchInsert(client, sql, params);
      await resetSequence(client, table);
      console.log(`  → ${n}行挿入`);
    }

    // --- 6. dev_conversations (TEXT PK) ---
    {
      const table = 'dev_conversations';
      const rows = sqlite.prepare('SELECT * FROM dev_conversations').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO dev_conversations (id, user_id, status, topic, hearing_log, requirements, generated_files, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`;
      const params = rows.map(r => [r.id, r.user_id, r.status, r.topic, r.hearing_log, r.requirements, r.generated_files, r.created_at, r.updated_at]);
      const n = await batchInsert(client, sql, params);
      console.log(`  → ${n}行挿入`);
    }

    // --- 7. message_history (SERIAL) ---
    {
      const table = 'message_history';
      const rows = sqlite.prepare('SELECT * FROM message_history').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO message_history (id, user_id, role, content, created_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`;
      const params = rows.map(r => [r.id, r.user_id, r.role, r.content, r.created_at]);
      const n = await batchInsert(client, sql, params);
      await resetSequence(client, table);
      console.log(`  → ${n}行挿入`);
    }

    // --- 8. memories (SERIAL, embedding変換あり) ---
    {
      const table = 'memories';
      const rows = sqlite.prepare('SELECT * FROM memories').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO memories (id, user_id, type, key, content, importance, embedding, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`;
      const params = rows.map(r => [
        r.id, r.user_id, r.type, r.key, r.content,
        r.importance ?? 3,
        blobToVectorSql(r.embedding),
        r.created_at, r.updated_at,
      ]);
      const n = await batchInsert(client, sql, params);
      await resetSequence(client, table);
      console.log(`  → ${n}行挿入（embedding変換: ${params.filter(p => p[6]).length}件）`);
    }

    // --- 9. conversation_sessions (SERIAL) ---
    {
      const table = 'conversation_sessions';
      const rows = sqlite.prepare('SELECT * FROM conversation_sessions').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO conversation_sessions (id, user_id, started_at, ended_at, message_count, summary)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`;
      const params = rows.map(r => [r.id, r.user_id, r.started_at, r.ended_at, r.message_count, r.summary]);
      const n = await batchInsert(client, sql, params);
      await resetSequence(client, table);
      console.log(`  → ${n}行挿入`);
    }

    // --- 10. pending_updates (TEXT PK) ---
    {
      const table = 'pending_updates';
      const count = sqliteCount(sqlite, table);
      if (count > 0) {
        const rows = sqlite.prepare('SELECT * FROM pending_updates').all() as any[];
        console.log(`📋 ${table}: ${rows.length}行`);
        const sql = `INSERT INTO pending_updates (id, user_id, update_type, content, status, created_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`;
        const params = rows.map(r => [r.id, r.user_id, r.update_type, r.content, r.status, r.created_at]);
        const n = await batchInsert(client, sql, params);
        console.log(`  → ${n}行挿入`);
      } else {
        console.log(`📋 ${table}: 0行（スキップ）`);
      }
    }

    // --- 11. agent_evaluations (SERIAL) ---
    {
      const table = 'agent_evaluations';
      const count = sqliteCount(sqlite, table);
      if (count > 0) {
        const rows = sqlite.prepare('SELECT * FROM agent_evaluations').all() as any[];
        console.log(`📋 ${table}: ${rows.length}行`);
        const sql = `INSERT INTO agent_evaluations (id, evaluator, target, sentiment, aspect, context, raw_feedback, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`;
        const params = rows.map(r => [r.id, r.evaluator, r.target, r.sentiment, r.aspect, r.context, r.raw_feedback, r.created_at]);
        const n = await batchInsert(client, sql, params);
        await resetSequence(client, table);
        console.log(`  → ${n}行挿入`);
      } else {
        console.log(`📋 ${table}: 0行（スキップ）`);
      }
    }

    // --- 12. agent_memories (SERIAL, embedding変換あり) ---
    {
      const table = 'agent_memories';
      const rows = sqlite.prepare('SELECT * FROM agent_memories').all() as any[];
      console.log(`📋 ${table}: ${rows.length}行`);
      const sql = `INSERT INTO agent_memories (id, agent, type, key, content, source, importance, embedding, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`;
      const params = rows.map(r => [
        r.id, r.agent, r.type, r.key, r.content, r.source,
        r.importance ?? 3,
        blobToVectorSql(r.embedding),
        r.created_at, r.updated_at,
      ]);
      const n = await batchInsert(client, sql, params);
      await resetSequence(client, table);
      console.log(`  → ${n}行挿入（embedding変換: ${params.filter(p => p[7]).length}件）`);
    }

    // --- 13. team_conversations (SERIAL) ---
    {
      const table = 'team_conversations';
      const count = sqliteCount(sqlite, table);
      if (count > 0) {
        const rows = sqlite.prepare('SELECT * FROM team_conversations').all() as any[];
        console.log(`📋 ${table}: ${rows.length}行`);
        const sql = `INSERT INTO team_conversations (id, task_id, dev_conversation_id, conversation_type, participants, log, decision, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`;
        const params = rows.map(r => [r.id, r.task_id, r.dev_conversation_id, r.conversation_type, r.participants, r.log, r.decision, r.created_at]);
        const n = await batchInsert(client, sql, params);
        await resetSequence(client, table);
        console.log(`  → ${n}行挿入`);
      } else {
        console.log(`📋 ${table}: 0行（スキップ）`);
      }
    }

    // --- 14. task_metrics (SERIAL) ---
    {
      const table = 'task_metrics';
      const count = sqliteCount(sqlite, table);
      if (count > 0) {
        const rows = sqlite.prepare('SELECT * FROM task_metrics').all() as any[];
        console.log(`📋 ${table}: ${rows.length}行`);
        const sql = `INSERT INTO task_metrics (id, task_id, agent, metric_type, value, context, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`;
        const params = rows.map(r => [r.id, r.task_id, r.agent, r.metric_type, r.value, r.context, r.created_at]);
        const n = await batchInsert(client, sql, params);
        await resetSequence(client, table);
        console.log(`  → ${n}行挿入`);
      } else {
        console.log(`📋 ${table}: 0行（スキップ）`);
      }
    }

    // --- 15. routing_corrections (SERIAL) ---
    {
      const table = 'routing_corrections';
      const count = sqliteCount(sqlite, table);
      if (count > 0) {
        const rows = sqlite.prepare('SELECT * FROM routing_corrections').all() as any[];
        console.log(`📋 ${table}: ${rows.length}行`);
        const sql = `INSERT INTO routing_corrections (id, user_id, message, dev_phase, auto_target, corrected_target, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`;
        const params = rows.map(r => [r.id, r.user_id, r.message, r.dev_phase, r.auto_target, r.corrected_target, r.created_at]);
        const n = await batchInsert(client, sql, params);
        await resetSequence(client, table);
        console.log(`  → ${n}行挿入`);
      } else {
        console.log(`📋 ${table}: 0行（スキップ）`);
      }
    }

    await client.query('COMMIT');
    console.log('\n✅ データ移行完了');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ 移行失敗、ロールバック実行:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
