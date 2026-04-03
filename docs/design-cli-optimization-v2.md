# 詳細設計書 v2: CLIコスト最適化 + 認証切り替え + Memory Tool統合

**作成日: 2026-04-03**
**ステータス: レビュー待ち（実装はDaikiの指示待ち）**

---

## 全体方針

- **施策1**: CLIコスト最適化（Opus→Sonnet統一、リトライ上限、コストガード）
- **施策2**: CLI認証モード切り替え（サブスク ⇔ API、.envの1行で切替）
- **施策3**: Memory Tool統合（分身 + エンジニアチーム）— 別途実装指示待ち

施策1と2は同時にデプロイする（1の最適化は認証モードに関係なく有効）。

---

## 施策1: CLIコスト最適化

### 変更A: Opus→Sonnet統一

**ファイル: `src/agents/dev/devAgent.ts`**

```typescript
// [変更] selectModel(): 常にSonnetを返す
private selectModel(subtask: Subtask): 'sonnet' | 'opus' {
  return 'sonnet';
}

// [変更] Opusエスカレーション: 最終リトライのみ
// 現在: reviewRetry >= 2 でOpus
// 変更後: reviewRetry >= MAX_REVIEW_RETRIES でOpus（最後の1回だけ）
if (reviewRetry >= MAX_REVIEW_RETRIES && model === 'sonnet') {
  model = 'opus';
}

// [変更] PM要件定義: Opus→default(Sonnet)
// 行564: model: 'opus' → model: 'default'
// ※ enableThinking: true で品質補完済み

// [変更] PMサブタスク分解: Opus→default(Sonnet)
// 行649, 1274: model: 'opus' → model: 'default'
// ※ 分解精度はSonnetで十分（enableThinking併用）
```

**変更対象の全箇所:**

| 行 | 現在 | 変更後 | 理由 |
|---|---|---|---|
| 564 | `model: 'opus'` | `model: 'default'` | PM要件定義（enableThinking使用） |
| 499 | `model: 'opus'` | `model: 'default'` | PMヒアリング判定 |
| 458 | `model: 'opus'` | `model: 'default'` | PMルーティング判定 |
| 649 | `model: 'opus'` | `model: 'default'` | PMサブタスク分解 |
| 1274 | `model: 'opus'` | `model: 'default'` | PMサブタスク分解（リトライ時） |
| 2067 | `model: 'opus'` | `model: 'default'` | ビルドエラー分析 |
| 2178 | `model: 'opus'` | `model: 'default'` | テストエラー分析 |
| 1303 | `return 'opus'` | `return 'sonnet'` | selectModel() |
| 1547 | `model = 'opus'` | 条件変更 | Opusエスカレーション |

### 変更B: リトライ上限

**ファイル: `src/agents/dev/devAgent.ts`**

```typescript
const MAX_BUILD_RETRIES = 3;      // 5→3
const MAX_TEST_FIX_RETRIES = 3;   // 5→3
const MAX_REVIEW_RETRIES = 2;     // 3→2
```

### 変更C: コスト上限ガード

**ファイル: `src/agents/dev/devAgent.ts`**

実装フェーズ（`transitionToImplementation`）の先頭に追加:

```typescript
// 1開発あたりのAPI使用量チェック
const DEV_COST_LIMIT = 2.0; // $2

// engineerAndReview ループ内の各CLI実行前にチェック
private async checkCostGuard(conv: DevConversation): Promise<void> {
  try {
    const { getDailySpend } = await import('../../claude/budgetTracker');
    const dailySpend = await getDailySpend();
    if (dailySpend > config.claude.dailyBudgetUsd * 0.8) {
      throw new EscalationError(
        `本日のAPI使用量が予算の80%に到達しました ($${dailySpend.toFixed(2)})。\n` +
        `続行しますか？続ける場合は「続けて」と返信してください。`
      );
    }
  } catch (err) {
    if (err instanceof EscalationError) throw err;
    // budgetTracker自体のエラーは無視して続行
  }
}
```

### 変更D: --allowedTools追加

**ファイル: `src/agents/dev/cliRunner.ts`**

