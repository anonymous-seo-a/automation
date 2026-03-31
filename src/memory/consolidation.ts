import { callClaude } from '../claude/client';
import { getAllMemories, saveMemoryWithEmbedding, MemoryType } from './store';
import { getDB } from '../db/database';
import { logger, dbLog } from '../utils/logger';

/**
 * 日次記憶統合: Claudeが全記憶を読み、矛盾解消・統合プロフィールを再構築する。
 * 毎日深夜に1回実行する想定。
 */
export async function consolidateMemories(userId: string): Promise<void> {
  const allMemories = getAllMemories(userId);
  if (allMemories.length < 3) {
    logger.info('記憶が少なすぎるため統合スキップ', { userId, count: allMemories.length });
    return;
  }

  // 統合対象: profile, project, memo, session_summary（consolidatedは除外して再構築）
  const targetMemories = allMemories.filter(m => m.type !== 'consolidated');
  if (targetMemories.length === 0) return;

  const memoryText = targetMemories
    .map(m => `[${m.type}] ${m.key}: ${m.content} (更新: ${m.updated_at})`)
    .join('\n');

  try {
    const { text } = await callClaude({
      system: `あなたはユーザー情報の統合アナリストです。
以下のルールに従って記憶を統合プロフィールにまとめてください。

## ルール
1. 矛盾する情報は新しい方を採用
2. 重複する情報は統合
3. 古い会話要約から重要な事実だけ抽出
4. 出力はJSON形式のみ

## 出力形式
{
  "profile_summary": "ユーザーの人物像（200文字以内）",
  "key_facts": ["事実1", "事実2", ...],
  "preferences": ["好み1", "好み2", ...],
  "active_projects": ["プロジェクト1", ...],
  "cleanup": [{"type": "タイプ", "key": "キー", "reason": "削除理由"}]
}

- profile_summary: ユーザーの人物像を自然な文章で
- key_facts: 確実に正しい重要事実（名前、職業、スキル等）
- preferences: 好み・性格・スタイル
- active_projects: 進行中のプロジェクト
- cleanup: 古すぎる・重複する・矛盾する記憶で削除推奨のもの`,
      messages: [
        { role: 'user', content: `以下の記憶を統合してください（${targetMemories.length}件）:\n\n${memoryText}` },
      ],
      model: 'default',
      maxTokens: 2000,
    });

    // JSONパース
    let jsonStr = text.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    const result = JSON.parse(jsonStr) as {
      profile_summary: string;
      key_facts: string[];
      preferences: string[];
      active_projects: string[];
      cleanup: Array<{ type: string; key: string; reason: string }>;
    };

    // 統合プロフィールを保存
    const consolidatedContent = [
      result.profile_summary,
      '',
      '【重要事実】',
      ...result.key_facts.map(f => `- ${f}`),
      '',
      '【好み・性格】',
      ...result.preferences.map(p => `- ${p}`),
      '',
      '【進行中プロジェクト】',
      ...result.active_projects.map(p => `- ${p}`),
    ].join('\n');

    await saveMemoryWithEmbedding(userId, 'consolidated', 'user_profile', consolidatedContent);

    // クリーンアップ推奨の記憶を削除
    if (result.cleanup && result.cleanup.length > 0) {
      const db = getDB();
      let cleaned = 0;
      for (const item of result.cleanup) {
        const r = db.prepare(
          'DELETE FROM memories WHERE user_id = ? AND type = ? AND key = ?'
        ).run(userId, item.type, item.key);
        if (r.changes > 0) cleaned++;
      }
      logger.info('記憶クリーンアップ', { userId, recommended: result.cleanup.length, deleted: cleaned });
    }

    logger.info('記憶統合完了', { userId, memoryCount: targetMemories.length });
    dbLog('info', 'consolidation', `記憶統合完了: ${targetMemories.length}件 → 統合プロフィール更新`, { userId });
  } catch (err) {
    logger.error('記憶統合失敗', { userId, err: err instanceof Error ? err.message : String(err) });
    dbLog('error', 'consolidation', `記憶統合失敗: ${err instanceof Error ? err.message : String(err)}`, { userId });
  }
}

/**
 * 全ユーザーの記憶を統合（日次バッチ）
 */
export async function runDailyConsolidation(): Promise<void> {
  const db = getDB();
  const users = db.prepare(
    'SELECT DISTINCT user_id FROM memories'
  ).all() as Array<{ user_id: string }>;

  logger.info('日次記憶統合開始', { userCount: users.length });

  for (const { user_id } of users) {
    try {
      await consolidateMemories(user_id);
    } catch (err) {
      logger.error('ユーザー記憶統合失敗', { userId: user_id, err: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info('日次記憶統合完了');
}
