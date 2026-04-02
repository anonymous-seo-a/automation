# エージェント自己改善システム 詳細設計書

**作成日: 2026-04-02**
**ステータス: レビュー待ち**

---

## 概要

エージェントチーム（PM/エンジニア/レビュアー/デプロイヤー/分身）が過去の経験から学び、
自律的に行動を改善し続ける仕組みを構築する。

### 学術的基盤
- **ERL** (ICLR 2026 MemAgents) — 経験駆動型ヒューリスティックプール
- **Reflexion** (NeurIPS 2023) — 言語的自己反省による強化学習
- **CoALA** (TMLR 2024) — 作業/エピソード/意味/手続き記憶の4層モデル
- **ExpeL** (AAAI 2024) — 成功/失敗軌跡からのルール自動抽出
- **Mem^p** — 手順の蒸留による手続き記憶
- **MIRROR** — 認知的内部独白（Goals/Reasoning/Memory）
- **Constitutional AI** (Anthropic) — 原則ベースの自己批評

---

## Phase 0: 即時修正（R1/R2問題の解消）

### 問題
- エンジニアは「1ファイルだけ変更」と指示されるため、dashboard.ts登録ができない
- レビュアーは全ACで評価するため、後続サブタスクの内容で差し戻す

### 修正箇所

#### 0-1. buildCLIPrompt — 関連ファイル微修正の許可

**ファイル:** `src/agents/dev/devAgent.ts` buildCLIPrompt内

**変更前:**
```
- このサブタスク（1ファイル）だけを作成/変更してください
```

**変更後:**
```
- 主な変更対象はこのサブタスクのファイル（${subtask.path}）です
- ただし、このファイルが正しく動作するために必要な最小限の変更
  （import追加、use()登録、ナビゲーションリンク追加）は他ファイルにも行ってください
- 大きなロジック変更は他ファイルに加えないでください
```

#### 0-2. REVIEWER_PROMPT — サブタスクスコープの明示

**ファイル:** `src/agents/dev/prompts.ts` REVIEWER_PROMPT

**追加:**
```
7. **サブタスクスコープの判断**: レビュー対象はこのサブタスクの成果物です。
   後続サブタスクで実施予定の作業（別ファイルの大規模改修等）がまだ未実施でも、
   それはerrorではなくinfoとして記録してください。
   ただし、このファイルが「到達不可能」になる問題（ルート未登録等）は
   このサブタスク内で解決すべきerrorです。
```

#### 0-3. buildReviewContext — 後続サブタスク情報を注入

**ファイル:** `src/agents/dev/devAgent.ts` buildReviewContext内

**追加:**
```typescript
// 後続サブタスク情報をレビュアーに提供（スコープ判断用）
const remainingTasks = allSubtasks
  .filter(s => s.index > subtask.index)
  .map(s => `${s.index}. [${s.action}] ${s.path}: ${s.description}`)
  .join('\n');
if (remainingTasks) {
  ctx += `\n## 後続サブタスク（このレビュー後に実施予定）\n${remainingTasks}\n`;
  ctx += `※ 後続サブタスクで実施予定の変更は、このレビューではerrorとしないこと。\n\n`;
}
```

---

## Phase 1: 手続き記憶（Procedural Memory）

### 概念
成功した開発フローを「手順」として蒸留し、類似タスク実行時に自動注入する。
静的ルールではなく、**実際の成功体験から抽出された手順**。

### 1-1. 新テーブル: procedural_memories

**ファイル:** `src/db/migrations.ts`

```sql
CREATE TABLE IF NOT EXISTS procedural_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_pattern TEXT NOT NULL,       -- 発動条件（例: "新規Routerファイル作成"）
  steps TEXT NOT NULL,                 -- JSON配列: 手順ステップ
  source_conv_id TEXT,                 -- 学習元の開発会話ID
  success_count INTEGER DEFAULT 1,     -- この手順で成功した回数
  failure_count INTEGER DEFAULT 0,     -- この手順で失敗した回数
  confidence REAL DEFAULT 0.5,         -- success_count / (success + failure)
  embedding BLOB,                      -- trigger_patternの埋め込みベクトル
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 1-2. 手続き記憶の生成（デプロイ成功後）

**ファイル:** `src/agents/dev/proceduralMemory.ts`（新規）

デプロイ成功後に、その開発の「成功した手順」を抽出:

