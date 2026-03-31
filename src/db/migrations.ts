import { getDB } from './database';

export function runMigrations(): void {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      agent TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 5,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      input_data TEXT,
      output_data TEXT,
      error_log TEXT DEFAULT '[]',
      requires_opus INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      section TEXT,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id TEXT NOT NULL,
      content_before TEXT,
      content_after TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(created_at);

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dev_conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'hearing',
      topic TEXT NOT NULL,
      hearing_log TEXT DEFAULT '[]',
      requirements TEXT,
      generated_files TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dev_conversations_user ON dev_conversations(user_id, status);

    CREATE TABLE IF NOT EXISTS message_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_message_history_user ON message_history(user_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_key ON memories(user_id, type, key);

    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON conversation_sessions(user_id, ended_at);

    CREATE TABLE IF NOT EXISTS pending_updates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      update_type TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluator TEXT NOT NULL,
      target TEXT NOT NULL,
      sentiment INTEGER NOT NULL,
      aspect TEXT,
      context TEXT,
      raw_feedback TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_eval_target ON agent_evaluations(target, created_at);

    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent, type, key)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mem ON agent_memories(agent, type);

    CREATE TABLE IF NOT EXISTS team_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      dev_conversation_id TEXT,
      conversation_type TEXT NOT NULL,
      participants TEXT NOT NULL,
      log TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_team_conv_task ON team_conversations(task_id);

    CREATE TABLE IF NOT EXISTS task_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 1,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_metrics ON task_metrics(task_id, agent);

    CREATE TABLE IF NOT EXISTS routing_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      dev_phase TEXT NOT NULL,
      auto_target TEXT NOT NULL,
      corrected_target TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_corrections_user ON routing_corrections(user_id, created_at);
  `);

  // 既存テーブルに embedding 列がなければ追加（マイグレーション互換）
  try {
    db.prepare("SELECT embedding FROM memories LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
  }

  // importance カラム追加（記憶の重要度: 1〜5）
  try {
    db.prepare("SELECT importance FROM memories LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3");
  }

  try {
    db.prepare("SELECT importance FROM agent_memories LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE agent_memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3");
  }
}