```typescript
const args = [
  '-y', '@anthropic-ai/claude-code',
  '-p',
  '--output-format', 'text',
  '--dangerously-skip-permissions',
  '--model', modelName,
  '--allowedTools', 'Read,Edit,Write,Bash(npm run build),Bash(git *),Glob,Grep',
];
```

---

## 施策2: CLI認証モード切り替え

### 設計原則

1. `.env`の`CLI_AUTH_MODE`で切り替え（subscription / api）
2. サブスクモードではOAuth期限切れ対策を自動適用
3. 失敗時はAPIキーにフォールバック（サブスクモード時のみ）
4. 並列実行の競合を回避するための直列化

### 変更箇所一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/config.ts` | `cli.authMode` 追加 |
| `src/agents/dev/cliRunner.ts` | 認証切り替え + フォールバック + 直列化 |
| `src/agents/dev/devAgent.ts` | バッチ並列実行の直列化オプション |
| `.env`（VPS） | `CLI_AUTH_MODE=subscription` 追加 |

### config.ts の変更

```typescript
cli: {
  authMode: (process.env.CLI_AUTH_MODE || 'api') as 'subscription' | 'api',
},
```

### cliRunner.ts の完全設計

```typescript
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface CLIResult {
  success: boolean;
  output: string;
  authUsed: 'subscription' | 'api';  // どちらの認証で実行されたか
}

// 並列実行の競合防止（サブスクOAuth時の.credentials.json競合回避）
let cliMutex: Promise<void> = Promise.resolve();

/**
 * Claude CLIを非対話モード (-p) で実行する。
 * 認証モードはconfig.cli.authModeで切り替え。
 * サブスクモード時は直列化 + フォールバック付き。
 */
export function runClaudeCLI(
  prompt: string,
  model: 'sonnet' | 'opus' = 'sonnet',
  timeoutMs = 300_000,
): Promise<CLIResult> {
  if (config.cli.authMode === 'subscription') {
    // サブスクモード: 直列化して競合回避
    const current = cliMutex;
    let resolveNext: () => void;
    cliMutex = new Promise(r => { resolveNext = r; });

    return current.then(async () => {
      try {
        // 1. サブスクで試行
        const result = await executeCLI(prompt, model, timeoutMs, 'subscription');
        if (result.success) return result;

        // 2. 認証/レート制限エラー → APIキーでフォールバック
        if (isAuthOrRateLimitError(result.output)) {
          logger.warn('サブスクCLI失敗 → APIキーにフォールバック', {
            err: result.output.slice(0, 100),
          });
          return executeCLI(prompt, model, timeoutMs, 'api');
        }

        // 3. その他のエラー（コード生成失敗等）はそのまま返す
        return result;
      } finally {
        resolveNext!();
      }
    });
  }

  // APIモード: 直列化不要
  return executeCLI(prompt, model, timeoutMs, 'api');
}

function executeCLI(
  prompt: string,
  model: 'sonnet' | 'opus',
  timeoutMs: number,
  authMode: 'subscription' | 'api',
): Promise<CLIResult> {
  return new Promise((resolve) => {
    const modelName = model === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

    logger.info('Claude CLI実行開始', {
      promptLength: prompt.length,
      model,
      authMode,
    });

    // 認証モードに応じた環境変数
    const env = { ...process.env };
    if (authMode === 'subscription') {
      // ANTHROPIC_API_KEYを除外 → OAuthにフォールバック
      delete env.ANTHROPIC_API_KEY;
    } else {
      // APIキーモード: 明示的にセット
      env.ANTHROPIC_API_KEY = config.claude.apiKey;
    }

    const child: ChildProcess = spawn('npx', [
      '-y', '@anthropic-ai/claude-code',
      '-p',
      '--output-format', 'text',
      '--dangerously-skip-permissions',
      '--model', modelName,
      '--allowedTools',
      'Read,Edit,Write,Bash(npm run build),Bash(git *),Glob,Grep',
    ], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      logger.warn('Claude CLI タイムアウト', { timeoutMs, authMode });
      resolve({
        success: false,
        output: (stdout + '\n' + stderr).trim().slice(-3000),
        authUsed: authMode,
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn('Claude CLI実行エラー', {
          code,
          authMode,
          err: (stderr || stdout).slice(0, 300),
        });
        resolve({
          success: false,
          output: (stdout + '\n' + stderr).trim().slice(-3000),
          authUsed: authMode,
        });
      } else {
        logger.info('Claude CLI実行完了', {
          outputLength: stdout.length,
          authMode,
        });
        resolve({
          success: true,
          output: stdout.trim(),
          authUsed: authMode,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('Claude CLI起動失敗', { err: err.message, authMode });
      resolve({
        success: false,
        output: err.message,
        authUsed: authMode,
      });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

function isAuthOrRateLimitError(output: string): boolean {
  const patterns = [
    'rate_limit', 'Rate limit',
    'authentication_error', 'authentication',
    '401', 'OAuth',
    'credit balance', 'Not logged in',
    'token has expired',
  ];
  return patterns.some(p => output.includes(p));
}
```

