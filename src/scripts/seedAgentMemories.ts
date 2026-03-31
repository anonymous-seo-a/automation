/**
 * エージェント記憶の初期シード
 * 各エージェントにシステム構造・規約・自分の役割をembedding付きで学習させる
 *
 * 実行: npx tsx src/scripts/seedAgentMemories.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { getDB } from '../db/database';
import { runMigrations } from '../db/migrations';
import { saveAgentMemoriesBatch, AgentRole, MemoryType } from '../agents/dev/teamMemory';

// DB初期化（マイグレーション実行）
getDB();
runMigrations();

interface SeedEntry {
  agent: AgentRole;
  type: MemoryType;
  key: string;
  content: string;
  source: string;
}

const seeds: SeedEntry[] = [

  // ============================================================
  // 全エージェント共通: システム構造の知識
  // ============================================================

  // -- PM --
  { agent: 'pm', type: 'learning', key: 'system_architecture',
    content: `母艦システムの全体構造:
- Node.js 20 LTS + TypeScript strict + Express 4 + better-sqlite3 (SQLite WAL)
- PM2 fork mode でプロセス管理。ConoHa VPS (Ubuntu) にデプロイ
- LINE Messaging API + Claude API (Sonnet/Opus) + Voyage AI (embedding)
- src/ 配下: agents/, admin/, claude/, db/, events/, line/, memory/, queue/, utils/
- エージェント: SoicoAgent (SEO), DevAgent (自律開発チーム), Bunshin (Daikiの分身)`,
    source: 'seed' },

  { agent: 'pm', type: 'learning', key: 'dev_lifecycle',
    content: `開発会話のライフサイクル:
hearing → defining → approved → implementing → testing → deployed/failed/stuck
- hearing: ユーザーから依頼を受けてヒアリング（最大3回）
- defining: 要件定義書を作成してユーザーに提示
- approved: ユーザーが承認。PMがサブタスク分解
- implementing: エンジニアがサブタスクを1ファイルずつ実装→レビュアーがチェック
- testing: デプロイヤーがビルド→起動テスト→機能テスト
- deployed: 全テスト通過+デプロイ完了。レトロスペクティブ実施
- stuck: 自動解決不能。ユーザーの判断を仰ぐ`,
    source: 'seed' },

  { agent: 'pm', type: 'learning', key: 'file_structure',
    content: `主要ファイルと依存関係:
- src/index.ts: エントリポイント。Express/LINE/Admin/Telegramルーター登録
- src/config.ts: 全環境変数の一元管理。process.env直接参照は禁止
- src/db/database.ts: getDB()でSQLiteインスタンス取得。better-sqlite3同期API
- src/db/migrations.ts: テーブル定義。スキーマ変更はここで行う
- src/claude/client.ts: callClaude() - Claude API呼び出し。リトライ/バジェット管理内蔵
- src/line/webhook.ts: LINE Webhook処理。署名検証はline.middleware()が担当
- src/line/sender.ts: sendLineMessage() - LINE返信
- src/agents/router.ts: エージェント登録・ディスパッチ
- src/agents/dev/devAgent.ts: 自律開発エージェント本体（1400行超）
- src/agents/dev/deployer.ts: ビルド・テスト・デプロイ実行
- src/agents/dev/cliRunner.ts: CLIコマンド実行（タイムアウト・orphan prevention）
- src/utils/logger.ts: winston + DBログ二重化`,
    source: 'seed' },

  { agent: 'pm', type: 'preference', key: 'daiki_style',
    content: `Daikiの開発スタイル:
- 実用的でシンプルな機能を好む。過度に複雑な提案はNG
- 「もう少し実用的な簡単な機能でお願いします！」と言われた実績あり
- 技術的な判断はPMに任せたい。ユーザーには機能面の質問だけにする
- 日本語でコミュニケーション`,
    source: 'seed' },

  { agent: 'pm', type: 'learning', key: 'decompose_rules',
    content: `サブタスク分解の鉄則:
- 1サブタスク = 1ファイルの作成 or 更新
- 依存順: 型定義 → 実装 → 登録 → 設定
- 新規作成は action: "create"、既存変更は action: "update"
- config.tsへの環境変数追加はサブタスクに含める（忘れるとレビューで差し戻される）
- migrations.tsのスキーマ変更もサブタスクに含める（ランタイムALTER TABLEは禁止）`,
    source: 'seed' },

  // -- エンジニア --
  { agent: 'engineer', type: 'learning', key: 'system_architecture',
    content: `母艦システムの技術スタック:
- TypeScript strict mode。全ファイルでstrict準拠が必須
- better-sqlite3: 同期API。async/awaitは不要。db.prepare().run/get/all
- Express 4: LINE webhookのみline.middleware()使用。他はexpress.json()個別適用
- PM2: fork mode。デプロイは pm2 restart mothership
- ビルド: npm run build (tsc) → dist/ にJSが出力`,
    source: 'seed' },

  { agent: 'engineer', type: 'learning', key: 'coding_conventions',
    content: `コーディング規約:
- 環境変数: 必ずconfig.ts経由。process.env.XXXの直接参照は禁止（レビューで即NG）
- エラーハンドリング: try/catchで必ず行う
- ログ: logger (winston) + dbLog (DB) の二重化
- import: 相対パスで正確に。../db/database の getDB (大文字B)
- LINE SDK middleware: express.json()と競合する。Webhookルーターのみline.middleware()
- SQLiteスキーマ変更: migrations.tsで行う。ランタイムALTER TABLEは絶対NG`,
    source: 'seed' },

  { agent: 'engineer', type: 'pattern', key: 'recurring_process_env',
    content: `繰り返し発生: process.env直接参照
過去3回レビューで差し戻された最頻出パターン。
config.tsに変数を追加→config.xxx.yyyで参照する。
→ コード書く前に環境変数が必要か確認し、config.tsへの追加をサブタスクに含めること`,
    source: 'seed' },

  { agent: 'engineer', type: 'pattern', key: 'recurring_webhook_mount',
    content: `繰り返し発生: webhookRouterのルートパスマウント
app.use(webhookRouter) でルートに無条件マウントすると、LINE署名検証ミドルウェアが全エンドポイントに適用され、/health, /admin, /telegram等が壊れる。
→ webhookRouterは /webhook パスにのみマウント`,
    source: 'seed' },

  { agent: 'engineer', type: 'pattern', key: 'recurring_runtime_alter',
    content: `繰り返し発生: ランタイムでのALTER TABLE
better-sqlite3/SQLite環境では ALTER TABLE ADD COLUMN IF NOT EXISTS の互換性が環境依存。
スキーマ変更は必ずmigrations.tsで行い、api呼び出し時のランタイム実行は禁止。`,
    source: 'seed' },

  { agent: 'engineer', type: 'learning', key: 'existing_utilities',
    content: `使うべき既存ユーティリティ:
- callClaude(): src/claude/client.ts。リトライ・バジェット管理・レート制限を内蔵
- getDB(): src/db/database.ts。SQLiteインスタンス取得（大文字B注意）
- logger / dbLog: src/utils/logger.ts。二重ログ
- sendLineMessage(): src/line/sender.ts。LINE返信
- config: src/config.ts。全設定値
- これらを再実装しないこと。importして使う`,
    source: 'seed' },

  { agent: 'engineer', type: 'learning', key: 'json_output_format',
    content: `Claude API呼び出し結果のパース:
- engineerの出力は必ずJSON。説明文やmarkdownは含めない
- 1ファイル: {"file":{"path":"...","content":"...","action":"create|update"}}
- 複数ファイル: {"files":[{...},{...}]}
- contentにはファイル全体の内容を含める（差分ではなく完全なファイル内容）`,
    source: 'seed' },

  // -- レビュアー --
  { agent: 'reviewer', type: 'learning', key: 'system_architecture',
    content: `母艦システムのレビュー時の重点チェックポイント:
- TypeScript strict mode準拠（型の不一致、missing property等）
- config.ts経由の環境変数管理（process.env直接参照は即error）
- LINE SDKとexpress.json()の競合（webhookRouterのマウント位置）
- SQLiteスキーマ変更の方法（migrations.tsで行う。ランタイム禁止）
- 既存export/importとの整合性（既存のexportを壊すと他モジュールが崩壊）
- セキュリティ: SQLインジェクション、ハードコードされた秘密値、XSS`,
    source: 'seed' },

  { agent: 'reviewer', type: 'learning', key: 'review_checklist',
    content: `レビューチェックリスト:
1. 型安全: anyを避ける。as unknown as Xのような危険なキャストをチェック
2. import整合: パスは相対パスで正確か。存在しないモジュールをimportしていないか
3. 既存API準拠: getDB()の大文字B、callClaude()のシグネチャ、config.xxxの構造
4. エラーハンドリング: try/catch漏れ。async関数のunhandled rejection
5. 副作用: グローバル状態の変更、意図しないファイルI/O
6. LINE SDK: middleware()の適用範囲が適切か`,
    source: 'seed' },

  { agent: 'reviewer', type: 'pattern', key: 'recurring_process_env',
    content: `最頻出の差し戻しパターン: process.env直接参照
過去3回指摘済み。開発ルール「環境変数はconfig.ts経由で一元管理」に明確に違反。
→ error判定。config.tsへの追加を要求`,
    source: 'seed' },

  { agent: 'reviewer', type: 'pattern', key: 'recurring_webhook_mount',
    content: `繰り返し指摘: webhookRouterのルートパスへの無条件マウント
app.use(webhookRouter) → LINE署名検証が全エンドポイントに適用される重大問題。
→ error判定。/webhook パスへの限定マウントを要求`,
    source: 'seed' },

  { agent: 'reviewer', type: 'pattern', key: 'recurring_schema_runtime',
    content: `繰り返し指摘: ランタイムでのスキーマ変更
ALTER TABLE をAPI呼び出し時に実行するコードが複数回提出された。
SQLiteの互換性問題+パフォーマンス問題。migrations.tsでの対応を要求。
→ error判定`,
    source: 'seed' },

  { agent: 'reviewer', type: 'learning', key: 'severity_guidelines',
    content: `severity判定基準:
- error（承認不可）: 実行時クラッシュ、セキュリティ問題、開発ルール違反、既存機能破壊
- warning（承認可・注意喚起）: パフォーマンス懸念、命名規則、コメント不足、軽微な設計問題
errorが1つでもあれば approved: false`,
    source: 'seed' },

  // -- デプロイヤー --
  { agent: 'deployer', type: 'learning', key: 'system_architecture',
    content: `デプロイ環境の構成:
- VPS: ConoHa Ubuntu。ユーザー: deploy。パス: /home/deploy/mothership
- Node.js: v20 LTS (nvm管理)
- PM2: fork mode。mothership プロセス
- ビルド: npm run build → tsc → dist/
- デプロイフロー: git操作 → npm run build → pm2 restart → 60秒待機 → ヘルスチェック
- ヘルスチェック: curl http://localhost:3000/health → {"status":"ok"} を確認
- ロールバック: git checkout でブランチを切り替えて再ビルド`,
    source: 'seed' },

  { agent: 'deployer', type: 'learning', key: 'test_stages',
    content: `テストの段階:
1. ビルドテスト: npm run build (tsc)。TypeScript型エラーを全て解決
2. 起動テスト: PM2でサーバーを起動し、/health エンドポイントの応答を確認
   - 応答なし = 起動クラッシュ。エラーログを確認してエンジニアに差し戻し
   - サーバーが起動前にexit code 1で終了するパターンが頻出
3. 機能テスト: 変更した機能が正しく動作するか確認
   - LINE webhookの署名検証が他エンドポイントを阻害していないか`,
    source: 'seed' },

  { agent: 'deployer', type: 'pattern', key: 'recurring_startup_crash',
    content: `繰り返し発生: テスト用サーバーが起動前にexit code 1で終了
過去6回発生した最頻出の失敗パターン。原因の多くは:
- import先のモジュールが存在しない
- config.tsに未定義の環境変数を参照
- migrations.tsのSQL構文エラー
→ ビルド通過後でも起動テストで検出される。エラーログの最初の数行が根本原因`,
    source: 'seed' },

  { agent: 'deployer', type: 'pattern', key: 'recurring_healthcheck_fail',
    content: `繰り返し発生: ヘルスチェック接続失敗
サーバーは起動したがヘルスチェックに応答しないケース。原因:
- Expressのルーター登録順序の問題
- ミドルウェアが全リクエストをブロック
- ポート競合（PM2の既存プロセスが残っている）
→ pm2 delete → pm2 start で再起動を試みる`,
    source: 'seed' },

  { agent: 'deployer', type: 'learning', key: 'error_classification',
    content: `テスト失敗のエラー分類:
- transient (一時的): API制限(429)、ネットワーク障害 → 待機してリトライ
- environment (環境): 権限、パス、設定ミス → autoFixableなら自動修正
- code (コード): TypeScriptエラー、ロジックミス → エンジニアに差し戻し
- unknown (不明): 上記に該当しない → チーム診断会議に移行`,
    source: 'seed' },
];

async function main() {
  console.log(`=== エージェント記憶シード開始 ===`);
  console.log(`エントリ数: ${seeds.length}`);

  // エージェントごとに集計
  const counts: Record<string, number> = {};
  for (const s of seeds) {
    counts[s.agent] = (counts[s.agent] || 0) + 1;
  }
  console.log('エージェント別:', JSON.stringify(counts));

  try {
    await saveAgentMemoriesBatch(seeds);
    console.log('✅ シード完了（embedding付き）');
  } catch (err) {
    console.error('❌ バッチ保存失敗:', err instanceof Error ? err.message : String(err));
    console.log('フォールバック: embeddingなしで個別保存...');

    // フォールバック: 同期版で1つずつ保存
    const { saveAgentMemory } = await import('../agents/dev/teamMemory');
    for (const s of seeds) {
      try {
        saveAgentMemory(s.agent, s.type, s.key, s.content, s.source);
      } catch (e) {
        console.error(`  ❌ ${s.agent}/${s.key}:`, e instanceof Error ? e.message : String(e));
      }
    }
    console.log('✅ フォールバック保存完了（embeddingなし）');
  }

  // 結果確認
  const { getDB } = await import('../db/database');
  const db = getDB();
  const stats = db.prepare(`
    SELECT agent, type, COUNT(*) as cnt,
           SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as with_embedding
    FROM agent_memories GROUP BY agent, type ORDER BY agent, type
  `).all() as Array<{ agent: string; type: string; cnt: number; with_embedding: number }>;

  console.log('\n=== 記憶統計 ===');
  for (const row of stats) {
    console.log(`  ${row.agent}/${row.type}: ${row.cnt}件 (embedding: ${row.with_embedding}件)`);
  }

  const total = db.prepare('SELECT COUNT(*) as cnt FROM agent_memories').get() as { cnt: number };
  const withEmb = db.prepare('SELECT COUNT(*) as cnt FROM agent_memories WHERE embedding IS NOT NULL').get() as { cnt: number };
  console.log(`\n合計: ${total.cnt}件 (embedding付き: ${withEmb.cnt}件)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
