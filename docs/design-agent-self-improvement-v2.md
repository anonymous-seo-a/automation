# エージェント自己改善システム 詳細設計書 v2

**作成日: 2026-04-02**
**ステータス: レビュー待ち**
**前提: PostgreSQL + pgvector に移行した上で全機能を本格実装**

---

## アーキテクチャ全体像

```
┌─────────────────────────────────────────────────────────┐
│  LLM層                                                   │
│  Claude Sonnet 4.6（日常業務）/ Opus 4.6（複雑な判断）     │
│  100万トークンコンテキスト + 拡張思考 + web_search         │
├─────────────────────────────────────────────────────────┤
│  メモリ層（4種 ─ CoALAモデル準拠）                         │
│  ┌──────────┬──────────┬──────────┬──────────┐           │
│  │ Working  │ Episodic │ Semantic │Procedural│           │
│  │ 作業記憶  │エピソード │ 意味記憶  │ 手続き   │           │
│  │(会話内)   │(経験ログ) │(ルール)   │(手順)    │           │
│  └──────────┴──────────┴──────────┴──────────┘           │
├─────────────────────────────────────────────────────────┤
│  検索層                                                   │
│  pgvector（ベクトル近似探索: IVFFlat/HNSW）               │
│  + ナレッジグラフ（隣接テーブル + 再帰CTE探索）             │
│  + BM25キーワード検索（pg_trgm）                          │
│  = ハイブリッド3重検索（A-RAG方式）                        │
├─────────────────────────────────────────────────────────┤
│  ストレージ層                                              │
│  PostgreSQL 16 + pgvector 0.8 + pg_trgm                  │
│  ConoHa VPS (4コア/4GB RAM/88GB空き)                      │
├─────────────────────────────────────────────────────────┤
│  埋め込み層                                                │
│  Voyage AI voyage-3 ($0.06/1Mトークン)                    │
│  1024次元ベクトル                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 実装フェーズ一覧

| Phase | 名称 | 内容 | 依存 |
|-------|------|------|------|
| **M** | PostgreSQL移行 | SQLite→PostgreSQL+pgvector。全26ファイル277箇所を移行 | なし |
| **0** | 即時修正 | R1/R2問題解消（1ファイル制限緩和、レビュアースコープ修正） | なし |
| **1** | 手続き記憶 | 成功した開発フローを手順として蒸留・再利用 | M |
| **1.5** | PM Self-Refine | 要件定義の自己レビュー + AC粒度チェック | 0 |
| **2** | 自己反省（MIRROR 3次元） | エンジニアのpre-reviewセルフチェック（Goals/Reasoning/Memory） | 0 |
| **2.5** | 矛盾検出（Mem0式） | 記憶保存時に既存記憶との矛盾を検出・解消 | M |
| **3** | レビュアー進化 | Constitutional AI式自己批評 + PMサブタスク再定義 | 0 |
| **3.5** | 階層的検索（A-RAG） | エージェントごとに粒度の異なる検索ツールを提供 | M |
| **4** | AC自動検証 | デプロイ後にACのURLパスをHTTPリクエストで検証 | 0 |
| **4.5** | デプロイ履歴グラフ | 時系列ナレッジグラフでデプロイ経験を構造化 | M |
| **5** | 分身進化 | ペルソナドリフト検出 + web_search品質制御 | M |
| **6** | 組織学習 | エピソード→意味記憶の自動昇格 + 共有コンテキスト | M |
| **6.5** | Core Memory | 各エージェントの常時参照コア情報管理 | M |

---

## Phase M: PostgreSQL + pgvector 移行

### M-1. VPSセットアップ

```bash
# PostgreSQL 16 + pgvector インストール
sudo apt install postgresql-16 postgresql-16-pgvector

# DB作成
sudo -u postgres createuser mothership
sudo -u postgres createdb mothership_db -O mothership
sudo -u postgres psql -c "ALTER USER mothership PASSWORD 'xxx';"

# 拡張有効化
sudo -u postgres psql -d mothership_db -c "CREATE EXTENSION vector;"
sudo -u postgres psql -d mothership_db -c "CREATE EXTENSION pg_trgm;"
```

### M-2. database.ts の書き換え

**方針:** better-sqlite3の同期APIを非同期ラッパーで模倣し、呼び出し元の変更を最小化。

```typescript
// src/db/database.ts (新)
import pg from 'pg';

