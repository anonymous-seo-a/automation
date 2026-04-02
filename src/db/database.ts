import pg from 'pg';
import { config } from '../config';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.name,
      user: config.db.user,
      password: config.db.password,
      max: 10,
    });
  }
  return pool;
}

/** SQLiteの ? プレースホルダーを PostgreSQLの $1, $2, ... に変換 */
function convertPlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

// --- better-sqlite3 互換インターフェース ---

export interface RunResult {
  changes: number;
}

export interface PreparedStatement {
  get(...params: unknown[]): Promise<any>;
  all(...params: unknown[]): Promise<any[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

export interface PGDatabase {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): Promise<void>;
  withTransaction<T>(fn: (tx: PGDatabase) => Promise<T>): Promise<T>;
}

/**
 * Pool または PoolClient をラップして better-sqlite3 互換APIを提供する。
 * トランザクション時は PoolClient を渡すことで同一コネクション上で実行される。
 */
function createWrapper(
  queryable: { query(text: string, values?: unknown[]): Promise<pg.QueryResult> },
): PGDatabase {
  return {
    prepare(sql: string): PreparedStatement {
      const pgSql = convertPlaceholders(sql);
      return {
        async get(...params: unknown[]) {
          const r = await queryable.query(pgSql, params);
          return r.rows[0] || undefined;
        },
        async all(...params: unknown[]) {
          const r = await queryable.query(pgSql, params);
          return r.rows;
        },
        async run(...params: unknown[]) {
          const r = await queryable.query(pgSql, params);
          return { changes: r.rowCount ?? 0 };
        },
      };
    },

    async exec(sql: string): Promise<void> {
      await queryable.query(sql);
    },

    async withTransaction<T>(fn: (tx: PGDatabase) => Promise<T>): Promise<T> {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const txWrapper = createWrapper(client);
        const result = await fn(txWrapper);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** better-sqlite3互換のDBラッパーを返す（全メソッドが非同期） */
export function getDB(): PGDatabase {
  return createWrapper(getPool());
}

/** pgvector等で直接Poolにアクセスする場合 */
export function getRawPool(): pg.Pool {
  return getPool();
}

export async function closeDB(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
