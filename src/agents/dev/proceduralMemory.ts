/**
 * Phase 1: 手続き記憶（Procedural Memory）
 *
 * 成功した開発フローを手順として蒸留・再利用する。
 * Mem^p / Voyager式スキルライブラリに基づく。
 *
 * - extractProcedure: デプロイ成功時に会話から手順を抽出
 * - findRelevantProcedures: タスク説明に類似する手続きをpgvector検索
 * - updateProcedureOutcome: 成功/失敗に応じてconfidenceを更新
 */
import { getDB, getRawPool } from '../../db/database';
import { callClaude } from '../../claude/client';
import { embed, embedQuery } from '../../memory/embedding';
import { embeddingToSql } from '../../memory/embedding';
import { DevConversation } from './conversation';
import { logger } from '../../utils/logger';

interface ProcedureRow {
  id: number;
  trigger_pattern: string;
  steps: string; // JSONB → string
  source_conv_id: string | null;
  success_count: number;
  failure_count: number;
  confidence: number;
  embedding: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * デプロイ成功時に会話から手続き記憶を抽出・保存する。
 * 要件定義 + 実装結果から「どんな状況で何をすれば成功するか」を蒸留。
 */
export async function extractProcedure(conv: DevConversation): Promise<void> {
  if (!conv.requirements) return;

  let generatedFiles: string[] = [];
  try {
    generatedFiles = JSON.parse(conv.generated_files || '[]');
  } catch { /* ignore */ }

  const filesInfo = generatedFiles.length > 0
    ? `生成ファイル: ${generatedFiles.join(', ')}`
    : '';

  try {
    const { text } = await callClaude({
      system: `あなたは開発プロセスの手続き記憶を抽出するアナリストです。
以下の開発成功事例から、再利用可能な手順テンプレートを抽出してください。

出力形式（JSONのみ）:
{
  "trigger_pattern": "この手順が適用される状況の説明（50文字以内）",
  "steps": [
    {"order": 1, "action": "具体的なアクション", "detail": "詳細説明"},
    {"order": 2, "action": "...", "detail": "..."}
  ]
}

ルール:
- 手順は3〜8ステップ程度
- プロジェクト固有の値（ファイル名等）は汎用的な表現に置き換える
- 「〜を確認する」「〜を作成する」等のアクション形式で記述
- 抽出すべき手順がない場合（単純すぎる場合）は {"skip": true} を返す`,
      messages: [{
        role: 'user',
        content: `トピック: ${conv.topic}\n\n要件:\n${conv.requirements}\n\n${filesInfo}`,
      }],
      model: 'default',
      maxTokens: 800,
    });

    const parsed = safeParseJson(text);
    if (!parsed || parsed.skip) return;
    if (!parsed.trigger_pattern || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return;

    // embeddingを生成（trigger_pattern + steps概要）
    const embText = `${parsed.trigger_pattern} ${parsed.steps.map((s: any) => s.action).join(' ')}`;
    let embSql: string | null = null;
    try {
      const vec = await embed(embText);
      embSql = embeddingToSql(vec);
    } catch {
      // embedding失敗時はテキストのみ保存
    }

    const db = getDB();
    await db.prepare(`
      INSERT INTO procedural_memories (trigger_pattern, steps, source_conv_id, embedding)
      VALUES (?, ?::jsonb, ?, ?)
    `).run(
      parsed.trigger_pattern,
      JSON.stringify(parsed.steps),
      conv.id,
      embSql,
    );

    logger.info('手続き記憶抽出', {
      trigger: parsed.trigger_pattern,
      stepCount: parsed.steps.length,
      convId: conv.id,
    });
  } catch (err) {
    logger.warn('手続き記憶抽出失敗', {
      convId: conv.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * タスク説明に類似する手続き記憶を検索し、プロンプト注入用テキストを返す。
 * pgvectorのコサイン距離で上位5件を取得し、confidence順でソート。
 */
export async function findRelevantProcedures(taskDescription: string): Promise<string> {
  try {
    const queryVec = await embedQuery(taskDescription);
    const queryVecSql = embeddingToSql(queryVec);

    const pool = getRawPool();
    const result = await pool.query(`
      SELECT id, trigger_pattern, steps, success_count, failure_count, confidence
      FROM procedural_memories
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1
      LIMIT 5
    `, [queryVecSql]);

    const rows = result.rows as ProcedureRow[];
    if (rows.length === 0) return '';

    // confidence 0.3以上のみ採用
    const relevant = rows.filter(r => r.confidence >= 0.3);
    if (relevant.length === 0) return '';

    const sections = relevant.map(r => {
      let steps: Array<{ order: number; action: string; detail?: string }>;
      try {
        steps = typeof r.steps === 'string' ? JSON.parse(r.steps) : r.steps;
      } catch {
        return '';
      }
      const stepsText = steps
        .map(s => `  ${s.order}. ${s.action}${s.detail ? ` — ${s.detail}` : ''}`)
        .join('\n');
      const reliability = r.confidence >= 0.8 ? '★高信頼' : r.confidence >= 0.5 ? '☆中信頼' : '△低信頼';
      return `### ${r.trigger_pattern} (${reliability}, 成功${r.success_count}回/失敗${r.failure_count}回)\n${stepsText}`;
    }).filter(Boolean);

    if (sections.length === 0) return '';

    return `## 過去の成功手順（参考にして実装すること）\n${sections.join('\n\n')}`;
  } catch (err) {
    logger.debug('手続き記憶検索失敗', {
      err: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/**
 * デプロイ結果に応じて手続き記憶のconfidenceを更新する。
 */
export async function updateProcedureOutcome(
  convId: string,
  success: boolean,
): Promise<void> {
  try {
    const db = getDB();
    const column = success ? 'success_count' : 'failure_count';
    await db.prepare(`
      UPDATE procedural_memories
      SET ${column} = ${column} + 1, updated_at = NOW()
      WHERE source_conv_id = ?
    `).run(convId);
  } catch (err) {
    logger.debug('手続き記憶outcome更新失敗', {
      convId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function safeParseJson(text: string): any {
  let s = text.trim();
  const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (m) s = m[1].trim();
  const o = s.match(/\{[\s\S]*\}/);
  if (o) s = o[0];
  try { return JSON.parse(s); } catch { return null; }
}
