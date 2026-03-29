# 母艦システム (Mothership)

LINEで指示を送ると、AIが自律的に開発・実行・テスト・自己修正を行い、完成したらLINEで報告するシステム。

## アーキテクチャ

```
[LINE] ←→ [nginx] ←→ [Express Server]
                           ↓
                   [Task Interpreter (Sonnet 4.6)]
                           ↓
                   [Task Queue (SQLite)]
                           ↓
                   [Agent Router]
                           ↓
                   [soico最適化AI] → [Executor] → [LINE報告]
```

## 技術スタック

- **Runtime**: Node.js 20 LTS + TypeScript
- **Server**: Express 4
- **AI**: Claude API (Sonnet 4.6 主軸 / Opus 4.6 判断用)
- **DB**: SQLite3 (better-sqlite3)
- **Messaging**: LINE Messaging API
- **Process**: PM2
- **Proxy**: nginx + Let's Encrypt

## モデルルーティング

| 処理 | モデル | コスト/1M tokens |
|------|--------|-----------------|
| 指示解釈・コード生成 | Sonnet 4.6 | $3 / $15 |
| 戦略判断・複雑分析 | Opus 4.6 | $5 / $25 |

月間予算: ~3万円（Sonnet 90% + Opus 10%）

## セットアップ

```bash
npm install
cp .env.example .env
# .env に各種キーを設定
npm run dev        # 開発
npm run build      # ビルド
npm run pm2:start  # 本番起動
```

## LINEコマンド

- `状況` - タスク状況を確認
- `予算` - API使用状況を確認
- 任意のテキスト - タスクとして解釈・実行

## ディレクトリ構成

```
src/
├── index.ts              # エントリーポイント
├── config.ts             # 環境変数・設定
├── line/                 # LINE連携
├── interpreter/          # 指示→タスク変換
├── queue/                # タスクキュー管理
├── agents/               # AIエージェント
│   └── soico/            # soico最適化エージェント
├── executor/             # 自律実行ループ
├── knowledge/            # ナレッジDB管理
├── claude/               # Claude APIクライアント
├── db/                   # SQLite管理
└── utils/                # ユーティリティ
```

## 段階リリース

1. **Phase 1**: 母艦コア（LINE連携 + タスク管理 + Executor）
2. **Phase 2**: soico最適化エージェント
3. **Phase 3**: ナレッジDB統合
4. **Phase 4**: 予算管理・監視
5. **Phase 5+**: 追加エージェント（収益スカウト、SNS、メンタル安全装置）
