# エージェント自己改善システム 詳細設計書 v3（完全版）

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
│  + Core Memory（常時参照スロット）                          │
│  + 感情状態モデル（分身用）                                 │
├─────────────────────────────────────────────────────────┤
│  検索層                                                   │
│  pgvector（ベクトル近似探索: IVFFlat/HNSW）               │
│  + ナレッジグラフ（隣接テーブル + 再帰CTE + PageRank）      │
│  + BM25キーワード検索（pg_trgm）                          │
│  = ハイブリッド3重検索（A-RAG方式 + HippoRAG PageRank）    │
├─────────────────────────────────────────────────────────┤
│  ストレージ層                                              │
│  PostgreSQL 16 + pgvector 0.8 + pg_trgm                  │
│  ConoHa VPS (4コア/4GB RAM/88GB空き)                      │
├─────────────────────────────────────────────────────────┤
│  埋め込み層                                                │
│  Voyage AI voyage-3 ($0.06/1Mトークン, 1024次元)          │
├─────────────────────────────────────────────────────────┤
│  推論強化層                                                │
│  Claude拡張思考（extended thinking）— PM/レビュアーの       │
│  重要判断時に有効化（Quiet-STaR代替）                       │
└─────────────────────────────────────────────────────────┘
```

---

## 全Phaseマップ（17フェーズ）

| Phase | 名称 | 学術的根拠 | 内容 |
|-------|------|-----------|------|
| **M** | PostgreSQL移行 | - | SQLite→PostgreSQL+pgvector。全26ファイル277箇所 |
| **0** | 即時修正 | - | R1/R2問題解消（1ファイル制限緩和、レビュアースコープ修正） |
| **1** | 手続き記憶 | Mem^p, Voyager | 成功した開発フローを手順として蒸留・再利用 |
| **1.5** | PM Self-Refine | Self-Refine (NeurIPS 2023) | 要件定義の自己批評 + AC粒度チェック |
| **2** | 自己反省 | MIRROR, Reflexion | エンジニアのpre-review 3次元セルフチェック |
| **2.5** | 矛盾検出 | Mem0 | 記憶保存時に既存記憶との矛盾を検出・解消 |
| **3** | レビュアー進化 | Constitutional AI | 自己批評 + PMサブタスク再定義 |
| **3.5** | 階層的検索 | A-RAG, HippoRAG | ハイブリッド3重検索 + Personalized PageRank |
| **4** | AC自動検証 | Voyager式スキル | デプロイ後にACのURLパスをHTTP検証 |
| **4.5** | デプロイ履歴グラフ | HippoRAG, Graphiti | 時系列ナレッジグラフ + PageRankでデプロイ経験を構造化 |
| **5** | 分身進化 | Echo Protocol, D-MEM | ペルソナドリフト検出 + 感情モデリング + web_search制御 |
| **5.5** | 拡張思考 | Quiet-STaR | PM/レビュアーの重要判断時にextended thinkingを有効化 |
| **6** | 組織学習 | ExpeL, ERL | エピソード→意味記憶の自動昇格 + 共有コンテキスト |
| **6.5** | Core Memory | MemGPT/Letta | 各エージェントの常時参照コア情報 + ペルソナアンカリング |

---

## Phase M: PostgreSQL + pgvector 移行

### M-1. VPSセットアップ

```bash
sudo apt install postgresql-16 postgresql-16-pgvector
sudo -u postgres createuser mothership
sudo -u postgres createdb mothership_db -O mothership
sudo -u postgres psql -c "ALTER USER mothership PASSWORD 'xxx';"
sudo -u postgres psql -d mothership_db -c "CREATE EXTENSION vector;"
sudo -u postgres psql -d mothership_db -c "CREATE EXTENSION pg_trgm;"
```

### M-2. database.ts の書き換え

```typescript
// src/db/database.ts (新)
import pg from 'pg';

const pool = new pg.Pool({
  host: config.db.host,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  port: config.db.port,
  max: 10,
});