const pool = new pg.Pool({
  host: 'localhost',
  database: config.db.name,      // 新設: DB_NAME
  user: config.db.user,          // 新設: DB_USER
  password: config.db.password,  // 新設: DB_PASSWORD
  port: 5432,
  max: 10,                       // 最大接続数
});

// better-sqlite3互換のラッパー
export function getDB() {
  return {
    prepare(sql: string) {
      // SQLiteのパラメータバインド (?) をPostgreSQLの ($1, $2...) に変換
      let paramIndex = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);
      return {
        run: (...params: unknown[]) => pool.query(pgSql, params),
        get: async (...params: unknown[]) => {
          const r = await pool.query(pgSql, params);
          return r.rows[0] || undefined;
        },
        all: async (...params: unknown[]) => {
          const r = await pool.query(pgSql, params);
          return r.rows;
        },
      };
    },
    exec: (sql: string) => pool.query(sql),
  };
}
```

**影響範囲:**
- `db.prepare(...).get()` → `await db.prepare(...).get()` — 非同期化が必要
- 26ファイル277箇所を段階的に移行
- **移行戦略:** 全箇所を一度にawait化するのではなく、ファイル単位で順番に移行

### M-3. migrations.ts の書き換え

**主要な差異:**

| SQLite | PostgreSQL |
|--------|-----------|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| `TEXT NOT NULL DEFAULT (datetime('now'))` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` |
| `BLOB` (embedding) | `vector(1024)` (pgvector) |
| `CREATE UNIQUE INDEX IF NOT EXISTS` | `CREATE UNIQUE INDEX IF NOT EXISTS` (互換) |
| `datetime('now','-7 days')` | `NOW() - INTERVAL '7 days'` |
| `strftime('%Y-%m','now')` | `TO_CHAR(NOW(),'YYYY-MM')` |
| `date('now','start of day')` | `CURRENT_DATE` |

### M-4. 新テーブル（移行と同時に追加）

```sql
-- 手続き記憶 (Phase 1)
CREATE TABLE procedural_memories (
  id SERIAL PRIMARY KEY,
  trigger_pattern TEXT NOT NULL,
  steps JSONB NOT NULL,              -- PostgreSQLのJSONBで構造化
  source_conv_id TEXT,
  success_count INT DEFAULT 1,
  failure_count INT DEFAULT 0,
  confidence REAL GENERATED ALWAYS AS (
    success_count::real / GREATEST(success_count + failure_count, 1)
  ) STORED,
  embedding vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_proc_mem_embedding ON procedural_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- ナレッジグラフ: ノード (Phase 4.5, 6)
CREATE TABLE knowledge_nodes (
  id SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,          -- 'agent_memory', 'dev_conversation', 'deploy', 'memory'
  source_id INT NOT NULL,             -- 元テーブルのID
  label TEXT NOT NULL,                -- ノードのラベル（例: "認証バグ修正"）
  node_type TEXT NOT NULL,            -- 'experience', 'rule', 'concept', 'file'
  metadata JSONB,
  embedding vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_kn_embedding ON knowledge_nodes
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);
CREATE INDEX idx_kn_type ON knowledge_nodes(node_type);

-- ナレッジグラフ: エッジ (Phase 4.5, 6)
CREATE TABLE knowledge_edges (
  id SERIAL PRIMARY KEY,
  source_node_id INT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_node_id INT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,         -- 'caused_by', 'similar_to', 'led_to', 'fixed_by', 'depends_on'
  weight REAL DEFAULT 1.0,             -- 関係の強さ
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_node_id, target_node_id, relation_type)
);
CREATE INDEX idx_ke_source ON knowledge_edges(source_node_id);
CREATE INDEX idx_ke_target ON knowledge_edges(target_node_id);

-- Core Memory (Phase 6.5)
CREATE TABLE core_memories (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,                  -- 'pm','engineer','reviewer','deployer','bunshin'
  slot TEXT NOT NULL,                   -- 'role','project_state','critical_rules','user_preferences'
  content TEXT NOT NULL,
  max_tokens INT DEFAULT 500,           -- このスロットのトークン上限
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent, slot)
);

-- 記憶スナップショット (Phase 2.5 矛盾検出のロールバック用)
CREATE TABLE memory_snapshots (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id INT NOT NULL,
  content_before JSONB NOT NULL,
  operation TEXT NOT NULL,              -- 'update', 'delete', 'conflict_resolve'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### M-5. pgvector インデックス戦略

```sql
-- 既存テーブルのembeddingをvector(1024)に変換
ALTER TABLE memories
  ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector(1024);