```typescript
export async function extractProcedure(conv: DevConversation): Promise<void> {
  // 1. この会話のサブタスク一覧を取得
  // 2. team_conversations からレビュー差し戻し→修正のパターンを取得
  // 3. Claude APIに「この開発で学んだ手順を構造化して」と依頼
  // 4. JSON形式の手順を procedural_memories に保存
  //    例: {
  //      trigger: "Express Routerファイルを新規作成",
  //      steps: [
  //        "1. Routerファイルを作成（エンドポイント定義）",
  //        "2. dashboard.tsにimport + use()マウントを追加",
  //        "3. views.tsのnavItemsにナビゲーションリンクを追加",
  //        "4. ビルドしてルートに到達可能か確認"
  //      ]
  //    }
  // 5. trigger_patternをembedding化して保存
}

export async function findRelevantProcedures(taskDescription: string): Promise<string> {
  // 意味検索で関連する手続き記憶を検索
  // confidence >= 0.5 のもののみ返す
  // 返り値: マークダウン形式の手順リスト
}
```

### 1-3. 手続き記憶の注入先

| 注入先 | タイミング | 効果 |
|--------|-----------|------|
| buildCLIPrompt | サブタスク実行前 | エンジニアが手順に従って実装 |
| PM_DECOMPOSE_PROMPT | サブタスク分解前 | PMが手順を参考に分解 |
| REVIEWER_PROMPT | レビュー時 | レビュアーが手順通りか検証 |

---

## Phase 2: 自己反省ステップ（Reflexion + MIRROR）

### 概念
エンジニアがコード生成完了後・レビュー提出前に「自己レビュー」を実行。
過去の失敗パターンに照らして自分の成果物をチェックする。

### 2-1. Pre-Review Self-Check

**ファイル:** `src/agents/dev/devAgent.ts` engineerAndReview内

CLI実行完了後、レビュアー提出前に挿入:

```typescript
// CLI実行後、レビュアー提出前に自己レビュー
const selfCheckPrompt = `あなたはエンジニアとして自分の変更を自己レビューします。

## 変更したファイル
${subtask.path}

## git diff の要約
${await getGitDiffSummary()}  // VPSでgit diffを取得

## 過去の失敗パターン（必ずチェック）
${engineerMemoryCtx}

## 自己チェック項目
1. このファイルが新しいRouterなら、app.ts/dashboard.tsへの登録は済んでいるか？
2. 新しいページなら、ナビゲーションリンクは追加したか？
3. importパスは実在するファイルを指しているか？
4. export名が既存と衝突していないか？

問題があれば修正してください。問題がなければ「チェック完了、問題なし」と出力してください。`;

const selfCheck = await runClaudeCLI(selfCheckPrompt, 'sonnet', 60_000);
```

**コスト影響:** Sonnetで短時間実行（60秒制限）。差し戻し1回の方がOpusリトライよりコスト高。

### 2-2. レトロスペクティブでの学習強化

**ファイル:** `src/agents/dev/retrospective.ts`

現在のレトロは反省テキストを保存するだけ。追加:

```typescript
// レトロ完了後に手続き記憶を生成
await extractProcedure(conv);

// エピソード→意味記憶の昇格チェック（Issue #1）
await promoteRecurringLearnings('engineer');
await promoteRecurringLearnings('reviewer');
await promoteRecurringLearnings('deployer');
await promoteRecurringLearnings('pm');
```

---

## Phase 3: レビュアーの知的進化

### 3-1. サブタスクスコープ判断（Constitutional AI式）

**ファイル:** `src/agents/dev/prompts.ts` REVIEWER_PROMPT

レビュアーがレビュー結果を出す前に、自己批評ステップを挟む:

```
レビュー結果をJSONで出力する前に、以下の自己チェックを行ってください:
- この指摘はこのサブタスクの責任範囲か？後続サブタスクで解決すべきではないか？
- errorとwarningの区別は適切か？「到達不可能」はerror、「将来的な改善」はwarning
- 過去に同じ指摘を繰り返していないか？繰り返しているなら、指摘の仕方を変える必要がある
```

### 3-2. エスカレーション判断の高速化

**ファイル:** `src/agents/dev/devAgent.ts` engineerAndReview内

現在: 同一理由2回→合議→ESCALATE判定
変更: 同一理由2回→合議ではなく**即座にサブタスク再定義**をPMに要求

