import express, { Request, Response } from 'express';
import { config } from './config';
import { runMigrations } from './db/migrations';
import { webhookRouter } from './line/webhook';
import { startWorker } from './executor/executor';
import { loadKnowledgeFiles } from './knowledge/loader';
import { interpretTask } from './interpreter/taskInterpreter';
import { enqueueTask } from './queue/taskQueue';
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
  // /webhook でも / でもLINEからのリクエストを受け付ける
  app.use('/webhook', webhookRouter);
  app.use(webhookRouter);

  // 開発用テストエンドポイント（LINE経由せずにタスク投入）
  if (config.server.env !== 'production') {
    app.post('/test/task', express.json(), async (req: Request, res: Response) => {
      try {
        const message = req.body?.message;
        if (!message || typeof message !== 'string') {
          res.status(400).json({ error: 'message (string) is required' });
          return;
        }

        const interpreted = await interpretTask(message);

        if (interpreted.confirmation_needed) {
          res.json({ status: 'confirmation_needed', question: interpreted.clarification_question });
          return;
        }

        for (const task of interpreted.tasks) {
          enqueueTask(task);
        }

        res.json({
          status: 'queued',
          tasks: interpreted.tasks,
          estimated_api_calls: interpreted.estimated_api_calls,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('テストエンドポイントエラー', { err: errMsg });
        res.status(500).json({ error: errMsg });
      }
    });
    logger.info('開発用テストエンドポイント /test/task 有効');
  }

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