// better-sqlite3互換の非同期ラッパー
export function getDB() {
  return {
    prepare(sql: string) {
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

### M-3. 新テーブル（全フェーズ分を一括定義）

```sql
-- 手続き記憶 (Phase 1)
CREATE TABLE procedural_memories (
  id SERIAL PRIMARY KEY,
  trigger_pattern TEXT NOT NULL,
  steps JSONB NOT NULL,
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

-- ナレッジグラフ: ノード (Phase 3.5, 4.5)
CREATE TABLE knowledge_nodes (
  id SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL,
  metadata JSONB,
  embedding vector(1024),
  pagerank REAL DEFAULT 0.0,           -- HippoRAG: PageRankスコア
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ナレッジグラフ: エッジ (Phase 3.5, 4.5)
CREATE TABLE knowledge_edges (
  id SERIAL PRIMARY KEY,
  source_node_id INT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_node_id INT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_node_id, target_node_id, relation_type)
);

-- Core Memory (Phase 6.5)
CREATE TABLE core_memories (
  id SERIAL PRIMARY KEY,
  agent TEXT NOT NULL,
  slot TEXT NOT NULL,
  content TEXT NOT NULL,
  max_tokens INT DEFAULT 500,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent, slot)
);

-- 記憶スナップショット (Phase 2.5)
CREATE TABLE memory_snapshots (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id INT NOT NULL,
  content_before JSONB NOT NULL,
  operation TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 感情状態 (Phase 5)
CREATE TABLE emotional_states (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  valence REAL NOT NULL DEFAULT 0.0,
  arousal REAL NOT NULL DEFAULT 0.5,
  dominant_emotion TEXT NOT NULL DEFAULT 'neutral',
  trigger_message TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_emotional_user ON emotional_states(user_id, updated_at DESC);

-- pgvector インデックス
CREATE INDEX idx_proc_mem_emb ON procedural_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX idx_kn_emb ON knowledge_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);
CREATE INDEX idx_kn_type ON knowledge_nodes(node_type);
CREATE INDEX idx_ke_source ON knowledge_edges(source_node_id);
CREATE INDEX idx_ke_target ON knowledge_edges(target_node_id);

-- 既存テーブルの embedding を vector(1024) に変換
ALTER TABLE memories ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector(1024);
ALTER TABLE agent_memories ALTER COLUMN embedding TYPE vector(1024) USING embedding::vector(1024);
CREATE INDEX idx_mem_emb ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);
CREATE INDEX idx_agent_mem_emb ON agent_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- pg_trgm キーワード検索インデックス
CREATE INDEX idx_mem_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX idx_agent_mem_trgm ON agent_memories USING gin (content gin_trgm_ops);
```

### M-4. config.ts 追加

```typescript
db: {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  name: process.env.DB_NAME || 'mothership_db',
  user: process.env.DB_USER || 'mothership',
  password: process.env.DB_PASSWORD || '',
},
```

### M-5. embeddingCache.ts の段階的廃止

pgvectorのIVFFlatインデックスがインメモリキャッシュと同等速度を提供するため、
Phase M完了後に検証し、問題なければキャッシュ層を廃止。

---

## Phase 0: 即時修正（R1/R2問題解消）

### 0-1. buildCLIPrompt — 1ファイル制限の緩和

```
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

### 0-4. buildCLIPrompt — 全サブタスク概要注入（共有コンテキスト）

---

## Phase 1: 手続き記憶（Procedural Memory）

**根拠:** Mem^p, Voyager式スキルライブラリ

```typescript
// src/agents/dev/proceduralMemory.ts（新規）
export async function extractProcedure(conv: DevConversation): Promise<void>
export async function findRelevantProcedures(taskDescription: string): Promise<string>
export async function updateProcedureOutcome(id: number, success: boolean): Promise<void>
```

pgvector活用: `ORDER BY embedding <=> $1 LIMIT 5`

注入先: buildCLIPrompt, PM_DECOMPOSE_PROMPT実行時, REVIEWER_PROMPT実行時

---

## Phase 1.5: PM Self-Refine

**根拠:** Self-Refine (Madaan et al., NeurIPS 2023) — 7タスクで約20%改善

要件定義書生成後、提出前にPMが自己批評。ACの粒度・網羅性・登録漏れをチェック。
「LGTM」でなければ修正版を使用。

---

## Phase 2: 自己反省（MIRROR 3次元内部独白）

**根拠:** MIRROR (arXiv:2506.00430) — Goals/Reasoning/Memoryの3次元同時処理

CLI完了後、レビュー提出前に:
1. **Goals**: サブタスクのゴールは達成されているか？
2. **Reasoning**: なぜこの実装にしたか？判断の根拠は？
3. **Memory**: 過去の失敗パターンに該当していないか？

Sonnet CLI 60秒制限で実行。差し戻し1回分のコストより安い。

---

## Phase 2.5: 矛盾検出（Mem0式デュアル検索）

**根拠:** Mem0 (arXiv:2504.19413) — 矛盾情報の検出機能

記憶保存時にpgvectorで類似記憶を検索（コサイン類似度0.8以上）。
高類似度の既存記憶とLLMで矛盾判定。矛盾時はスナップショット保存+上書き。

---

## Phase 3: レビュアー進化

**根拠:** Constitutional AI (Anthropic)

### 3-1. 自己批評の4原則

```
原則1: この指摘はこのサブタスクの責任範囲内か？
原則2: errorとwarningの区別は適切か？
原則3: 過去に同じ指摘を繰り返していないか？
原則4: エンジニアが「具体的に何をすればよいか」分かるか？
```

### 3-2. 同一差し戻し→PMサブタスク再定義（合議ではなく）

---

## Phase 3.5: 階層的検索 + HippoRAG PageRank

**根拠:** A-RAG (arXiv:2602.03442), HippoRAG (NeurIPS 2024, ICML 2025)

### ハイブリッド3重検索

```typescript
// src/memory/hybridSearch.ts（新規）

// Level 1: BM25キーワード検索（pg_trgm）
export async function keywordSearch(query, table, limit = 10)

// Level 2: セマンティック検索（pgvector IVFFlat）
export async function semanticSearch(queryVec, table, limit = 10)

// Level 3: グラフ探索 + Personalized PageRank（再帰CTE）
export async function graphSearchWithPageRank(queryNodeId, depth = 2)

// 統合: Reciprocal Rank Fusion
export async function hybridSearch(query, queryVec, table, limit = 10)
```

### HippoRAG式 Personalized PageRank

HippoRAGの核心 — 海馬のインデックス理論をナレッジグラフに適用。
クエリに関連するノードからPageRankを伝播させ、間接的に関連するノードも発見する。

```sql
-- Personalized PageRank（反復計算、PostgreSQL再帰CTEで実装）
-- 起点ノード（クエリに最も類似するノード群）から重みを伝播
WITH RECURSIVE ppr AS (
  -- 起点: クエリベクトルに最も近いノード群（pgvectorで取得）
  SELECT id, 1.0 / COUNT(*) OVER () as rank, 0 as iteration
  FROM knowledge_nodes
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1
  LIMIT 5

  UNION ALL

  -- 伝播: 隣接ノードに重みを分配（damping factor = 0.85）
  SELECT
    ke.target_node_id as id,
    0.85 * SUM(ppr.rank * ke.weight / GREATEST(out_deg.cnt, 1)) as rank,
    ppr.iteration + 1 as iteration
  FROM ppr
  JOIN knowledge_edges ke ON ke.source_node_id = ppr.id
  JOIN (
    SELECT source_node_id, COUNT(*) as cnt
    FROM knowledge_edges GROUP BY source_node_id
  ) out_deg ON out_deg.source_node_id = ppr.id
  WHERE ppr.iteration < 3  -- 3回反復で十分な収束
  GROUP BY ke.target_node_id, ppr.iteration
)
SELECT kn.id, kn.label, kn.node_type, kn.metadata,
       SUM(ppr.rank) as pagerank_score
FROM ppr
JOIN knowledge_nodes kn ON kn.id = ppr.id
GROUP BY kn.id, kn.label, kn.node_type, kn.metadata
ORDER BY pagerank_score DESC
LIMIT $2;
```

**効果:** 「/admin/mindmapの登録忘れ」を検索すると、直接マッチする経験だけでなく、
PageRank伝播で「dashboard.ts更新」「views.tsリンク追加」等の間接的に関連する知識も発見される。

---

## Phase 4: AC自動検証

ACに含まれるURLパスにHTTPリクエストして200を確認。
デプロイ後に自動実行。未達成ACはユーザーに通知。

---

## Phase 4.5: デプロイ履歴ナレッジグラフ

**根拠:** HippoRAG, Graphiti（時間的知識グラフ）

```typescript
// src/agents/dev/knowledgeGraph.ts（新規）
export async function recordDeployToGraph(conv, success): Promise<void>
export async function findSimilarDeployExperiences(topic): Promise<string>
export async function updatePageRank(): Promise<void>  // バッチで定期更新
```

デプロイ成功/失敗時に:
1. dev_conversationをノード化
2. generated_filesをファイルノードとしてリンク
3. 失敗原因をノード化して因果リンク
4. pgvectorで類似過去開発を検出してsimilar_toリンク
5. PageRankスコアを更新

---

## Phase 5: 分身進化 + 感情モデリング

**根拠:** Echo Protocol, D-MEM（ドーパミンゲーテッドルーティング）, Chain-of-Emotion

### 5-1. ペルソナドリフト検出（Echo Protocol）

10ターンごとに直近応答と初期ペルソナの埋め込み類似度を計算。
閾値0.4以上のドリフトでペルソナアンカーを再注入。

### 5-2. 感情状態モデリング（Chain-of-Emotion）

**根拠:** Chain-of-Emotion (Croissant & Frister, 2024, PLoS One),
D-MEM (2025) — ドーパミンゲーテッドルーティング

```typescript
// src/line/emotionalState.ts（新規）

export interface EmotionalState {
  valence: number;          // -1.0(ネガティブ) 〜 +1.0(ポジティブ)
  arousal: number;          // 0(落ち着き) 〜 1.0(興奮)
  dominantEmotion: string;  // 'neutral','tired','excited','frustrated','reflective'
}

// ユーザーメッセージの感情を推定（Sonnet、maxTokens: 150で軽量）
export async function estimateEmotion(message: string): Promise<EmotionalState> {
  const { text } = await callClaude({
    system: `ユーザーメッセージの感情状態をJSON形式で推定してください。
{"valence": -1.0〜1.0, "arousal": 0〜1.0, "dominantEmotion": "..."}
感情カテゴリ: neutral, tired, excited, frustrated, reflective, anxious, grateful, curious`,
    messages: [{ role: 'user', content: message }],
    model: 'default',
    maxTokens: 150,
  });
  return safeParseJson(text) || { valence: 0, arousal: 0.5, dominantEmotion: 'neutral' };
}

// 感情状態に応じた応答トーン調整指示を生成
export function getEmotionalGuidance(state: EmotionalState): string {
  if (state.dominantEmotion === 'tired' || state.valence < -0.5) {
    return '【応答トーン】短く共感的に。励ましは不要。具体的な提案のみ。';
  }
  if (state.dominantEmotion === 'frustrated') {
    return '【応答トーン】問題の構造を整理して提示。感情に触れず、解決策に集中。';
  }
  if (state.dominantEmotion === 'excited' && state.arousal > 0.7) {
    return '【応答トーン】アイデアを一緒に展開。ただし実現可能性のフィルタをかける。';
  }
  if (state.dominantEmotion === 'reflective') {
    return '【応答トーン】内省を深める質問を投げかける。答えを急がない。';
  }
  return '';
}
```

**D-MEM式の「驚き」検出:**
```typescript
// 感情の急変を検出（前回との差分が大きい場合）
const prevState = await getLatestEmotionalState(userId);
const surprise = Math.abs(state.valence - prevState.valence);
if (surprise > 0.6) {
  // D-MEM: 驚きの大きい入力 → 完全なメモリ進化をトリガー
  // 通常の自動記憶抽出に加えて、この会話ターンを重要イベントとして記録
  await saveMemoryWithEmbedding(userId, 'memo',
    `emotional_shift_${Date.now()}`,
    `感情の大きな変化を検出: ${prevState.dominantEmotion} → ${state.dominantEmotion}。文脈: ${message.slice(0, 200)}`,
    5  // importance最大
  );
}
```

**responder.ts への統合:**
```typescript
// generateResponse内
let emotionalGuidance = '';
if (userId) {
  const emotion = await estimateEmotion(userMessage);
  await saveEmotionalState(userId, emotion, userMessage);
  emotionalGuidance = getEmotionalGuidance(emotion);
}
// systemPromptに注入
const systemPrompt = buildBunshinPrompt(memoryContext) + contextBlock + emotionalGuidance;
```

### 5-3. Web検索の質問種別判定

```typescript
const needsWebSearch = /最新|ニュース|今日|昨日|2026|価格|相場|トレンド|論文|研究/i.test(userMessage)
  || /調べて|検索して|探して/i.test(userMessage);
```

---

## Phase 5.5: 拡張思考（Quiet-STaR代替）

**根拠:** Quiet-STaR (Zelikman et al., COLM 2024) — 全トークン位置での内部推論
**実装:** Claude API の extended_thinking パラメータで代替

### callClaude への拡張思考パラメータ追加

```typescript
// src/claude/client.ts
export async function callClaude(params: {
  messages: ClaudeMessage[];
  system?: string;
  model?: 'default' | 'opus';
  maxTokens?: number;
  enableWebSearch?: boolean;
  // 追加: 拡張思考
  enableThinking?: boolean;
  thinkingBudget?: number;  // 思考に使うトークン上限（デフォルト: 5000）
}): Promise<{ text: string; thinking?: string; usage: { input: number; output: number } }>
```

**API呼び出し時のbody:**
```typescript
if (params.enableThinking) {
  body.thinking = {
    type: 'enabled',
    budget_tokens: params.thinkingBudget || 5000,
  };
  // 拡張思考使用時はtemperature=1が必須（API制約）
  body.temperature = 1;
}
```

### 有効化するタイミング

| エージェント | タイミング | 効果 |
|------------|-----------|------|
| **PM** | 要件定義書の自己批評（Phase 1.5） | ACの抜け漏れを深く検討 |
| **PM** | サブタスク再定義（Phase 3-2） | 差し戻しパターンの根本原因分析 |
| **レビュアー** | 2回目以降の差し戻し判定 | error/warningの判断精度向上 |
| **PM** | レトロスペクティブ総括 | 構造的問題の発見精度向上 |

**コスト影響:** 思考トークンは入力トークン料金（Opus: $15/1M, Sonnet: $3/1M）。
5000トークンの思考 = Sonnetで$0.015、Opusで$0.075。重要判断のみに限定して使用。

---

## Phase 6: 組織学習

### 6-1. エピソード→意味記憶の自動昇格

**根拠:** ExpeL (AAAI 2024), ERL (ICLR 2026)

pgvectorで類似learning記憶をクラスタリング（閾値0.5以上）。
クラスタサイズ3以上でClaude要約→type='pattern'に昇格。

### 6-2. 実装判断の共有コンテキスト

サブタスク完了時に実装判断の要約を保存し、次のサブタスクに注入。

---

## Phase 6.5: Core Memory + ペルソナアンカリング

**根拠:** MemGPT/Letta — Core/Recall/Archivalの3層構造
**Activation Steering代替:** Core Memoryのroleスロットで性格特性を詳細管理

### Core Memoryスロット設計

| スロット | 内容 | 更新タイミング |
|---------|------|-------------|
| `role` | 役割定義 + 性格特性（Big Fiveベース） | 初期化時/手動調整 |
| `project_state` | 現在のプロジェクト状態 | 開発開始/完了時 |
| `critical_rules` | patternから昇格した最重要ルール | 自動昇格時 |
| `user_preferences` | Daikiの好み・判断基準 | 評価受信時 |
| `recent_context` | 直近の開発コンテキスト | サブタスク完了ごと |

### 性格特性の詳細定義（roleスロット）

Activation Steeringの代替として、Big Fiveモデルに基づく明示的な性格定義:

```
PM: 開放性=高(新しいアプローチに柔軟), 誠実性=高(計画性重視),
    外向性=中(必要な時にリード), 協調性=中(率直にフィードバック), 神経症傾向=低(冷静)

エンジニア: 開放性=中(既存パターン重視だが新手法も受容), 誠実性=高(品質こだわり),
           外向性=低(黙々と実装), 協調性=高(フィードバックを素直に受容), 神経症傾向=低

レビュアー: 開放性=低(基準に厳格), 誠実性=高(見逃さない),
           外向性=中(指摘を明確に伝える), 協調性=中(妥協しないが建設的), 神経症傾向=低

デプロイヤー: 開放性=低(安全第一), 誠実性=高(チェックリスト厳守),
             外向性=低(問題がなければ報告のみ), 協調性=高(チームに従う), 神経症傾向=中(慎重)
```

**buildAgentPersonality に統合:**
```typescript
export async function buildAgentPersonality(agent: AgentRole, taskContext?: string): Promise<string> {
  const personality = PERSONALITIES[agent] || '';
  const coreMemory = await getCoreMemory(agent);
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

## 新規ファイル完全一覧

| ファイル | 行数見込 | Phase | 目的 |
|---------|---------|-------|------|
| src/agents/dev/proceduralMemory.ts | ~150行 | 1 | 手続き記憶の生成/検索/注入 |
| src/memory/hybridSearch.ts | ~250行 | 3.5 | ハイブリッド3重検索 + PageRank |
| src/agents/dev/knowledgeGraph.ts | ~300行 | 4.5 | ナレッジグラフ操作（CRUD+探索+PageRank） |
| src/memory/coreMemory.ts | ~80行 | 6.5 | Core Memory管理 |
| src/line/emotionalState.ts | ~120行 | 5 | 感情状態推定・保存・ガイダンス生成 |
| src/scripts/migrateSqliteToPostgres.ts | ~200行 | M | データ移行スクリプト |

## 変更ファイル完全一覧

| Phase | ファイル | 内容 |
|-------|---------|------|
| M | src/db/database.ts | 全書換: better-sqlite3 → pg Pool |
| M | src/db/migrations.ts | 全書換: SQLite→PostgreSQL DDL + 新テーブル |
| M | src/config.ts | DB接続情報追加 |
| M | src/memory/embeddingCache.ts | 段階的廃止 |
| M | 26ファイル | 同期→非同期化 |
| 0 | src/agents/dev/devAgent.ts | buildCLIPrompt緩和, buildReviewContext後続注入, 全サブタスク概要 |
| 0 | src/agents/dev/prompts.ts | REVIEWER_PROMPTスコープ判断 |
| 1 | src/agents/dev/devAgent.ts | buildCLIPrompt/retrospective に手続き記憶注入 |
| 1.5 | src/agents/dev/devAgent.ts | transitionToDefining に Self-Refine追加 |
| 2 | src/agents/dev/devAgent.ts | engineerAndReview に MIRROR self-check |
| 2.5 | src/agents/dev/teamMemory.ts | saveAgentMemoryWithEmbedding に矛盾検出 |
| 3 | src/agents/dev/prompts.ts | REVIEWER_PROMPT Constitutional AI自己批評 |
| 3 | src/agents/dev/devAgent.ts | 同一差し戻し→PMサブタスク再定義 |
| 3.5 | src/agents/dev/teamMemory.ts | searchAgentMemories をハイブリッド検索に置換 |
| 4 | src/agents/dev/tester.ts | runACVerification |
| 4 | src/agents/dev/deployer.ts | デプロイ後AC検証 |
| 4.5 | src/agents/dev/deployer.ts | デプロイ時にグラフ記録 |
| 5 | src/line/responder.ts | ペルソナドリフト検出, 感情ガイダンス注入, web_search制御 |
| 5.5 | src/claude/client.ts | enableThinking/thinkingBudgetパラメータ追加 |
| 5.5 | src/agents/dev/devAgent.ts | PM Self-Refine/レビュアー判定で拡張思考有効化 |
| 6 | src/agents/dev/teamMemory.ts | promoteRecurringLearnings |
| 6 | src/agents/dev/retrospective.ts | レトロ後に昇格+手続き記憶生成 |
| 6.5 | src/agents/dev/prompts.ts | buildAgentPersonality にCoreMemory+性格特性統合 |

---

## 実装順序

```
Week 1:
  Phase M  (PostgreSQL移行 — 基盤)
  Phase 0  (即時修正 — 合議ループ解消、並行実施)

Week 2:
  Phase 1   (手続き記憶)
  Phase 1.5 (PM Self-Refine)
  Phase 6.5 (Core Memory + ペルソナアンカリング)
  Phase 5.5 (拡張思考 — callClaude拡張)

Week 3:
  Phase 2   (MIRROR自己反省)
  Phase 2.5 (矛盾検出)
  Phase 3   (レビュアー進化)

Week 4:
  Phase 3.5 (A-RAG + HippoRAG PageRank)
  Phase 4   (AC自動検証)
  Phase 4.5 (ナレッジグラフ)

Week 5:
  Phase 5   (分身進化 + 感情モデリング)
  Phase 6   (組織学習 — 昇格メカニズム)
  統合テスト + 本番デプロイ
```

---

## ユーザー側の準備事項

| 項目 | 必須度 | 詳細 | 対応時期 |
|------|--------|------|---------|
| **VPSにPostgreSQL 16 + pgvectorインストール** | 必須 | `sudo apt install postgresql-16 postgresql-16-pgvector` | Week 1開始前 |
| **PostgreSQLユーザー/DB作成** | 必須 | DB名・ユーザー名・パスワードを決定 | Week 1開始前 |
| **`.env`にDB接続情報追加** | 必須 | DB_HOST, DB_NAME, DB_USER, DB_PASSWORD | Week 1開始前 |
| **Claude CLIクレジット確認** | 必須 | Phase 2のself-checkで追加呼び出し | Week 3開始前 |
| **Voyage AI有料プラン** | 推奨 | セマンティック検索精度向上（3RPM→制限緩和） | いつでも |
| **npmパッケージ追加** | 必須（私が実施） | `pg`, `pgvector` | Week 1 |

---

## API費用の影響

| 項目 | 追加コスト | タイミング |
|------|----------|-----------|
| エンジニア self-check (Phase 2) | +$0.05/サブタスク | CLI実行ごと |
| PM Self-Refine (Phase 1.5) | +$0.02/開発 | 要件定義時 |
| 拡張思考 (Phase 5.5) | +$0.02〜0.08/呼出 | 重要判断時のみ |
| 矛盾検出 (Phase 2.5) | +$0.01/記憶保存 | 高類似度時のみ |
| 手続き記憶生成 (Phase 1) | +$0.02/デプロイ | デプロイ成功時 |
| 昇格チェック (Phase 6) | +$0.02/レトロ | レトロ実行時 |
| 感情推定 (Phase 5) | +$0.01/ターン | 分身の全応答 |
| **合計追加** | **~$0.60/開発サイクル** | |
| **差し戻しループ回避** | **-$1.00〜3.00/開発** | 節約効果 |

---

## アイディア網羅性チェック

| ID | アイディア | Phase | 状態 |
|---|----------|-------|------|
| - | ExpeL（PM経験則抽出） | 1 | 含 |
| - | Mem^p（手続き記憶蒸留） | 1 | 含 |
| - | Self-Refine（PM自己批評） | 1.5 | 含 |
| - | Reflexion（永続メモリ） | 2 + 既存ERL | 含 |
| - | MIRROR（3次元内部独白） | 2 | 含 |
| - | Mem0（矛盾検出） | 2.5 | 含 |
| - | Constitutional AI（レビュアー自己批評） | 3 | 含 |
| - | D-MEM（エスカレーション高速化） | 3 + 5 | 含 |
| - | A-RAG（階層的検索） | 3.5 | 含 |
| **F** | HippoRAG（PageRank） | 3.5 + 4.5 | 含 |
| - | Voyager式スキル（AC検証） | 4 | 含 |
| - | Graphiti（時系列グラフ） | 4.5 | 含 |
| - | Echo Protocol（ドリフト検出） | 5 | 含 |
| **G** | Chain-of-Emotion / D-MEM（感情モデリング） | 5 | 含 |
| **H** | Quiet-STaR（拡張思考） | 5.5 | 含 |
| - | ExpeL / ERL（昇格メカニズム） | 6 | 含 |
| - | MemGPT/Letta（Core Memory） | 6.5 | 含 |
| **I** | ControlLM（ペルソナアンカリング代替） | 6.5 | 含 |
| - | CoALA（作業記憶管理） | 0 | 含 |
| - | 共有コンテキスト | 0 + 6 | 含 |

**全アイディア含（20/20）**