```typescript
if (isSimilarReject(previousRejectReason, currentRejectReason) && reviewRetry >= 2) {
  // 合議ではなく、PMにサブタスク再定義を要求
  const redefineResult = await this.pmRedefineSubtask(conv, subtask, currentRejectReason);
  if (redefineResult.newSubtasks) {
    // サブタスク分割で解決を試みる
    return await this.engineerAndReview(conv, redefineResult.newSubtasks[0], ...);
  }
  // 解決不能→エスカレーション
  throw new EscalationError(...);
}
```

---

## Phase 4: デプロイヤーのAC検証自動化

### 4-1. ACベースのスモークテスト

**ファイル:** `src/agents/dev/tester.ts` に追加

```typescript
export async function runACVerification(
  conv: DevConversation,
  ac: string[],
): Promise<{ passed: boolean; results: Array<{ ac: string; passed: boolean; detail: string }> }> {
  const results = [];
  for (const criterion of ac) {
    // ACにURLパスが含まれている場合、HTTPリクエストで検証
    const urlMatch = criterion.match(/\/admin\/[\w/-]+/);
    if (urlMatch) {
      const url = `http://localhost:${config.server.port}${urlMatch[0]}`;
      try {
        const res = await fetch(url);
        results.push({
          ac: criterion,
          passed: res.status === 200,
          detail: `HTTP ${res.status}`,
        });
      } catch (err) {
        results.push({ ac: criterion, passed: false, detail: String(err) });
      }
    } else {
      // URL以外のAC → CLIで検証スクリプトを生成・実行
      results.push({ ac: criterion, passed: true, detail: '手動検証が必要' });
    }
  }
  return {
    passed: results.every(r => r.passed),
    results,
  };
}
```

### 4-2. デプロイ後のAC自動検証

**ファイル:** `src/agents/dev/deployer.ts` completePendingDeploy内

```typescript
// ヘルスチェック成功後にAC検証を追加
if (conv.requirements) {
  const acMatch = conv.requirements.match(/受け入れ条件（AC）[\s\S]*?(?=■|$)/);
  if (acMatch) {
    const acLines = acMatch[0].split('\n').filter(l => l.trim().startsWith('-'));
    const acVerification = await runACVerification(conv, acLines);
    if (!acVerification.passed) {
      const failedACs = acVerification.results.filter(r => !r.passed);
      dbLog('warn', 'deployer', `AC検証失敗: ${failedACs.length}件`, { convId });
      // ユーザーに通知（デプロイは完了だが機能未達を報告）
      await sendLineMessage(userId, 
        `デプロイ完了ですが、以下のACが未達成です:\n` +
        failedACs.map(f => `❌ ${f.ac}\n  → ${f.detail}`).join('\n')
      );
    }
  }
}
```

---

## Phase 5: 分身（Responder）の進化

### 5-1. ペルソナドリフト検出

**ファイル:** `src/line/responder.ts`

```typescript
// 応答生成後にスタイル一貫性をチェック（10ターンごと）
const messageCount = getRecentHistory(userId).length;
if (messageCount > 0 && messageCount % 10 === 0) {
  // 直近の応答スタイルと初期ペルソナの類似度を計算
  // 閾値以下ならペルソナアンカーを再注入
}
```

**コスト注意:** 毎ターン実行するとAPI費用が増大。10ターンごとの定期チェックで十分。

### 5-2. Web検索の品質向上

**現状:** `enableWebSearch: true` で常時有効。品質制御なし。

**改善:** 質問の種類に応じてweb_searchの有効/無効を切り替え:

```typescript
// 最新情報が必要な質問か判定
const needsWebSearch = /最新|ニュース|今日|昨日|2026|価格|相場|トレンド/i.test(userMessage);
```

---

## Phase 6: 組織全体の学習ループ

### 6-1. エピソード→意味記憶の自動昇格（Issue #1の実装）

**ファイル:** `src/agents/dev/teamMemory.ts` に追加

```typescript
export async function promoteRecurringLearnings(agent: AgentRole): Promise<number> {
  // 1. agentのlearning記憶を全取得
  // 2. embedding付きのものをクラスタリング（類似度0.5以上）
  // 3. クラスタサイズ >= 3 のものを昇格候補として抽出
  // 4. Claude APIで共通パターンを1ルール文に要約
  // 5. type='pattern', importance=5 として保存
  // 6. 昇格した件数を返す
}
```

### 6-2. 共有コンテキスト（チーム間情報伝達）

**現状の問題:** PMがサブタスク3にdashboard.ts登録を含めたが、サブタスク1実行時にエンジニアにその情報がない。

**解決:** buildCLIPromptに全サブタスクの概要を含める（現在は`_allSubtasks`として受け取っているが未使用）。

```typescript
// buildCLIPrompt内
const taskOverview = allSubtasks
  .map(s => `${s.index}. [${s.action}] ${s.path}: ${s.description.slice(0, 80)}`)
  .join('\n');