### 設計のポイント

**1. 直列化（Mutex）**

サブスクモード時のみ、CLIの実行を直列化する。

```
[APIモード]    CLI①②③ → 並列実行OK（APIキーに競合問題なし）
[サブスクモード] CLI① → CLI② → CLI③ → 直列実行（OAuth競合回避）
```

影響: バッチ並列実行（2-3タスク同時）ができなくなる。
例: 並列3タスク×3分 = 3分が、直列で = 9分になる。
ただしトータルのAPI呼び出し数は同じなのでコストは変わらない。

**2. フォールバック**

```
サブスクで実行 → 成功 → そのまま返す
                → 認証/レート制限エラー → APIキーでリトライ → 返す
                → その他エラー（コード生成失敗等） → そのまま返す（リトライしない）
```

認証エラーのみフォールバック。コード品質の問題はdevAgent側のレビューループで処理。

**3. 認証モード判定フロー**

```
.env: CLI_AUTH_MODE=subscription
  → config.cli.authMode === 'subscription'
    → cliRunner: ANTHROPIC_API_KEYをenvから除外
      → CLI: OAuth認証（CLAUDE_CODE_OAUTH_TOKENまたは~/.claude/credentials使用）

.env: CLI_AUTH_MODE=api
  → config.cli.authMode === 'api'
    → cliRunner: ANTHROPIC_API_KEY=config.claude.apiKey
      → CLI: APIキー認証
```

### devAgent.tsの変更（バッチ並列→直列化対応）

現在のバッチ実行ロジックを確認して、サブスクモード時に直列化する変更が必要:

```typescript
// 現在のバッチ並列実行（scheduler.tsのbuildExecutionBatches結果を使用）
// バッチ内のタスクはPromise.allで並列実行

// 変更不要: cliRunner内のmutexで自動的に直列化される
// CLI呼び出し自体はPromise.allで投入するが、
// cliRunner内で順番待ちするため実質直列になる
```

**devAgent.tsのバッチ実行コードの変更は不要。** `cliRunner.ts`のmutexが透過的に直列化する。呼び出し側は何も意識しなくてよい。

### VPSセットアップ手順（Daiki実施）

```bash
# ===== Step 1: ローカルMacでトークン生成 =====
claude setup-token
# → ブラウザ認証
# → sk-ant-oat01-xxxx...が表示される（1回限り！必ずコピー！）

# ===== Step 2: VPSにSSH =====
ssh -i ~/.ssh/vps_mothership root@bot.anonymous-seo.jp

# ===== Step 3: deployユーザーの環境設定 =====
su - deploy

# OAuthトークンを設定
echo 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-ここにトークン貼付"' >> ~/.bashrc
source ~/.bashrc

# Claude CLI設定ファイル
cat > ~/.claude.json << 'EOF'
{
  "hasCompletedOnboarding": true
}
EOF

# ===== Step 4: 動作確認 =====
# サブスク認証でCLIが動くか確認（ANTHROPIC_API_KEYを一時的に除外）
unset ANTHROPIC_API_KEY
echo "Hello, respond with just OK" | npx -y @anthropic-ai/claude-code -p --output-format text --model claude-sonnet-4-6
# → テキスト応答が返ればOK

# ===== Step 5: .envに認証モード追加 =====
echo 'CLI_AUTH_MODE=subscription' >> /home/deploy/mothership/.env

# ===== Step 6: PM2再起動 =====
pm2 restart mothership

# ===== 将来APIモードに切り替える場合 =====
# .envのCLI_AUTH_MODE=subscriptionをCLI_AUTH_MODE=apiに変更
# pm2 restart mothership
```

