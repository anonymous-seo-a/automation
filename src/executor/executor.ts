import { getNextTask, updateTaskStatus, TaskRow } from '../queue/taskQueue';
import { runInSandbox } from './sandbox';
import { sendLineMessage } from '../line/sender';
import { getAgent } from '../agents/router';
import { Task } from '../agents/baseAgent';
import { config } from '../config';
import { logger, dbLog } from '../utils/logger';

const POLL_INTERVAL_MS = 5000;
let isRunning = false;

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
      const task = getNextTask();
      if (task) {
        await executeTask(task);
      }
    } catch (err) {
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
      await sendLineMessage(config.line.allowedUserId,
        `⚠️ 予算上限に達しました。\n${errMsg}\n全エージェントを一時停止します。`
      );
      return;
    }

    await handleFailure(task, errMsg);
  }
}

async function handleFailure(task: TaskRow, errorMsg: string): Promise<void> {
  const currentRetry = task.retry_count + 1;

  if (currentRetry >= task.max_retries) {
    updateTaskStatus(task.id, 'failed', { error: errorMsg });
    await sendLineMessage(config.line.allowedUserId,
      `❌ タスク失敗（${task.max_retries}回リトライ後）:\n` +
      `📋 ${task.description}\n` +
      `🔴 最終エラー: ${errorMsg.slice(0, 500)}\n\n` +
      `修正指示をお願いします。`
    );
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
  let msg = `✅ タスク完了:\n📋 ${task.description}\n\n`;

  if (aiResponse.length > 1500) {
    msg += aiResponse.slice(0, 1500) + '\n...(省略)';
  } else {
    msg += aiResponse;
  }

  if (execOutput && execOutput.trim()) {
    msg += `\n\n📤 実行結果:\n${execOutput.slice(0, 500)}`;
  }

  await sendLineMessage(config.line.allowedUserId, msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
