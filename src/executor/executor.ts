import { getNextTask, updateTaskStatus, TaskRow } from '../queue/taskQueue';
import { runInSandbox } from './sandbox';
import { sendLineMessage } from '../line/sender';
import { generateResponse } from '../line/responder';
import { getAgent } from '../agents/router';
import { Task } from '../agents/baseAgent';
import { config } from '../config';
import { logger, dbLog } from '../utils/logger';

const POLL_INTERVAL_MS = 5000;
let isRunning = false;
let isProcessing = false;

export function startWorker(): void {
  if (isRunning) return;
  isRunning = true;
  logger.info('Worker started');
  poll();
}

export function stopWorker(): void {
  isRunning = false;
  logger.info('Worker stopped');
}

async function poll(): Promise<void> {
  while (isRunning) {
    try {
      if (!isProcessing) {
        const task = getNextTask();
        if (task) {
          isProcessing = true;
          try {
            await executeTask(task);
          } finally {
            isProcessing = false;
          }
        }
      }
    } catch (err) {
      isProcessing = false;
      logger.error('Worker poll error', { err });
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function executeTask(task: TaskRow): Promise<void> {
  updateTaskStatus(task.id, 'running');
  dbLog('info', 'executor', `タスク開始: ${task.description}`, { taskId: task.id });

  try {
    // エージェントをルーター経由で取得
    const agent = getAgent(task.agent);
    if (!agent) {
      await handleFailure(task, `未知のエージェント: ${task.agent}`);
      return;
    }

    // TaskRow → Agent用Task に変換
    const agentTask: Task = {
      id: task.id,
      agent: task.agent,
      description: task.description,
      priority: task.priority,
      retry_count: task.retry_count,
      requires_opus: task.requires_opus,
      input_data: task.input_data || undefined,
      error_log: task.error_log || undefined,
    };

    logger.info(`エージェント実行: ${agent.name}`, { taskId: task.id });
    const result = await agent.execute(agentTask);

    if (!result.success) {
      await handleFailure(task, result.output);
      return;
    }

    // エージェントがコード実行を要求した場合
    if (result.needsExecution && result.code && result.language) {
      const execResult = await runInSandbox(result.code, result.language);

      if (execResult.success) {
        updateTaskStatus(task.id, 'success', {
          output: JSON.stringify({
            aiResponse: result.output.slice(0, 3000),
            execResult: execResult.stdout,
          }),
        });
        await notifySuccess(task, result.output, execResult.stdout);
      } else {
        await handleFailure(task, `実行エラー: ${execResult.stderr}`);
      }
    } else {
      // コード不要のタスク（分析・レポート等）
      updateTaskStatus(task.id, 'success', { output: result.output });
      await notifySuccess(task, result.output);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // 予算超過は即通知（リトライしない）
    if (errMsg.includes('BUDGET_EXCEEDED')) {
      updateTaskStatus(task.id, 'failed', { error: errMsg });
      const msg = await generateResponse(
        `予算上限に達しました: ${errMsg}`,
        { rawContext: '予算超過でタスクが停止したことをユーザーに伝え、ダッシュボードで予算を確認するよう促してください。' }
      );
      await sendLineMessage(config.line.allowedUserId, msg);
      return;
    }

    await handleFailure(task, errMsg);
  }
}

async function handleFailure(task: TaskRow, errorMsg: string): Promise<void> {
  const currentRetry = task.retry_count + 1;

  if (currentRetry >= task.max_retries) {
    updateTaskStatus(task.id, 'failed', { error: errorMsg });

    const msg = await generateResponse(
      `タスクが最終的に失敗しました`,
      {
        errorInfo: {
          description: task.description,
          error: errorMsg,
          retryCount: currentRetry,
          maxRetries: task.max_retries,
        },
        rawContext: `タスクID: ${task.id}\nダッシュボードで詳細を確認できます: ${config.admin.baseUrl}/admin/tasks/${task.id}`,
      }
    );
    await sendLineMessage(config.line.allowedUserId, msg);

    dbLog('error', 'executor', 'タスク最終失敗', {
      taskId: task.id,
      error: errorMsg,
    });
  } else {
    // pendingに戻してリトライ
    updateTaskStatus(task.id, 'pending', { error: errorMsg });
    dbLog('warn', 'executor', `リトライ予定 ${currentRetry}/${task.max_retries}`, {
      taskId: task.id,
    });
  }
}

async function notifySuccess(
  task: TaskRow,
  aiResponse: string,
  execOutput?: string
): Promise<void> {
  const msg = await generateResponse(
    `タスクが完了しました`,
    {
      taskResult: {
        description: task.description,
        output: aiResponse,
        execResult: execOutput,
      },
      rawContext: `タスクID: ${task.id}\n詳細: ${config.admin.baseUrl}/admin/tasks/${task.id}`,
    }
  );
  await sendLineMessage(config.line.allowedUserId, msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
