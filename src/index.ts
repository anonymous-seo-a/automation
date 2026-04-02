import express, { Request, Response } from 'express';
import { config } from './config';
import { runMigrations } from './db/migrations';
import { webhookRouter } from './line/webhook';
import { telegramRouter } from './telegram/webhook';
import { adminRouter } from './admin/dashboard';
import { startWorker } from './executor/executor';
import { loadKnowledgeFiles } from './knowledge/loader';
import { interpretTask } from './interpreter/taskInterpreter';
import { enqueueTask } from './queue/taskQueue';
import { checkIdleSessions } from './memory/session';
import { runDailyConsolidation } from './memory/consolidation';
import { consolidateAgentMemories, AgentRole } from './agents/dev/teamMemory';
import { loadKnowledgeCache } from './line/bunshinPrompt';
import { completePendingDeploy } from './agents/dev/deployer';
import { initEmbeddingCache } from './memory/embeddingCache';
import { logger } from './utils/logger';
import path from 'path';

async function main(): Promise<void> {
  logger.info('母艦システム起動中...');

  // DB初期化
  await runMigrations();
  logger.info('DBマイグレーション完了');

  // Embeddingキャッシュ初期化（DBから全embeddingをメモリにロード）
  await initEmbeddingCache();

  // ナレッジファイルロード（DB + 分身プロンプトキャッシュ）
  const knowledgeDir = path.join(__dirname, '..', 'knowledge');
  await loadKnowledgeFiles(knowledgeDir);
  await loadKnowledgeCache();
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

  // 管理ダッシュボード（BASIC認証付き）
  app.use('/admin', adminRouter);

  // LINE Webhook（line.middleware が独自にbodyをパースするため express.json() は使わない）
  // /webhook でも / でもLINEからのリクエストを受け付ける
  app.use('/webhook', webhookRouter);
  app.use(webhookRouter);

  // Telegram Webhook（express.json() でボディパース）
  app.use('/telegram', express.json(), telegramRouter);
  if (config.telegram.botToken) {
    logger.info('Telegram Webhook 有効: /telegram');
  }

  // テストエンドポイント（LINE経由せずにタスク投入、テスト環境でも使用）
  if (config.server.env !== 'production' || process.env.NODE_ENV === 'test') {
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
          await enqueueTask(task);
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

    // PendingDeploy後処理（pm2 restart後にヘルスチェック・push・通知を完了させる）
    completePendingDeploy().catch(err =>
      logger.error('PendingDeploy後処理失敗', { err: err instanceof Error ? err.message : String(err) })
    );
  });

  // タスク実行ワーカー起動
  startWorker();
  logger.info('ワーカー起動完了');

  // アイドルセッション定期チェック（5分間隔）
  setInterval(() => {
    checkIdleSessions().catch(err =>
      logger.warn('アイドルセッションチェック失敗', { err: err instanceof Error ? err.message : String(err) })
    );
  }, 5 * 60 * 1000);
  logger.info('セッション監視起動完了');

  // 日次記憶統合（毎日3:00 AM に実行）
  scheduleDailyConsolidation();
  logger.info('日次記憶統合スケジュール設定完了');

  logger.info('🚀 母艦システム起動完了');
}

function scheduleDailyConsolidation(): void {
  const run = () => {
    const now = new Date();
    // 次の3:00 AMまでのミリ秒を計算
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    const delay = next.getTime() - now.getTime();

    setTimeout(async () => {
      try {
        await runDailyConsolidation();
        // エージェント記憶の統合も実行
        for (const agent of ['pm', 'engineer', 'reviewer', 'deployer'] as AgentRole[]) {
          await consolidateAgentMemories(agent).catch(err =>
            logger.warn(`エージェント記憶統合失敗: ${agent}`, { err: err instanceof Error ? err.message : String(err) })
          );
        }
      } catch (err) {
        logger.error('日次記憶統合失敗', { err: err instanceof Error ? err.message : String(err) });
      }
      run(); // 次の日もスケジュール
    }, delay);

    logger.info(`次回記憶統合: ${next.toISOString()}`);
  };
  run();
}

main().catch((err) => {
  logger.error('起動失敗', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('未処理のPromise拒否', { err: reason instanceof Error ? reason.message : String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('未キャッチの例外', { err: err.message, stack: err.stack });
  process.exit(1);
});