ALTER TABLE agent_memories
  ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector(1024);

-- ベクトル近似探索インデックス（IVFFlat: 精度とメモリのバランス良）
CREATE INDEX idx_memories_embedding ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

CREATE INDEX idx_agent_memories_embedding ON agent_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- GINインデックス（pg_trgmによるキーワード検索高速化）
CREATE INDEX idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX idx_agent_memories_content_trgm ON agent_memories USING gin (content gin_trgm_ops);
```

### M-6. config.ts 追加項目

```typescript
db: {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  name: process.env.DB_NAME || 'mothership_db',
  user: process.env.DB_USER || 'mothership',
  password: process.env.DB_PASSWORD || '',
},
```

### M-7. データ移行スクリプト

```typescript
// src/scripts/migrateSqliteToPostgres.ts
// 1. SQLiteから全テーブルのデータを読み出し
// 2. PostgreSQLに挿入（embedding BLOBをvectorに変換）
// 3. シーケンスのリセット（SERIAL対応）
// 4. 検証（レコード数一致確認）
```

### M-8. embeddingCache.ts の簡素化

PostgreSQL + pgvectorに移行後、インメモリキャッシュは不要になる。
pgvectorのIVFFlatインデックスが同等以上の速度で検索可能。

```typescript
// embeddingCache.ts → 段階的に廃止
// Phase M: キャッシュを維持しつつ、pgvectorに並行で書き込み
// Phase M+1: pgvectorの速度を検証後、キャッシュを完全廃止
```

---

## Phase 0: 即時修正（R1/R2問題解消）

PostgreSQL移行と並行して実施可能（SQLiteのまま先行実装）。

### 0-1. buildCLIPrompt — 1ファイル制限の緩和

```
変更前: このサブタスク（1ファイル）だけを作成/変更してください
変更後: 主な変更対象は ${subtask.path} です。
        ただし、このファイルが正しく動作するために必要な最小限の変更
        （import追加、use()登録、ナビゲーションリンク追加）は他ファイルにも行ってください。
```

### 0-2. REVIEWER_PROMPT — サブタスクスコープ判断追加

```
7. サブタスクスコープの判断: 後続サブタスクで実施予定の作業はerrorではなくinfoとして記録。
   ただし「到達不可能」（ルート未登録等）はこのサブタスク内で解決すべきerror。
```

### 0-3. buildReviewContext — 後続サブタスク情報注入

`allSubtasks`のうち未実施のサブタスクをレビュアーコンテキストに含める。

### 0-4. buildCLIPrompt — 全サブタスク概要注入

`_allSubtasks`パラメータを使い、「あなたのタスクは3件中1件目。2件目でdashboard.ts登録予定」をエンジニアに伝える。

---

## Phase 1: 手続き記憶（Procedural Memory）

### 1-1. proceduralMemory.ts（新規ファイル）

```typescript
// デプロイ成功後に手続き記憶を生成
export async function extractProcedure(conv: DevConversation): Promise<void>

// タスク説明で意味検索し、関連手続きをナラティブ形式で返す
export async function findRelevantProcedures(taskDescription: string): Promise<string>

// 手続き記憶の成功/失敗カウント更新
export async function updateProcedureOutcome(
  procedureId: number, success: boolean
): Promise<void>
```

**pgvector活用:**
```sql
-- 関連手続きの検索（インデックス利用で高速）
SELECT id, trigger_pattern, steps, confidence
FROM procedural_memories
WHERE confidence >= 0.5
ORDER BY embedding <=> $1  -- $1 = クエリベクトル
LIMIT 5;
```

### 1-2. 注入先

- `buildCLIPrompt` — 「## 参考手順（過去の成功パターン）」セクションとして注入
- `PM_DECOMPOSE_PROMPT` 実行時 — PMにも関連手順を提供
- `REVIEWER_PROMPT` 実行時 — 手順通りか検証

---

## Phase 1.5: PM Self-Refine

### 要件定義の自己レビュー

PMが要件定義書を生成した後、提出前に自己批評ステップを挟む。

```typescript
// devAgent.ts transitionToDefining内
const requirements = await callClaude({ ... }); // 要件定義書生成

