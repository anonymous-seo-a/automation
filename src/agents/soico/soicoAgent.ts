import { Agent, Task, TaskResult } from '../baseAgent';
import { callClaude } from '../../claude/client';
import { SOICO_SYSTEM_PROMPT } from './prompts';
import { searchKnowledge } from '../../knowledge/knowledgeDB';

export class SoicoAgent implements Agent {
  name = 'soico';

  async execute(task: Task): Promise<TaskResult> {
    const relevantKnowledge = await searchKnowledge(task.description);
    const knowledgeContext = relevantKnowledge.length > 0
      ? `\n\n## 参考ナレッジ\n${relevantKnowledge.join('\n---\n')}`
      : '';

    const errorContext = task.error_log && task.error_log !== '[]'
      ? `\n\n## 前回のエラー\n${task.error_log}\nアプローチを変更してください。`
      : '';

    const model = task.requires_opus === 1 || task.retry_count >= 2
      ? 'opus' as const
      : 'default' as const;

    const { text } = await callClaude({
      system: SOICO_SYSTEM_PROMPT + knowledgeContext + errorContext,
      messages: [{ role: 'user', content: task.description }],
      model,
      taskId: task.id,
    });

    const codeMatch = text.match(
      /```executable:(node|python|bash)\n([\s\S]*?)```/
    );

    return {
      success: true,
      output: text,
      needsExecution: !!codeMatch,
      code: codeMatch?.[2],
      language: codeMatch?.[1] as 'node' | 'python' | 'bash' | undefined,
    };
  }
}
