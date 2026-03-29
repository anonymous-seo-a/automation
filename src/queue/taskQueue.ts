import { getDB } from '../db/database';
import { ParsedTask } from '../interpreter/taskInterpreter';

export interface TaskRow {
  id: string;
  parent_id: string | null;
  agent: string;
  description: string;
  status: string;
  priority: number;
  retry_count: number;
  max_retries: number;
  input_data: string | null;
  output_data: string | null;
  error_log: string;
  requires_opus: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function enqueueTask(task: ParsedTask): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO tasks (id, agent, description, priority, requires_opus, input_data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.agent,
    task.description,
    task.priority,
    task.requires_opus ? 1 : 0,
    task.input_data ? JSON.stringify(task.input_data) : null
  );
}

export function getNextTask(): TaskRow | null {
  const db = getDB();
  const row = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `).get() as TaskRow | undefined;
  return row || null;
}

export function updateTaskStatus(
  taskId: string,
  status: string,
  data?: { output?: string; error?: string }
): void {
  const db = getDB();

  if (data?.error) {
    // エラー追加 + リトライカウント増加
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          error_log = json_insert(COALESCE(error_log, '[]'), '$[#]', ?),
          retry_count = retry_count + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, data.error, taskId);
  } else if (data?.output) {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          output_data = ?,
          updated_at = datetime('now'),
          completed_at = CASE WHEN ? IN ('success', 'failed') THEN datetime('now') ELSE completed_at END
      WHERE id = ?
    `).run(status, data.output, status, taskId);
  } else {
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          updated_at = datetime('now'),
          completed_at = CASE WHEN ? IN ('success', 'failed') THEN datetime('now') ELSE completed_at END
      WHERE id = ?
    `).run(status, status, taskId);
  }
}

export function getStatusReport(): string {
  const db = getDB();
  const counts = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM tasks
    GROUP BY status
  `).all() as Array<{ status: string; cnt: number }>;

  const lines = ['📊 タスク状況:'];
  const emojiMap: Record<string, string> = {
    pending: '⏳', running: '🔄', success: '✅', failed: '❌', waiting_input: '❓',
  };

  for (const row of counts) {
    const emoji = emojiMap[row.status] || '❓';
    lines.push(`${emoji} ${row.status}: ${row.cnt}件`);
  }

  if (counts.length === 0) lines.push('タスクはありません');
  return lines.join('\n');
}