// Self-Refine: 自己批評
const selfReview = await callClaude({
  system: DEV_SYSTEM_PROMPT,
  messages: [{
    role: 'user',
    content: `以下の要件定義書を批評してください。

${requirements}

チェック項目:
1. 各ACは1つのサブタスクで検証可能か？曖昧すぎないか？
2. UIを追加する場合、「既存ナビゲーションからリンクで到達できること」がACに含まれているか？
3. 新規ファイルを作る場合、「app.ts/dashboard.tsへの登録」がサブタスクに含まれるか？
4. テスト方法は具体的か？

問題があれば修正した要件定義書を出力。問題なければ「LGTM」と出力。`
  }],
  model: 'default',
});

if (!selfReview.text.includes('LGTM')) {
  requirements = selfReview.text; // 修正版を使用
}
```

---

## Phase 2: 自己反省（MIRROR 3次元内部独白）

### エンジニアの Pre-Review Self-Check

CLI完了後、レビュー提出前に3次元の自己レビューを実行:

```typescript
const selfCheckPrompt = `あなたは実装を完了したエンジニアとして自己レビューを行います。

## Goals（このサブタスクのゴール）
${subtask.description}

## Reasoning（なぜこの実装にしたか）
実装したファイル: ${subtask.path}
変更概要を確認して、判断の根拠を述べてください。

## Memory（過去の失敗パターン）
${engineerMemoryCtx}

## チェック項目
1. ゴールは達成されているか？
2. 新しいRouterを作成した場合、app.ts/dashboard.tsへの登録は済んでいるか？
3. 新しいページなら、ナビゲーションリンクは追加したか？
4. importパスは実在するファイルを指しているか？
5. export名が既存と衝突していないか？
6. 過去の失敗パターンに該当していないか？

問題があれば修正してください。問題なければ「SELF-CHECK PASSED」と出力してください。`;

const selfCheck = await runClaudeCLI(selfCheckPrompt, 'sonnet', 60_000);
// SELF-CHECK PASSEDでなければCLI出力にself-checkの結果を含めて再実行
```

---

## Phase 2.5: 矛盾検出（Mem0式デュアル検索）

### 記憶保存時の矛盾チェック

```typescript
// teamMemory.ts saveAgentMemoryWithEmbedding内に追加
async function detectContradiction(
  agent: AgentRole, newContent: string, newEmbedding: number[]
): Promise<{ hasContradiction: boolean; conflictingMemory?: AgentMemory }> {
  // pgvectorで類似記憶を検索
  const similar = await pool.query(`
    SELECT id, content, 1 - (embedding <=> $1) as similarity
    FROM agent_memories
    WHERE agent = $2 AND embedding IS NOT NULL
    ORDER BY embedding <=> $1
    LIMIT 5
  `, [pgvector.toSql(newEmbedding), agent]);

  // 類似度0.8以上の記憶と内容が矛盾していないかLLMで判定
  for (const row of similar.rows) {
    if (row.similarity >= 0.8) {
      const check = await callClaude({
        system: '2つの記憶が矛盾していないか判定してください。矛盾あり→"CONFLICT"、なし→"OK"',
        messages: [{ role: 'user', content: `記憶A: ${row.content}\n記憶B: ${newContent}` }],
        model: 'default', maxTokens: 100,
      });
      if (check.text.includes('CONFLICT')) {
        return { hasContradiction: true, conflictingMemory: row };
      }
    }
  }
  return { hasContradiction: false };
}
```

**矛盾検出時の処理:**
1. スナップショットを`memory_snapshots`に保存（ロールバック可能）
2. 新しい記憶で古い記憶を上書き（新しい情報を優先）
3. ログに矛盾解消を記録

---

## Phase 3: レビュアー進化

### 3-1. Constitutional AI式自己批評

REVIEWER_PROMPTに追加:

```
レビュー結果JSONを出力する前に、以下の原則で自己チェックしてください:
原則1: この指摘はこのサブタスクの責任範囲内か？後続サブタスクで解決すべきではないか？
原則2: errorとwarningの区別は適切か？
原則3: 過去に同じ指摘を繰り返していないか？繰り返しているなら、指摘の「伝え方」を変える
原則4: エンジニアがこの指摘を見て「具体的に何をすればよいか」分かるか？
```

### 3-2. 同一差し戻し→PMサブタスク再定義

```typescript
// engineerAndReview内
if (isSimilarReject(prev, curr) && reviewRetry >= 2) {
  // 合議ではなく、PMにサブタスク再定義を依頼
  dbLog('info', 'dev-agent', '[PM] サブタスク再定義を依頼', { convId: conv.id });
  const redefinePrompt = `レビュアーの指摘: ${currentRejectReason}
この指摘は2回繰り返されています。原因はサブタスクの定義にあります。
このサブタスクを解決するために必要な全ファイルの変更を含む再定義をしてください。`;
  // PM→サブタスク再定義→エンジニアに新しい指示で再実行
}
```

---

## Phase 3.5: 階層的検索（A-RAG方式）

### エージェントごとの検索ツール

pgvectorの高速ベクトル検索 + pg_trgmのキーワード検索を組み合わせた3粒度の検索。

```typescript
// src/memory/hybridSearch.ts（新規）

