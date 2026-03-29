import { callClaude } from '../claude/client';
import { saveMemoryWithEmbedding } from '../memory/store';
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
    const { text } = await callClaude({
      system: `以下の会話から、長期的に記憶すべき情報を抽出してください。

抽出すべき情報のカテゴリ:
- profile: 新しい事実情報（仕事の変化、スキル追加、人間関係の変化、住居変更等）
- project: プロジェクトの進捗や状態変化
- memo: 意思決定の記録、心身の状態報告、新しい気づき、原則の更新

出力形式（JSONのみ。説明文不要）:
抽出すべき情報がない場合は {"memories": []} を返す。
{"memories": [{"type": "profile", "key": "一意のキー（例: job_current）", "content": "記憶する内容"}]}

抽出ルール:
- 少しでもユーザーの人物像やプロジェクトに関する情報があれば積極的に抽出する
- 「こんにちは」だけ等、本当に何も情報がない場合のみ空配列を返す
- keyは日本語で短く（例: "職業", "関心事", "プロジェクト名"）
- 1つの会話から複数抽出してよい`,
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
      memories: Array<{ type: 'profile' | 'project' | 'memo'; key: string; content: string }>;
    };

    if (!result.memories || !Array.isArray(result.memories)) return;

    for (const mem of result.memories) {
      if (mem.type && mem.key && mem.content) {
        await saveMemoryWithEmbedding(userId, mem.type, mem.key, mem.content);
        logger.info('自動記憶保存', { userId, type: mem.type, key: mem.key });
      }
    }
  } catch (err) {
    logger.warn('自動記憶抽出失敗', { err: err instanceof Error ? err.message : String(err) });
  }
}