### 8時間トークン期限切れの対策

```bash
# deployユーザーのcrontabに追加（8時間ごとにトークンをウォームアップ）
crontab -e
# 以下を追加:
0 */7 * * * echo "ping" | npx -y @anthropic-ai/claude-code -p --output-format text 2>/dev/null
```

**注意:** この対策は`-p`モードでリフレッシュが動くか不確実。
動かない場合でも、フォールバック機構でAPIキーに切り替わるため、
ユーザー側に影響はない（フォールバック時のみAPI課金が発生する）。

---

## 施策3: Memory Tool統合（概要のみ、別途実装指示待ち）

施策1+2の後に実装。設計は前版の設計書を参照。

変更ファイル:
- `src/claude/client.ts` — tool_use対応
- `src/memory/memoryToolHandler.ts` — 新規
- `src/line/responder.ts` — Memory Tool統合
- `src/line/autoExtract.ts` — 縮小
- `src/line/emotionalState.ts` — メインパスから除去
- `src/agents/dev/prompts.ts` — PM/レビュアーのMemory Tool対応

---

## 動作確認チェックリスト

### 施策1+2デプロイ後の確認項目

- [ ] CLI_AUTH_MODE=subscriptionで開発依頼→CLI実行が成功するか
- [ ] サブスク認証のログに`authMode: 'subscription'`が記録されるか
- [ ] 全サブタスクがSonnetで実行されるか（Opusは最終エスカレーション時のみ）
- [ ] レビュー差し戻し2回でエスカレーションになるか（3回目は実行されない）
- [ ] OAuthエラー発生時にAPIキーにフォールバックするか（ログで確認）
- [ ] バッチ並列タスクが直列に実行されるか（サブスクモード時）
- [ ] CLI_AUTH_MODE=apiに切り替えて正常動作するか
- [ ] APIモードでは並列実行されるか

### フォールバック動作の確認方法

```bash
# サブスク認証を意図的に壊してフォールバックをテスト
# deployユーザーで:
export CLAUDE_CODE_OAUTH_TOKEN="invalid-token-for-test"
# → CLI実行 → サブスク認証失敗 → APIキーフォールバック → 成功
# ログに「サブスクCLI失敗 → APIキーにフォールバック」が記録される
```

---

## リスクと対策の最終まとめ

| リスク | 発生確率 | 影響 | 対策 |
|---|---|---|---|
| **Sonnet品質不足** | 中 | 差し戻し増加 | enableThinkingで補完。最終Opusエスカレーション残す |
| **OAuth 8時間期限切れ** | 中 | CLI失敗 | フォールバック→APIキー。7時間ごとcron |
| **OAuth並列競合** | 高（対策なしの場合） | 認証破壊 | **mutex直列化で根本排除** |
| **サブスク枠枯渇** | 低 | CLI実行ブロック | フォールバック→APIキー |
| **フォールバックループ** | 低（直列化+mutex済み） | 時間2倍 | 1セッションで1回のみフォールバック判定 |
| **`--bare`デフォルト化** | 不明（将来） | サブスクCLI使用不可 | CLI_AUTH_MODE=apiに切り替え |

### フォールバックループが起きない理由

```
CLI実行① → サブスク認証 → 成功 → 完了 ✅
CLI実行② → サブスク認証 → 失敗(OAuth) → APIキーで再実行 → 成功 ✅
CLI実行③ → サブスク認証 → 失敗(OAuth) → APIキーで再実行 → 成功 ✅
```

各CLI実行は独立したプロセス。前回の失敗が次回に伝播しない。
`.credentials.json`の破壊は直列化（mutex）で防止済み。
最悪ケースでも「サブスク試行(2秒)+失敗+APIキー実行(3分)」= 3分2秒。
フォールバックの追加コストは2秒のみ。ループにはならない。