// Level 1: 高速キーワード検索（BM25相当）
export async function keywordSearch(query: string, table: string, limit = 10) {
  return pool.query(`
    SELECT *, similarity(content, $1) as sim
    FROM ${table}
    WHERE content % $1   -- pg_trgm の類似度検索
    ORDER BY sim DESC LIMIT $2
  `, [query, limit]);
}

// Level 2: セマンティック検索（ベクトル近似）
export async function semanticSearch(queryVec: number[], table: string, limit = 10) {
  return pool.query(`
    SELECT *, 1 - (embedding <=> $1) as similarity
    FROM ${table}
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1 LIMIT $2
  `, [pgvector.toSql(queryVec), limit]);
}

// Level 3: グラフ探索（関連ノードを再帰的に辿る）
export async function graphSearch(nodeId: number, depth = 2) {
  return pool.query(`
    WITH RECURSIVE graph AS (
      SELECT target_node_id as id, relation_type, weight, 1 as depth
      FROM knowledge_edges WHERE source_node_id = $1
      UNION ALL
      SELECT ke.target_node_id, ke.relation_type, ke.weight, g.depth + 1
      FROM knowledge_edges ke
      JOIN graph g ON ke.source_node_id = g.id
      WHERE g.depth < $2
    )
    SELECT kn.*, g.relation_type, g.weight, g.depth
    FROM graph g
    JOIN knowledge_nodes kn ON kn.id = g.id
    ORDER BY g.depth, g.weight DESC
  `, [nodeId, depth]);
}

// ハイブリッド検索（3つを統合してリランキング）
export async function hybridSearch(
  query: string,
  queryVec: number[],
  table: string,
  limit = 10,
): Promise<SearchResult[]> {
  const [kw, sem] = await Promise.all([
    keywordSearch(query, table, limit * 2),
    semanticSearch(queryVec, table, limit * 2),
  ]);
  // Reciprocal Rank Fusionでリランキング
  return reciprocalRankFusion(kw.rows, sem.rows, limit);
}
```

### 各エージェントの検索粒度

| エージェント | Level 1 (キーワード) | Level 2 (セマンティック) | Level 3 (グラフ) |
|------------|---------------------|----------------------|----------------|
| **PM** | 過去の類似依頼 | 類似開発の要件/AC | 依頼→開発→結果の因果連鎖 |
| **エンジニア** | 対象ファイルの過去変更 | 類似実装の経験 | ファイル間の依存関係 |
| **レビュアー** | 過去の同種指摘 | 類似コードのバグパターン | 指摘→修正→結果の連鎖 |
| **デプロイヤー** | 過去のデプロイエラー | 類似デプロイの経験 | エラー→原因→対策の連鎖 |
| **分身** | ユーザーの過去発言 | 関連する記憶 | 記憶間の関連マップ |

---

## Phase 4: AC自動検証

（前設計書と同一。変更なし。）

---

## Phase 4.5: デプロイ履歴ナレッジグラフ

### デプロイ成功/失敗時にグラフノード・エッジを生成

```typescript
// src/agents/dev/knowledgeGraph.ts（新規）

