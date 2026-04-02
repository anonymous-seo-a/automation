/**
 * 分身の感情状態モデリング（Chain-of-Emotion + D-MEM方式）
 * ユーザーメッセージの感情を推定し、応答トーンを調整する
 */
import { callClaude } from '../claude/client';
import { getDB } from '../db/database';
import { logger } from '../utils/logger';

export interface EmotionalState {
  valence: number;          // -1.0(ネガティブ) 〜 +1.0(ポジティブ)
  arousal: number;          // 0(落ち着き) 〜 1.0(興奮)
  dominantEmotion: string;  // 'neutral','tired','excited','frustrated','reflective','anxious','grateful','curious'
}

/** ユーザーメッセージの感情を推定（Sonnet、軽量呼び出し） */
export async function estimateEmotion(message: string): Promise<EmotionalState> {
  try {
    const { text } = await callClaude({
      system: 'ユーザーメッセージの感情状態をJSON形式で推定してください。JSONのみ出力。\n{"valence": -1.0〜1.0, "arousal": 0〜1.0, "dominantEmotion": "neutral|tired|excited|frustrated|reflective|anxious|grateful|curious"}',
      messages: [{ role: 'user', content: message }],
      model: 'default',
      maxTokens: 100,
    });
    const cleaned = text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      valence: Math.max(-1, Math.min(1, parsed.valence || 0)),
      arousal: Math.max(0, Math.min(1, parsed.arousal || 0.5)),
      dominantEmotion: parsed.dominantEmotion || 'neutral',
    };
  } catch {
    return { valence: 0, arousal: 0.5, dominantEmotion: 'neutral' };
  }
}

/** 感情状態をDBに保存 */
export async function saveEmotionalState(userId: string, state: EmotionalState, triggerMessage: string): Promise<void> {
  try {
    const db = getDB();
    // emotional_statesテーブルがなければスキップ（PostgreSQL移行前はテーブルが存在しない）
    await db.prepare(
      'INSERT INTO emotional_states (user_id, valence, arousal, dominant_emotion, trigger_message) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, state.valence, state.arousal, state.dominantEmotion, triggerMessage.slice(0, 200));
  } catch {
    // テーブル未作成時は静かに失敗
  }
}

/** 直近の感情状態を取得 */
export async function getLatestEmotionalState(userId: string): Promise<EmotionalState | null> {
  try {
    const db = getDB();
    const row = await db.prepare(
      'SELECT valence, arousal, dominant_emotion FROM emotional_states WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(userId) as { valence: number; arousal: number; dominant_emotion: string } | undefined;
    if (!row) return null;
    return { valence: row.valence, arousal: row.arousal, dominantEmotion: row.dominant_emotion };
  } catch {
    return null;
  }
}

/** 感情状態に応じた応答トーン調整指示を生成 */
export function getEmotionalGuidance(state: EmotionalState): string {
  if (state.dominantEmotion === 'tired' || state.valence < -0.5) {
    return '\n【応答トーン】短く共感的に。励ましは不要。具体的な提案のみ。';
  }
  if (state.dominantEmotion === 'frustrated') {
    return '\n【応答トーン】問題の構造を整理して提示。感情に触れず、解決策に集中。';
  }
  if (state.dominantEmotion === 'excited' && state.arousal > 0.7) {
    return '\n【応答トーン】アイデアを一緒に展開。ただし実現可能性のフィルタをかける。';
  }
  if (state.dominantEmotion === 'reflective') {
    return '\n【応答トーン】内省を深める質問を投げかける。答えを急がない。';
  }
  if (state.dominantEmotion === 'anxious') {
    return '\n【応答トーン】安心材料を提示。不確実性を具体的な選択肢に分解する。';
  }
  return '';
}

/** D-MEM式: 感情の急変を検出し、重要イベントとして記録 */
export function detectEmotionalSurprise(
  current: EmotionalState,
  previous: EmotionalState | null,
): boolean {
  if (!previous) return false;
  const surprise = Math.abs(current.valence - previous.valence);
  return surprise > 0.6;
}
