import { getNextTask, updateTaskStatus, TaskRow } from '../queue/taskQueue';
import { callClaude } from '../claude/client';
import { runInSandbox } from './sandbox';
import { sendLineMessage } from '../line/sender';
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

  const useOpus = task.requires_opus === 1 || task.retry_count >= 2;
  const model = useOpus ? 'opus' as const : 'default' as const;

  try {
    const errorContext = task.error_log && task.error_log !== '[]'
      ? `\n\n## 前回のエラー（リトライ ${task.retry_count}回目）\n${task.error_log}\n上記のエラーを踏まえ、アプローチを変更してください。`
      : '';

    const systemPrompt = `あなたは自律実行エージェントです。
タスクを実行し、必要であれば実行可能なコードを生成してください。

## コード生成ルール
- コードを生成する場合は以下の形式で囲んでください:
\`\`\`executable:node
// ここにNode.jsコード
\`\`\`
- python や bash も使用可能です: \`\`\`executable:python または \`\`\`executable:bash
- コードが不要な場合（分析・提案・レポート等）はテキストで結果を返してください

## 現在のタスク
${task.description}

${task.input_data ? `## 追加情報\n${task.input_data}` : ''}${errorContext}`;

    const { text } = await callClaude({
      system: systemPrompt,
      messages: [{ role: 'user', content: `実行してください: ${task.description}` }],
      model,
      taskId: task.id,
    });

    // コードブロックの抽出
    const codeMatch = text.match(/```executable:(node|python|bash)\n([\s\S]*?)```/);

    if (codeMatch) {
      const lang = codeMatch[1] as 'node' | 'python' | 'bash';
      const code = codeMatch[2];
      const result = await runInSandbox(code, lang);

      if (result.success) {
        updateTaskStatus(task.id, 'success', {
          output: JSON.stringify({
            aiResponse: text.slice(0, 3000),
            execResult: result.stdout,
          }),
        });
        await notifySuccess(task, text, result.stdout);
      } else {
        await handleFailure(task, `実行エラー: ${result.stderr}`);
      }
    } else {
      // コード不要のタスク（分析・レポート等）
      updateTaskStatus(task.id, 'success', { output: text });
      await notifySuccess(task, text);
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
