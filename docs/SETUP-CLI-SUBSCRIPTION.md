# CLIサブスク認証セットアップ手順

**前提:** コード側の実装はデプロイ済み。以下はDaikiが帰宅後に実施する手順。

---

## Step 1: ローカルMacでOAuthトークン生成

```bash
# ターミナルで実行
claude setup-token
```

1. ブラウザが開く → Anthropicアカウントでログイン
2. 認証完了後、ターミナルに `sk-ant-oat01-xxxx...` が表示される
3. **このトークンは1回しか表示されない。必ずコピーする。**

---

## Step 2: VPSにSSH

```bash
ssh -i ~/.ssh/vps_mothership root@bot.anonymous-seo.jp
```

---

## Step 3: deployユーザーにOAuthトークンを設定

```bash
su - deploy

# OAuthトークンを環境変数に追加
echo 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-ここにStep1のトークンを貼付"' >> ~/.bashrc
source ~/.bashrc

# Claude CLI設定ファイルを作成（なければ）
cat > ~/.claude.json << 'EOF'
{
  "hasCompletedOnboarding": true
}
EOF
```

---

## Step 4: 動作確認

```bash
# ANTHROPIC_API_KEYを一時的に無効化してサブスク認証を確認
unset ANTHROPIC_API_KEY

# CLIがサブスク認証で動くか確認
echo "Hello, respond with just OK" | npx -y @anthropic-ai/claude-code -p --output-format text --model claude-sonnet-4-6

# → テキスト応答が返ればOK
# → エラーが出る場合はStep 1からやり直し
```

---

## Step 5: .envの認証モードを切り替え

```bash
# 母艦の.envに追加
echo 'CLI_AUTH_MODE=subscription' >> /home/deploy/mothership/.env
```

---

## Step 6: PM2再起動

```bash
pm2 restart mothership
```

---

## Step 7: 実際に開発依頼してテスト

LINEまたはTelegramから開発依頼を送る。
VPSのログで以下を確認:

```bash
pm2 logs mothership --lines 30
# → 「Claude CLI実行開始 ... authMode: 'subscription'」が出ればOK
# → 「サブスクCLI失敗 → APIキーにフォールバック」が出た場合はOAuth設定を確認
```

---

## 将来: APIモードに戻す場合

```bash
# .envのCLI_AUTH_MODEを変更
vi /home/deploy/mothership/.env
# CLI_AUTH_MODE=subscription → CLI_AUTH_MODE=api に変更

# 再起動
pm2 restart mothership
```

---

## トラブルシューティング

### 「Not logged in」エラー
→ `CLAUDE_CODE_OAUTH_TOKEN` が正しく設定されているか確認
```bash
su - deploy -c 'echo $CLAUDE_CODE_OAUTH_TOKEN' | head -c 20
# → sk-ant-oat01- で始まればOK
```

### 「OAuth token has expired」エラー
→ setup-tokenで新しいトークンを生成し、~/.bashrcを更新
→ またはAPIモードに切り替え: `CLI_AUTH_MODE=api`

### 「Rate limit」エラーが頻発
→ Maxプランの枠を使い切った可能性。APIモードにフォールバックしているかログで確認
→ フォールバックが動いていればサービス自体は正常

### フォールバックばかりでサブスク意味なし
→ OAuthトークンが期限切れの可能性。setup-tokenを再実行
→ 8時間ごとにcronで事前ウォームアップを設定:
```bash
crontab -e
# 追加:
0 */7 * * * su - deploy -c 'echo "ping" | npx -y @anthropic-ai/claude-code -p --output-format text 2>/dev/null'
```
