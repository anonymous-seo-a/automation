import { logger } from '../../utils/logger';

export interface SchedulerSubtask {
  index: number;
  path: string;
  action: 'create' | 'update';
  description: string;
  depends_on: number[];
}

export interface ExecutionBatch {
  batchIndex: number;
  subtasks: SchedulerSubtask[];
}

/**
 * サブタスクを依存関係に基づいて実行バッチに分割する。
 * 同一バッチ内のサブタスクは並列実行可能。
 * バッチ間は直列（前のバッチが全て完了してから次のバッチを実行）。
 */
export function buildExecutionBatches(subtasks: SchedulerSubtask[]): ExecutionBatch[] {
  const batches: ExecutionBatch[] = [];
  const completed = new Set<number>();
  const remaining = new Set(subtasks.map(s => s.index));

  let batchIndex = 1;
  let maxIterations = subtasks.length + 1; // 無限ループ防止

  while (remaining.size > 0 && maxIterations-- > 0) {
    const batch: SchedulerSubtask[] = [];

    for (const subtask of subtasks) {
      if (!remaining.has(subtask.index)) continue;

      // 依存する全サブタスクが完了済みか確認
      const depsReady = subtask.depends_on.every(dep => completed.has(dep));
      if (depsReady) {
        batch.push(subtask);
      }
    }

    if (batch.length === 0) {
      // 残りがあるのにバッチが空 = 循環依存
      logger.error('循環依存検出。残りを直列実行にフォールバック', { remaining: [...remaining] });
      const fallback = subtasks.filter(s => remaining.has(s.index));
      for (const s of fallback) {
        batches.push({ batchIndex, subtasks: [s] });
        batchIndex++;
      }
      break;
    }

    batches.push({ batchIndex, subtasks: batch });

    for (const s of batch) {
      completed.add(s.index);
      remaining.delete(s.index);
    }

    batchIndex++;
  }

  return batches;
}

/**
 * バッチ計画のサマリーを生成（LINE報告用）
 */
export function formatBatchPlan(batches: ExecutionBatch[]): string {
  return batches.map(b => {
    const files = b.subtasks.map(s => s.path.split('/').pop()).join(', ');
    const parallel = b.subtasks.length > 1 ? '⚡並列' : '📦直列';
    return `バッチ${b.batchIndex} ${parallel}: ${files}`;
  }).join('\n');
}
