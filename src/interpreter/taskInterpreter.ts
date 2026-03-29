import { callClaude } from '../claude/client';
import { v4 as uuidv4 } from 'uuid';

export interface ParsedTask {
  id: string;
  description: string;
  agent: string;
  priority: number;
  depends_on: string[];
  requires_opus: boolean;
  input_data?: Record<string, unknown>;
}

interface InterpretResult {
  tasks: ParsedTask[];
  confirmation_needed: boolean;
  clarification_question?: string;
  estimated_api_calls: number;
}

const SYSTEM_PROMPT = `あなたはタスク解釈エンジンです。
ユーザーからの自然言語の指示を、実行可能なタスクリストに変換します。

## 利用可能なエージェント
- soico: SEOサイト（soico.jp/no1/）の最適化・分析・コンテンツ生成

## 出力形式
必ず以下のJSON形式のみを出力してください。Markdownのコードブロックや説明文は一切不要です。
JSONのみを出力してください。

{
  "tasks": [
    {
      "description": "タスクの具体的な説明",
      "agent": "soico",
      "priority": 1-10の整数（10が最高）,
      "depends_on": [],
      "requires_opus": false
    }
  ],
  "confirmation_needed": false,
  "clarification_question": null,
  "estimated_api_calls": 数値
}

## ルール
- 曖昧な指示の場合は confirmation_needed: true にして clarification_question に質問を入れる
- 1つの指示を複数のタスクに分解する場合、依存関係を depends_on で示す
- SEO戦略判断やデータ分析は requires_opus: true にする
- コード生成や定型処理は requires_opus: false にする`;

export async function interpretTask(userMessage: string): Promise<InterpretResult> {
  const { text } = await callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    model: 'default',
  });

  // JSONの抽出（コードブロックで囲まれている場合にも対応）
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // JSONパース失敗時はフォールバック
    return {
      tasks: [{
        id: uuidv4(),
        description: userMessage,
        agent: 'soico',
        priority: 5,
        depends_on: [],
        requires_opus: false,
      }],
      confirmation_needed: false,
      estimated_api_calls: 1,
    };
  }

  return {
    tasks: (parsed.tasks || []).map((t: any) => ({
      id: uuidv4(),
      description: t.description,
      agent: t.agent || 'soico',
      priority: t.priority || 5,
      depends_on: t.depends_on || [],
      requires_opus: t.requires_opus || false,
      input_data: t.input_data,
    })),
    confirmation_needed: parsed.confirmation_needed || false,
    clarification_question: parsed.clarification_question,
    estimated_api_calls: parsed.estimated_api_calls || 1,
  };
}