export async function recordDeployToGraph(conv: DevConversation, success: boolean) {
  // 1. dev_conversationからノードを作成
  const convNode = await createNode({
    source_type: 'dev_conversation',
    source_id: conv.id,
    label: conv.topic,
    node_type: 'experience',
    embedding: await embed(conv.topic + ' ' + conv.requirements),
  });

  // 2. generated_filesの各ファイルをノード化
  const files = JSON.parse(conv.generated_files || '[]');
  for (const file of files) {
    const fileNode = await findOrCreateNode({
      source_type: 'file', label: file, node_type: 'file',
    });
    await createEdge(convNode.id, fileNode.id, 'modified', 1.0);
  }

  // 3. 失敗原因があればノード化してリンク
  if (!success) {
    // team_conversationsから差し戻し理由を取得
    // 原因ノードを作成し、experience → caused_by → cause のエッジ
  }

  // 4. 類似の過去開発とリンク
  const similar = await semanticSearch(convNode.embedding, 'knowledge_nodes', 5);
  for (const sim of similar) {
    if (sim.similarity > 0.7 && sim.id !== convNode.id) {
      await createEdge(convNode.id, sim.id, 'similar_to', sim.similarity);
    }
  }
}

// デプロイ前に類似経験を検索
export async function findSimilarDeployExperiences(topic: string): Promise<string> {
  // pgvectorで類似ノードを検索 → グラフ探索で関連情報を収集
  // 「前回 /admin/mindmap が404だった。原因はdashboard.tsの登録漏れ」等を返す
}
```

---

## Phase 5: 分身進化

### 5-1. ペルソナドリフト検出

```typescript
// responder.ts
// 10ターンごとに最新応答のスタイルと初期ペルソナの類似度をpgvectorで計算
const recentResponses = getRecentHistory(userId).filter(m => m.role === 'assistant').slice(-3);
const recentStyle = await embed(recentResponses.map(r => r.content).join(' '));
const personaStyle = await embed(BUNSHIN_PROMPT_TEMPLATE.slice(0, 500));
const drift = 1 - cosineSimilarity(recentStyle, personaStyle);
if (drift > 0.4) {
  // ペルソナアンカーを再注入
  contextBlock += '\n## ペルソナリマインダー\nあなたの本来の会話スタイルに立ち返ってください。';
}
```

### 5-2. Web検索の質問種別判定

```typescript
const needsWebSearch = /最新|ニュース|今日|昨日|2026|価格|相場|トレンド|論文|研究/i.test(userMessage)
  || /調べて|検索して|探して/i.test(userMessage);
```

---

## Phase 6: 組織学習

### 6-1. エピソード→意味記憶の自動昇格

```typescript
export async function promoteRecurringLearnings(agent: AgentRole): Promise<number> {
  // pgvectorでクラスタリング（閾値0.5以上の類似learning群を検出）
  const learnings = await pool.query(`
    SELECT a.id, a.content, a.embedding
    FROM agent_memories a
    WHERE a.agent = $1 AND a.type = 'learning' AND a.embedding IS NOT NULL
  `, [agent]);

  // 類似度マトリクスを構築し、クラスタを検出
  const clusters = clusterBySimilarity(learnings.rows, 0.5);

  let promoted = 0;
  for (const cluster of clusters) {
    if (cluster.length >= 3) {
      // Claude APIでクラスタを1ルール文に要約
      const rule = await summarizeCluster(cluster);
      // type='pattern', importance=5 として保存
      await saveAgentMemoryWithEmbedding(agent, 'pattern', `auto_rule_${Date.now()}`, rule, 'auto_promote', 5);
      promoted++;
    }
  }
  return promoted;
}
```

### 6-2. 実装判断の共有コンテキスト

各サブタスク完了時に「なぜこう実装したか」の要約を保存し、次のサブタスクに注入:

```typescript
// engineerAndReview 承認後
const implementationNote = `サブタスク${subtask.index}完了: ${subtask.path}
実装判断: ${cliResult.output.slice(-200)}`;  // CLIの最後の出力に判断理由が含まれる

completedFiles.push({
  path: result.file.path,
  content: result.file.content,
  note: implementationNote,  // 判断理由を含める
});
```

---

## Phase 6.5: Core Memory

### 各エージェントの常時参照コア情報

```typescript
// src/memory/coreMemory.ts（新規）

