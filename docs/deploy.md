# VPSデプロイ手順

## 1. ConoHa VPS初期設定

```bash
# ConoHa管理画面で:
# VPS追加 → Ubuntu 22.04 → 4GBプラン → rootパスワード設定
# セキュリティグループで 22, 80, 443 を開放

# SSH接続後 ---
adduser deploy
usermod -aG sudo deploy
su - deploy
mkdir ~/.ssh && chmod 700 ~/.ssh
# ローカルから: ssh-copy-id deploy@YOUR_IP

# パスワード認証無効化
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# ファイアウォール
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

## 2. ランタイムインストール

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 + TypeScript
sudo npm install -g pm2 typescript

# nginx
sudo apt-get install -y nginx

# certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Python3 (sandbox用)
sudo apt-get install -y python3

# build-essential (better-sqlite3のビルドに必要)
sudo apt-get install -y build-essential
```

## 3. ドメイン設定

1. ドメイン取得（お名前.com等）
2. DNSのAレコードにConoHa VPSのIPアドレスを設定
3. 反映を待つ（数分〜数時間）

## 4. nginx設定

```bash
sudo nano /etc/nginx/sites-available/mothership
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mothership /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# SSL証明書
sudo certbot --nginx -d your-domain.com
```

## 5. アプリケーションデプロイ

```bash
cd /home/deploy
git clone https://github.com/anonymous-seo-a/automation.git mothership
cd mothership

# 環境変数設定
cp .env.example .env
nano .env  # 各値を入力

# ナレッジファイル配置
# knowledge/ に5つのMarkdownファイルを配置

# 依存関係 + ビルド
npm install
npm run build

# サンドボックスディレクトリ
sudo mkdir -p /tmp/mothership/sandbox
sudo chown deploy:deploy /tmp/mothership/sandbox

# PM2起動
npm run pm2:start
pm2 save
pm2 startup  # 表示されたコマンドをsudoで実行
```

## 6. LINE Messaging API設定

1. https://developers.line.biz/ にログイン
2. 新規プロバイダー → 新規チャネル（Messaging API）
3. チャネルシークレット → `.env` の `LINE_CHANNEL_SECRET`
4. チャネルアクセストークン(長期)発行 → `.env` の `LINE_CHANNEL_ACCESS_TOKEN`
5. Webhook URL: `https://your-domain.com/webhook`
6. Webhookの利用: ON
7. 応答メッセージ: OFF
8. 友だち追加してテスト送信
9. ログからUser IDを取得: `pm2 logs mothership`
10. `.env` の `ALLOWED_LINE_USER_ID` に設定
11. `pm2 restart mothership`

## 7. 動作確認チェックリスト

- [ ] `https://your-domain.com/health` → `{"status":"ok"}`
- [ ] LINEで「ping」→「pong 🏓 母艦稼働中」
- [ ] LINEで「状況」→ タスク状況表示
- [ ] LINEで「予算」→ API使用状況表示
- [ ] LINEで「カードローンカテゴリのSEO監査をして」→ タスク実行→結果報告
- [ ] 未認証ユーザーからのメッセージが無視される
- [ ] `pm2 status` でプロセス稼働確認
- [ ] `data/mothership.db` にデータ記録確認
