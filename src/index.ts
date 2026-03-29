import express from 'express';
import { config } from './config';
import { runMigrations } from './db/migrations';
import { webhookRouter } from './line/webhook';
import { startWorker } from './executor/executor';
import { loadKnowledgeFiles } from './knowledge/loader';
import { logger } from './utils/logger';
import path from 'path';

async function main(): Promise<void> {
  logger.info('母艦システム起動中...');

  // DB初期化
  runMigrations();
  logger.info('DBマイグレーション完了');

  // ナレッジファイルロード
  const knowledgeDir = path.join(__dirname, '..', 'knowledge');
  await loadKnowledgeFiles(knowledgeDir);
  logger.info('ナレッジファイルロード完了');

  // Expressサーバー起動
  const app = express();

  // ヘルスチェック（JSONパーサー不要）
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      env: config.server.env,
    });
  });

  // LINE Webhook（line.middleware が独自にbodyをパースするため express.json() は使わない）
  app.use(webhookRouter);

  app.listen(config.server.port, () => {
    logger.info(`サーバー起動: port ${config.server.port}`);
  });

  // タスク実行ワーカー起動
  startWorker();
  logger.info('ワーカー起動完了');

  logger.info('🚀 母艦システム起動完了');
}

main().catch((err) => {
  logger.error('起動失敗', { err });
  process.exit(1);
});