export async function getCoreMemory(agent: string): Promise<string> {
  const slots = await pool.query(
    'SELECT slot, content FROM core_memories WHERE agent = $1 ORDER BY slot',
    [agent]
  );
  return slots.rows.map(s => `[${s.slot}] ${s.content}`).join('\n');
}

export async function updateCoreMemory(
  agent: string, slot: string, content: string
): Promise<void> {
  await pool.query(`
    INSERT INTO core_memories (agent, slot, content)
    VALUES ($1, $2, $3)
    ON CONFLICT (agent, slot) DO UPDATE SET content = $3, updated_at = NOW()
  `, [agent, slot, content]);
}
```

**Core Memoryのスロット設計:**

| スロット | 内容 | 更新タイミング |
|---------|------|-------------|
| `role` | 自分の役割定義（固定） | 初期化時 |
| `project_state` | 現在のプロジェクト状態 | 開発開始/完了時 |
| `critical_rules` | 絶対に守るべきルール（patternから昇格した最重要項目） | 自動昇格時 |
| `user_preferences` | Daikiの好み・判断基準 | 評価受信時 |
| `recent_context` | 直近の開発コンテキスト | サブタスク完了ごと |

**buildAgentPersonality に統合:**
```typescript
export async function buildAgentPersonality(agent: AgentRole, taskContext?: string): Promise<string> {
  const personality = PERSONALITIES[agent] || '';
  const coreMemory = await getCoreMemory(agent);      // 追加: Core Memory
  const memoryContext = await buildAgentMemoryContext(agent, taskContext);
  const evaluationContext = buildEvaluationContext(agent);

  let prompt = DEV_SYSTEM_PROMPT + '\n\n' + personality;
  if (coreMemory) prompt += '\n\n## Core Memory（常時参照）\n' + coreMemory;
  if (memoryContext) prompt += '\n\n' + memoryContext;
  if (evaluationContext) prompt += '\n\n' + evaluationContext;
  return prompt;
}
```

---

## 変更ファイル完全一覧

| Phase | ファイル | 種別 | 内容 |
|-------|---------|------|------|
| M | src/db/database.ts | 全書換 | better-sqlite3 → pg Pool + 互換ラッパー |
| M | src/db/migrations.ts | 全書換 | SQLite→PostgreSQL DDL |
| M | src/config.ts | 修正 | DB接続情報追加 |
| M | src/memory/embeddingCache.ts | 修正 | pgvector並行書込→段階的廃止 |
| M | 26ファイル | 修正 | 同期→非同期化（db.prepare().get() → await） |
| M | src/scripts/migrateSqliteToPostgres.ts | 新規 | データ移行スクリプト |
| 0 | src/agents/dev/devAgent.ts | 修正 | buildCLIPrompt 1ファイル制限緩和、全サブタスク概要注入、buildReviewContext後続サブタスク注入 |
| 0 | src/agents/dev/prompts.ts | 修正 | REVIEWER_PROMPT スコープ判断追加 |
| 1 | src/agents/dev/proceduralMemory.ts | 新規 | 手続き記憶の生成/検索/注入 |
| 1 | src/agents/dev/devAgent.ts | 修正 | buildCLIPrompt/retrospective に手続き記憶注入 |
| 1.5 | src/agents/dev/devAgent.ts | 修正 | transitionToDefining に Self-Refine追加 |
| 2 | src/agents/dev/devAgent.ts | 修正 | engineerAndReview に MIRROR self-check追加 |
| 2.5 | src/agents/dev/teamMemory.ts | 修正 | saveAgentMemoryWithEmbedding に矛盾検出追加 |
| 3 | src/agents/dev/prompts.ts | 修正 | REVIEWER_PROMPT Constitutional AI自己批評追加 |
| 3 | src/agents/dev/devAgent.ts | 修正 | 同一差し戻し→PMサブタスク再定義 |
| 3.5 | src/memory/hybridSearch.ts | 新規 | ハイブリッド3重検索（キーワード+セマンティック+グラフ） |
| 3.5 | src/agents/dev/teamMemory.ts | 修正 | searchAgentMemories をハイブリッド検索に置換 |
| 4 | src/agents/dev/tester.ts | 修正 | runACVerification追加 |
| 4 | src/agents/dev/deployer.ts | 修正 | デプロイ後AC検証 |
| 4.5 | src/agents/dev/knowledgeGraph.ts | 新規 | ナレッジグラフ操作（ノード/エッジのCRUD+グラフ探索） |
| 4.5 | src/agents/dev/deployer.ts | 修正 | デプロイ時にグラフ記録 |
| 5 | src/line/responder.ts | 修正 | ペルソナドリフト検出、web_search制御 |
| 6 | src/agents/dev/teamMemory.ts | 修正 | promoteRecurringLearnings実装 |
| 6 | src/agents/dev/retrospective.ts | 修正 | レトロ後に昇格+手続き記憶生成 |
| 6.5 | src/memory/coreMemory.ts | 新規 | Core Memory管理 |
| 6.5 | src/agents/dev/prompts.ts | 修正 | buildAgentPersonality にCoreMemory統合 |

## 新規ファイル一覧

| ファイル | 行数見込 | 目的 |
|---------|---------|------|
| src/agents/dev/proceduralMemory.ts | ~150行 | 手続き記憶 |
| src/memory/hybridSearch.ts | ~200行 | ハイブリッド3重検索 |
| src/agents/dev/knowledgeGraph.ts | ~250行 | ナレッジグラフ |
| src/memory/coreMemory.ts | ~80行 | Core Memory |
| src/scripts/migrateSqliteToPostgres.ts | ~200行 | データ移行 |

---

## 実装順序

```
Week 1:
  Phase M (PostgreSQL移行)     ← 基盤。これがないと他が動かない
  Phase 0 (即時修正)           ← 並行。SQLiteのまま先行実装可能

