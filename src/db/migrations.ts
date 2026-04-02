import { getDB } from './database';

export async function runMigrations(): Promise<void> {
  const db = getDB();

  // ===== 既存テーブル（SQLite DDL → PostgreSQL DDL）=====
  await db.exec(`
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS knowledge_history (
      id SERIAL PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      content_before TEXT,
      content_after TEXT,
      changed_by TEXT NOT NULL DEFAULT 'system',
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_usage (
      id SERIAL PRIMARY KEY,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      task_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(created_at);

    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dev_conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'hearing',
      topic TEXT NOT NULL,
      hearing_log TEXT DEFAULT '[]',
      requirements TEXT,
      generated_files TEXT DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_dev_conversations_user ON dev_conversations(user_id, status);

    CREATE TABLE IF NOT EXISTS message_history (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_message_history_user ON message_history(user_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      embedding vector(1024),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_key ON memories(user_id, type, key);

    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_evaluations (
      id SERIAL PRIMARY KEY,
      evaluator TEXT NOT NULL,
      target TEXT NOT NULL,
      sentiment INTEGER NOT NULL,
      aspect TEXT,
      context TEXT,
      raw_feedback TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_eval_target ON agent_evaluations(target, created_at);

    CREATE TABLE IF NOT EXISTS agent_memories (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      embedding vector(1024),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(agent, type, key)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_mem ON agent_memories(agent, type);

    CREATE TABLE IF NOT EXISTS team_conversations (
      id SERIAL PRIMARY KEY,
      task_id TEXT,
      dev_conversation_id TEXT,
      conversation_type TEXT NOT NULL,
      participants TEXT NOT NULL,
      log TEXT NOT NULL,
      decision TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_team_conv_task ON team_conversations(task_id);

    CREATE TABLE IF NOT EXISTS task_metrics (
      id SERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 1,
      context TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_task_metrics ON task_metrics(task_id, agent);

    CREATE TABLE IF NOT EXISTS routing_corrections (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      dev_phase TEXT NOT NULL,
      auto_target TEXT NOT NULL,
      corrected_target TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_routing_corrections_user ON routing_corrections(user_id, created_at);
  `);

  // ===== 新テーブル6種（Phase 1 / 2.5 / 3.5 / 4.5 / 5 / 6.5）=====
  await db.exec(`
    -- 手続き記憶 (Phase 1)
    CREATE TABLE IF NOT EXISTS procedural_memories (
      id SERIAL PRIMARY KEY,
      trigger_pattern TEXT NOT NULL,
      steps JSONB NOT NULL,
      source_conv_id TEXT,
      success_count INTEGER DEFAULT 1,
      failure_count INTEGER DEFAULT 0,
      confidence REAL GENERATED ALWAYS AS (
        success_count::real / GREATEST(success_count + failure_count, 1)
      ) STORED,
      embedding vector(1024),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ナレッジグラフ: ノード (Phase 3.5, 4.5)
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id SERIAL PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      label TEXT NOT NULL,
      node_type TEXT NOT NULL,
      metadata JSONB,
      embedding vector(1024),
      pagerank REAL DEFAULT 0.0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ナレッジグラフ: エッジ (Phase 3.5, 4.5)
    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id SERIAL PRIMARY KEY,
      source_node_id INTEGER REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      target_node_id INTEGER REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(source_node_id, target_node_id, relation_type)
    );

    -- Core Memory (Phase 6.5)
    CREATE TABLE IF NOT EXISTS core_memories (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      slot TEXT NOT NULL,
      content TEXT NOT NULL,
      max_tokens INTEGER DEFAULT 500,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(agent, slot)
    );

    -- 記憶スナップショット (Phase 2.5)
    CREATE TABLE IF NOT EXISTS memory_snapshots (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      content_before JSONB NOT NULL,
      operation TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 感情状態 (Phase 5)
    CREATE TABLE IF NOT EXISTS emotional_states (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      valence REAL NOT NULL DEFAULT 0.0,
      arousal REAL NOT NULL DEFAULT 0.5,
      dominant_emotion TEXT NOT NULL DEFAULT 'neutral',
      trigger_message TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ===== インデックス =====
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_emotional_user ON emotional_states(user_id, updated_at DESC);

    -- pgvector インデックス（データ数が少ない段階ではIVFFlatは非効率なのでHNSWを使用）
    -- ※ データが増えたらIVFFlatに切り替え検討
    CREATE INDEX IF NOT EXISTS idx_mem_emb ON memories USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_agent_mem_emb ON agent_memories USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_proc_mem_emb ON procedural_memories USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS idx_kn_emb ON knowledge_nodes USING hnsw (embedding vector_cosine_ops);

    -- ナレッジグラフ探索用
    CREATE INDEX IF NOT EXISTS idx_kn_type ON knowledge_nodes(node_type);
    CREATE INDEX IF NOT EXISTS idx_ke_source ON knowledge_edges(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_ke_target ON knowledge_edges(target_node_id);

    -- pg_trgm キーワード検索インデックス
    CREATE INDEX IF NOT EXISTS idx_mem_trgm ON memories USING gin (content gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_agent_mem_trgm ON agent_memories USING gin (content gin_trgm_ops);
  `);
}
