# CLAUDE.md - 母艦システム開発ガイド

## プロジェクト概要

LINEで指示を送ると、AIが自律的にタスク分解・実行・テスト・自己修正を行い、LINEで報告する「母艦システム」。

## 技術要件

- Node.js 20 LTS + TypeScript (strict mode)
- Express 4
- PostgreSQL 16 + pgvector + pg_trgm（pg Poolで非同期接続）
- @line/bot-sdk
- Claude API (REST直接呼び出し、SDKは使わない)
- PM2 (プロセス管理)
- winston (ログ)

## 重要な制約

### LINE SDK + Express の注意点
- LINE Webhook の署名検証は `@line/bot-sdk` の `middleware` が行う
- `express.json()` をグローバルに適用すると署名検証が壊れる
- Webhook ルーターのみ `line.middleware()` を使い、他のルートには `express.json()` を個別適用する

### Claude API 呼び出し
- モデルエイリアス: `claude-sonnet-4-6-20260312` (デフォルト), `claude-opus-4-6-20260312` (高精度判断用)
- anthropic-version ヘッダー: `2023-06-01`
- SDKは使わず `fetch` で直接呼び出す
- レスポンスの content 配列から type === 'text' のものを結合して使う

### PostgreSQL
- pg Pool（max: 10接続）で非同期接続。getDB()が互換ラッパーを返す
- DB操作は全て非同期: `await db.prepare(sql).get/all/run(...)` 
- SQLの`?`プレースホルダーは自動で`$1,$2...`に変換される（ラッパー内部）
- トランザクション: `await db.withTransaction(async (tx) => { ... })`
- pgvector: embeddingは`vector(1024)`型で保存。`embeddingToSql()`/`parseEmbedding()`で変換
- pg_trgm: `gin_trgm_ops`インデックスでキーワード全文検索

## コーディング規約

- 全ファイル TypeScript strict mode
- エラーハンドリングは try/catch で必ず行う
- ログは winston + DBログの二重化
- 環境変数は config.ts で一元管理。直接 process.env を参照しない

## ビルド・実行

```bash
npm run dev        # tsx で直接実行（開発用）
npm run build      # tsc でコンパイル
npm run start      # dist/index.js を実行
npm run pm2:start  # PM2で本番起動
```

## テスト方法

1. ローカルで `npm run dev` 起動
2. `ngrok http 3000` でトンネル作成
3. LINE Developers でWebhook URLをngrokのURLに設定
4. LINEから「テスト」と送信して応答を確認

## ファイル依存関係

```
index.ts
  ├── config.ts
  ├── db/migrations.ts → db/database.ts
  ├── knowledge/loader.ts → db/database.ts
  ├── line/webhook.ts
  │     ├── line/auth.ts → config.ts
  │     ├── line/sender.ts → config.ts
  │     ├── interpreter/taskInterpreter.ts → claude/client.ts
  │     └── queue/taskQueue.ts → db/database.ts
  └── executor/executor.ts
        ├── queue/taskQueue.ts
        ├── claude/client.ts → claude/budgetTracker.ts
        ├── executor/sandbox.ts → config.ts
        ├── agents/router.ts → agents/soico/soicoAgent.ts
        └── line/sender.ts
```
