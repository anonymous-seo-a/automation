export interface Task {
  id: string;
  agent: string;
  description: string;
  priority: number;
  retry_count: number;
  requires_opus: number;
  input_data?: string;
  error_log?: string;
}

export interface TaskResult {
  success: boolean;
  output: string;
  needsExecution: boolean;
  code?: string;
  language?: 'node' | 'python' | 'bash';
}

export interface Agent {
  name: string;
  execute(task: Task): Promise<TaskResult>;
}
