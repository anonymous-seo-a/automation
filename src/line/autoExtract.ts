import { callClaude } from '../claude/client';
import { saveMemoryWithEmbedding } from '../memory/store';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';

/**
 * 会話から長期記憶すべき情報を自動抽出して保存する。
 * webhook.ts から await せずにバックグラウンドで呼ぶ。
 */
export async function extractAndSaveMemories(
  userId: string,
  userMessage: string,
  aiResponse: string,
): Promise<void> {
  try {
    // 既存記憶のキー一覧を取得（重複防止用）
    const existingKeys = await getDB().prepare(
      "SELECT type, key FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50"
    ).all(userId) as Array<{ type: string; key: string }>;

    const existingKeysText = existingKeys.length > 0
      ? `\n\n既に記憶済みの情報（重複するものは抽出しないこと）:\n${existingKeys.map(k => `- [${k.type}] ${k.key}`).join('\n')}`
      : '';

    const { text } = await callClaude({
      system: `以下の会話から、長期的に記憶すべき新しい情報を抽出してください。

抽出すべき情報のカテゴリ:
- profile: 新しい事実情報（仕事の変化、スキル追加、人間関係の変化、住居変更等） → importance: 4
- project: プロジェクトの進捗や状態変化 → importance: 3
- memo: 意思決定の記録、新しい気づき、原則の更新 → importance: 2〜3

出力形式（JSONのみ。説明文不要）:
抽出すべき情報がない場合は {"memories": []} を返す。
{"memories": [{"type": "profile", "key": "一意のキー", "content": "記憶する内容", "importance": 4}]}

抽出ルール:
- 既存記憶と重複する情報は抽出しない
- 既存記憶の内容が変化した場合は同じkeyで新しい内容を抽出する
- 一度言っただけの些細な情報は抽出しない（繰り返し言及されるものだけ）
- keyは日本語で短く意味のある名前（例: "職業", "soico_進捗", "健康状態"）
- タイムスタンプをkeyに含めない
- 「こんにちは」だけ等、本当に何も情報がない場合のみ空配列を返す${existingKeysText}`,
      messages: [
        { role: 'user', content: `ユーザー: ${userMessage}\nAI応答: ${aiResponse}` },
      ],
      model: 'default',
      maxTokens: 500,
    });

    // JSONパース（マークダウンコードブロック対応）
    let jsonStr = text.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    const result = JSON.parse(jsonStr) as {
      memories: Array<{ type: 'profile' | 'project' | 'memo'; key: string; content: string; importance?: number }>;
    };

    if (!result.memories || !Array.isArray(result.memories)) return;

    for (const mem of result.memories) {
      if (mem.type && mem.key && mem.content) {
        await saveMemoryWithEmbedding(userId, mem.type, mem.key, mem.content, mem.importance);
        logger.info('自動記憶保存', { userId, type: mem.type, key: mem.key, importance: mem.importance });
      }
    }
  } catch (err) {
    logger.warn('自動記憶抽出失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}