Week 2:
  Phase 1 (手続き記憶)         ← pgvector活用
  Phase 1.5 (PM Self-Refine)  ← プロンプト修正のみ
  Phase 6.5 (Core Memory)     ← シンプル。テーブル+クエリのみ

Week 3:
  Phase 2 (自己反省MIRROR)     ← CLIの追加呼び出し
  Phase 2.5 (矛盾検出)        ← pgvector検索+LLM判定
  Phase 3 (レビュアー進化)     ← プロンプト修正+ロジック変更

Week 4:
  Phase 3.5 (A-RAG)           ← ハイブリッド検索の実装
  Phase 4 (AC自動検証)         ← HTTP検証
  Phase 4.5 (ナレッジグラフ)   ← グラフテーブル+再帰CTE

Week 5:
  Phase 5 (分身進化)           ← ドリフト検出
  Phase 6 (組織学習)           ← 昇格メカニズム
  統合テスト + 本番デプロイ
```

---

## ユーザー側の準備事項

| 項目 | 必須度 | 詳細 | 対応時期 |
|------|--------|------|---------|
| **VPSにPostgreSQLインストール** | 必須 | `sudo apt install postgresql-16 postgresql-16-pgvector` | Week 1開始前 |
| **PostgreSQLユーザー/DB作成** | 必須 | DB名・ユーザー名・パスワードを決定 | Week 1開始前 |
| **`.env`にDB接続情報追加** | 必須 | `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Week 1開始前 |
| **Claude CLIクレジット確認** | 必須 | Phase 2のself-checkで追加呼び出し | Week 3開始前 |
| **Voyage AI有料プラン** | 推奨 | セマンティック検索の精度向上（3RPM→制限緩和） | いつでも |
| **npm パッケージ追加** | 必須（私が実施） | `pg`, `pgvector` | Week 1で実施 |

---

## API費用の影響（月額見込み）

| 項目 | 現在 | 追加 | 説明 |
|------|------|------|------|
| エンジニアCLI | 既存 | +$0.05/サブタスク | Phase 2 self-check |
| PM Self-Refine | - | +$0.02/開発 | Phase 1.5 |
| 矛盾検出 | - | +$0.01/記憶保存 | Phase 2.5（高類似度のみ） |
| 手続き記憶生成 | - | +$0.02/デプロイ | Phase 1 |
| 昇格チェック | - | +$0.02/レトロ | Phase 6 |
| **合計追加** | | **~$0.50/開発サイクル** | |
| **差し戻しループ回避** | | **-$1.00〜3.00/開発** | Opus自動エスカレーション回避 |

**差し戻しループ1回の回避で、全Phase分のコストを回収可能。**
