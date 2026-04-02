import { callClaude } from '../../claude/client';
import { sendLineMessage } from '../../line/sender';
import { buildAgentPersonality } from './prompts';
import { saveAgentMemory, AgentRole } from './teamMemory';
import { getTaskMetricsSummary, pmEvaluateByMetrics } from './teamEvaluation';
import { saveTeamConversation, getTeamConversations, ConversationEntry } from './teamConversation';
import { DevConversation } from './conversation';
import { logger, dbLog } from '../../utils/logger';

export async function runRetrospective(conv: DevConversation): Promise<void> {
  dbLog('info', 'retro', `レトロスペクティブ開始: ${conv.topic}`, { convId: conv.id });

  try {
    const metrics = getTaskMetricsSummary(conv.id);
    const conversations = getTeamConversations(conv.id);

    const context = `タスク: ${conv.topic}
レビュー差し戻し: ${metrics['review_reject'] || 0}回
ビルドエラー: ${metrics['build_fail'] || 0}回
テスト失敗: ${metrics['test_fail'] || 0}回
デプロイ成功: ${metrics['deploy_success'] || 0}回
相談回数: ${conversations.filter((c: any) => c.conversation_type === 'consult').length}回
合議回数: ${conversations.filter((c: any) => c.conversation_type === 'consensus').length}回`;

    const log: ConversationEntry[] = [];

    // PMが振り返りを開始
    const { text: pmOpening } = await callClaude({
      system: await buildAgentPersonality('pm'),
      messages: [{ role: 'user', content: `開発「${conv.topic}」のレトロスペクティブを行います。\n\n${context}\n\n各メンバーに聞くべきポイントを整理してください。` }],
      model: 'default',
      timeoutMs: 120_000,
    });
    log.push({ role: 'pm', message: pmOpening, timestamp: now() });

    // 各メンバーに振り返りを求める
    for (const member of ['engineer', 'reviewer', 'deployer'] as AgentRole[]) {
      try {
        const conversationSoFar = log.map(e => `[${e.role}] ${e.message}`).join('\n');
        const { text: reflection } = await callClaude({
          system: await buildAgentPersonality(member),
          messages: [{ role: 'user', content: `チームのレトロスペクティブ中です。\n\n${conversationSoFar}\n\n今回の開発について振り返ってください。\n1. 何がうまくいったか\n2. 何を改善すべきか\n3. 次回に向けた学び` }],
          model: 'default',
          timeoutMs: 120_000,
        });
        log.push({ role: member, message: reflection, timestamp: now() });

        // 振り返りから学びを抽出して記憶に保存
        await extractLearnings(member, reflection, conv.topic);
      } catch (err) {
        logger.warn(`レトロ: ${member}の振り返り取得失敗`, { err: err instanceof Error ? err.message : String(err) });
        log.push({ role: member, message: '（振り返り取得失敗）', timestamp: now() });
      }
    }

    // PMの総括 + 自己評価 + メンバー評価
    const allReflections = log.map(e => `[${e.role}] ${e.message}`).join('\n');
    const { text: pmSummary } = await callClaude({
      system: await buildAgentPersonality('pm'),
      messages: [{ role: 'user', content: `全員の振り返りが出揃いました。\n\n${allReflections}\n\n以下を述べてください:\n1. 総括（何がうまくいって、何が問題だったか）\n2. 各メンバーの評価（良い点・改善点）\n3. PM自身の反省点\n4. 次回に向けた改善事項` }],
      model: 'default',
      timeoutMs: 120_000,
    });
    log.push({ role: 'pm', message: pmSummary, timestamp: now() });

    // PMの総括から各メンバーの評価を記録
    for (const member of ['engineer', 'reviewer', 'deployer'] as AgentRole[]) {
      await pmEvaluateByMetrics(member, conv.id, metrics).catch(err =>
        logger.warn(`レトロ: ${member}のメトリクス評価失敗`, { err: err instanceof Error ? err.message : String(err) })
      );
    }

    // PM自身の学びを保存
    await extractLearnings('pm', pmSummary, conv.topic);

    // 保存
    saveTeamConversation('retrospective', ['pm', 'engineer', 'reviewer', 'deployer'], log, conv.id, pmSummary);

    // エピソード→意味記憶の自動昇格チェック
    try {
      const { promoteRecurringLearnings } = await import('./teamMemory');
      let totalPromoted = 0;
      for (const role of ['pm', 'engineer', 'reviewer', 'deployer'] as const) {
        const count = await promoteRecurringLearnings(role);
        totalPromoted += count;
      }
      if (totalPromoted > 0) {
        dbLog('info', 'retro', `記憶昇格: ${totalPromoted}件のパターンルールを自動生成`, { convId: conv.id });
      }
    } catch (err) {
      dbLog('warn', 'retro', `記憶昇格チェック失敗: ${err instanceof Error ? err.message : String(err)}`, { convId: conv.id });
    }

    // Daikiにサマリーを送信
    const summaryLines = pmSummary.split('\n').slice(0, 10).join('\n');
    await sendLineMessage(conv.user_id,
      `📝 レトロスペクティブ完了\n\n${summaryLines}\n\n詳細は「会話ログ」で確認できます。`
    );

    dbLog('info', 'retro', 'レトロスペクティブ完了', { convId: conv.id });
  } catch (err) {
    dbLog('error', 'retro', `レトロスペクティブ失敗: ${err instanceof Error ? err.message : String(err)}`, { convId: conv.id });
    throw err; // 呼び出し元の .catch() で処理
  }
}

async function extractLearnings(agent: AgentRole, reflection: string, topic: string): Promise<void> {
  try {
    const { text } = await callClaude({
      system: '以下の振り返りテキストから、具体的な学び（learning）を1〜3個抽出してJSON配列で返してください。\n[{"key":"学びの短いキー","content":"具体的な学びの内容"}]\n学びがなければ空配列。',
      messages: [{ role: 'user', content: reflection }],
      model: 'default',
      maxTokens: 300,
    });

    let parsed: any;
    try {
      const m = text.match(/\[[\s\S]*\]/);
      parsed = m ? JSON.parse(m[0]) : [];
    } catch { parsed = []; }

    for (const item of parsed) {
      if (item.key && item.content) {
        saveAgentMemory(agent, 'learning',
          `retro_${topic.slice(0, 20)}_${item.key}`, item.content, 'retrospective');
      }
    }
  } catch (err) {
    logger.warn('レトロ学習抽出失敗', { agent, err: err instanceof Error ? err.message : String(err) });
  }
}

function now(): string {
  return new Date().toISOString();
}