prompt += `\n## 全サブタスクの概要（あなたのタスクは${subtask.index}番）\n${taskOverview}\n`;
prompt += `※ 他のサブタスクで実施予定の内容を把握した上で、必要な連携（import先の確認等）を行ってください。\n`;
```

---

## 変更ファイル一覧

| Phase | ファイル | 変更種別 | 内容 |
|-------|---------|---------|------|
| 0 | devAgent.ts | 修正 | buildCLIPromptの「1ファイル制限」緩和 |
| 0 | prompts.ts | 修正 | REVIEWER_PROMPTにスコープ判断ルール追加 |
| 0 | devAgent.ts | 修正 | buildReviewContextに後続サブタスク情報注入 |
| 1 | migrations.ts | 修正 | procedural_memoriesテーブル追加 |
| 1 | proceduralMemory.ts | 新規 | 手続き記憶の生成・検索・注入 |
| 1 | devAgent.ts | 修正 | buildCLIPromptに手続き記憶注入 |
| 2 | devAgent.ts | 修正 | engineerAndReviewにself-checkステップ追加 |
| 2 | retrospective.ts | 修正 | レトロ後に手続き記憶生成+昇格チェック |
| 3 | prompts.ts | 修正 | REVIEWER_PROMPTに自己批評ステップ追加 |
| 3 | devAgent.ts | 修正 | 同一差し戻し→PMサブタスク再定義 |
| 4 | tester.ts | 修正 | runACVerification追加 |
| 4 | deployer.ts | 修正 | デプロイ後AC自動検証 |
| 5 | responder.ts | 修正 | ペルソナドリフト検出、web_search制御 |
| 6 | teamMemory.ts | 修正 | promoteRecurringLearnings実装 |
| 6 | devAgent.ts | 修正 | buildCLIPromptに全サブタスク概要注入 |

## 新規ファイル

| ファイル | 目的 |
|---------|------|
| `src/agents/dev/proceduralMemory.ts` | 手続き記憶の管理（生成/検索/注入） |

## API費用への影響

| Phase | 追加API呼び出し | タイミング | 推定コスト/回 |
|-------|----------------|-----------|-------------|
| 0 | なし | - | $0 |
| 1 | Claude 1回 | デプロイ成功後 | ~$0.02 (Sonnet) |
| 2 | CLI 1回 (Sonnet) | サブタスクごと | ~$0.05 |
| 3 | なし (プロンプト変更のみ) | - | $0 |
| 4 | HTTP数回 | デプロイ後 | $0 |
| 5 | なし (ロジック変更のみ) | - | $0 |
| 6 | Claude 1回 | レトロ後 | ~$0.02 (Sonnet) |

**合計追加コスト:** サブタスク1件あたり約$0.05、デプロイ1回あたり約$0.04

---

## ユーザー側の準備事項

1. **Voyage AI支払い設定** — 現在3 RPM制限（無料枠）。セマンティック検索の精度に直結。
   有料プランにアップグレードすると制限が緩和される。
   → 必須ではないが推奨。なくても keyword fallback で動作する。

2. **Claude CLI クレジット** — Phase 2のself-checkでCLI呼び出しが1回増える。
   → CLI残高の確認。

3. **VPSのディスク容量** — procedural_memoriesテーブルは小さい（数KB/レコード）。
   → 通常問題にならない。

---

## 実装順序（推奨）

```
Phase 0（即時修正）
  ↓ デプロイ・動作確認
Phase 1（手続き記憶）+ Phase 6（共有コンテキスト + 昇格）
  ↓ デプロイ・動作確認
Phase 2（自己反省）+ Phase 3（レビュアー進化）
  ↓ デプロイ・動作確認
Phase 4（AC自動検証）
  ↓ デプロイ・動作確認
Phase 5（分身進化）
```

Phase 0が最も緊急（現在の合議ループを解消）。
Phase 1+6は基盤（手続き記憶と昇格メカニズム）。
Phase 2+3はエンジニア/レビュアーの行動改善。
Phase 4はデプロイ品質の自動検証。
Phase 5は分身の長期改善。
