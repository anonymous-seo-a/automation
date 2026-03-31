import { getDB } from '../../db/database';
import { callClaude } from '../../claude/client';
import { buildAgentPersonality } from './prompts';
import { pmEvaluateByConversation } from './teamEvaluation';
import { AgentRole } from './teamMemory';
import { logger } from '../../utils/logger';

export interface ConversationEntry {
  role: string;
  message: string;
  timestamp: string;
}

/** 相談を処理（メンバー -> PM） */
export async function handleConsult(
  fromAgent: AgentRole,
  question: string,
  options?: string[],
  recommendation?: string,
  taskContext?: string,
): Promise<string> {
  const consultMsg = [
    `${fromAgent}からの相談:`,
    question,
    options ? `選択肢: ${options.join(' / ')}` : '',
    recommendation ? `本人の推奨: ${recommendation}` : '',
    taskContext ? `背景: ${taskContext}` : '',
  ].filter(Boolean).join('\n');

  const { text: pmAnswer } = await callClaude({
    system: await buildAgentPersonality('pm') +
      '\n\nメンバーからの相談に回答してください。合議が必要なら {"consensus_needed": true, "topic": "議題"} を返してください。それ以外はテキストで回答。',
    messages: [{ role: 'user', content: consultMsg }],
    model: 'default',
  });

  saveTeamConversation('consult', [fromAgent, 'pm'], [
    { role: fromAgent, message: question, timestamp: now() },
    { role: 'pm', message: pmAnswer, timestamp: now() },
  ]);

  // PM -> メンバーの会話評価（バックグラウンド）
  pmEvaluateByConversation(fromAgent, `質問: ${question}\n回答: ${pmAnswer}`).catch(() => {});

  return pmAnswer;
}

/** 直接差し戻し（レビュアー/デプロイヤー -> エンジニア、PM経由しない） */
export function recordReject(
  fromAgent: AgentRole,
  toAgent: AgentRole,
  reason: string,
  fixSuggestion: string,
  severity: 'critical' | 'major' | 'minor',
  notifyPm: boolean,
  taskId?: string,
): void {
  saveTeamConversation('reject', [fromAgent, toAgent], [
    { role: fromAgent, message: `差し戻し [${severity}]: ${reason}\n修正案: ${fixSuggestion}`, timestamp: now() },
  ], taskId);

  if (notifyPm) {
    saveTeamConversation('consult', [fromAgent, 'pm'], [
      { role: fromAgent, message: `エンジニアに差し戻しましたが、設計レベルの問題かもしれません:\n${reason}`, timestamp: now() },
    ], taskId);
  }
}

/** 合議を実行（PM主導、全員参加） */
export async function runConsensus(
  topic: string,
  context: string,
  taskId?: string,
): Promise<{ decision: string; log: ConversationEntry[] }> {
  const log: ConversationEntry[] = [];

  // PMが議題を提示
  const { text: pmOpening } = await callClaude({
    system: await buildAgentPersonality('pm'),
    messages: [{ role: 'user', content: `以下の議題について、チーム全員の意見を聞きます。\n議題: ${topic}\n背景: ${context}\n\n各メンバーに聞くべきポイントを整理して提示してください。` }],
    model: 'default',
  });
  log.push({ role: 'pm', message: pmOpening, timestamp: now() });

  // 各メンバーに意見を求める
  for (const member of ['engineer', 'reviewer', 'deployer'] as AgentRole[]) {
    try {
      const conversationSoFar = log.map(e => `[${e.role}] ${e.message}`).join('\n');
      const { text: opinion } = await callClaude({
        system: await buildAgentPersonality(member),
        messages: [{ role: 'user', content: `チーム合議中です。\n\n${conversationSoFar}\n\nあなたは${member}です。この議題についてあなたの立場から意見を述べてください。` }],
        model: 'default',
      });
      log.push({ role: member, message: opinion, timestamp: now() });
    } catch (err) {
      logger.warn(`合議メンバー応答失敗: ${member}`, { err: err instanceof Error ? err.message : String(err) });
      log.push({ role: member, message: '（応答取得失敗）', timestamp: now() });
    }
  }

  // PMが総合判断
  const allOpinions = log.map(e => `[${e.role}] ${e.message}`).join('\n');
  const { text: decision } = await callClaude({
    system: await buildAgentPersonality('pm'),
    messages: [{ role: 'user', content: `全員の意見が出揃いました。\n\n${allOpinions}\n\n最終判断とその理由を述べてください。` }],
    model: 'default',
  });
  log.push({ role: 'pm', message: decision, timestamp: now() });

  saveTeamConversation('consensus', ['pm', 'engineer', 'reviewer', 'deployer'], log, taskId, decision);

  logger.info('合議完了', { topic, decision: decision.slice(0, 100) });
  return { decision, log };
}

/** 会話ログを保存 */
export function saveTeamConversation(
  type: string,
  participants: string[],
  log: ConversationEntry[],
  taskId?: string,
  decision?: string,
): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO team_conversations (task_id, conversation_type, participants, log, decision)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId || null, type, JSON.stringify(participants), JSON.stringify(log), decision || null);
}

/** 会話ログを取得（管理画面用） */
export function getTeamConversations(taskId?: string, limit: number = 20): any[] {
  const db = getDB();
  if (taskId) {
    return db.prepare(
      'SELECT * FROM team_conversations WHERE task_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(taskId, limit);
  }
  return db.prepare(
    'SELECT * FROM team_conversations ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

function now(): string {
  return new Date().toISOString();
}
