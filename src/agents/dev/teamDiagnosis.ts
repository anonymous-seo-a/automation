/**
 * チーム診断セッション
 *
 * 開発中にリトライ上限に達した場合や深刻なエラー時に、
 * PM・エンジニア・デプロイヤーの3視点でエラーを分析し、
 * 次のアクションを決定する。
 *
 * - 一時的/環境エラーはAPI呼び出しなしで即判定（コスト節約）
 * - コード/不明エラーの場合のみClaude APIで深層診断
 */

import { callClaude } from '../../claude/client';
import { DEV_SYSTEM_PROMPT } from './prompts';
import { logger, dbLog } from '../../utils/logger';
import { ClassifiedError } from './errorClassifier';
import { TestResult, formatTestResults } from './tester';

export type DiagnosisRecommendation =
  | 'retry_with_fix'
  | 'retry_after_wait'
  | 'rollback'
  | 'escalate_to_user';

export interface DiagnosisResult {
  rootCause: string;
  category: string;
  recommendation: DiagnosisRecommendation;
  actionPlan: string;
  waitMs?: number;
  fixInstructions?: string;
  /** チーム各員の分析（ログ/報告用） */
  teamAnalysis?: {
    pm: string;
    engineer: string;
    deployer: string;
  };
}

export interface DiagnosisContext {
  convId: string;
  phase: string;
  error: string;
  classifiedError: ClassifiedError;
  buildOutput?: string;
  testResults?: TestResult[];
  filesChanged: string[];
  retryCount: number;
  maxRetries: number;
}

const DIAGNOSIS_PROMPT = `あなたは自律開発チームの障害診断会議を行います。
PM・エンジニア・デプロイヤーの3つの役割の視点でエラーを分析し、合意した診断結果をJSON形式で出力してください。

## 各メンバーの観点
- PM: 要件やスコープに問題がないか。計画の修正が必要か。
- エンジニア: コードの技術的問題と具体的な修正方法。
- デプロイヤー: インフラ・環境・設定に問題がないか。

## 出力形式（JSONのみ出力。説明文不要）
{
  "pm_analysis": "PMの分析（1-2文）",
  "engineer_analysis": "エンジニアの分析（1-2文）",
  "deployer_analysis": "デプロイヤーの分析（1-2文）",
  "root_cause": "合意した根本原因",
  "category": "code | environment | transient",
  "recommendation": "retry_with_fix | retry_after_wait | rollback | escalate_to_user",
  "action_plan": "具体的な対処手順（ユーザーに報告する内容）",
  "fix_instructions": "エンジニアへのコード修正指示（recommendationがretry_with_fixの場合のみ）"
}

## 判断基準
- retry_with_fix: 修正方法が明確で、もう1回試せば通る見込みがある場合
- retry_after_wait: 一時的なエラー（レートリミット、タイムアウト等）で待てば解決する場合
- rollback: コードが根本的に問題があり、現在のアプローチでは解決困難な場合
- escalate_to_user: 自動解決不可能で、人間の判断・情報が必要な場合`;

/**
 * チーム診断を実行する。
 * 一時的/環境エラーはAPI呼び出しなしで即判定。コード/不明エラーはClaudeで深層分析。
 */
export async function runTeamDiagnosis(ctx: DiagnosisContext): Promise<DiagnosisResult> {
  dbLog('info', 'dev-agent', `[チーム診断] 開始: phase=${ctx.phase}, type=${ctx.classifiedError.category}/${ctx.classifiedError.subcategory}, retry=${ctx.retryCount}/${ctx.maxRetries}`, { convId: ctx.convId });

  // ── 即判定: 一時的エラー ──
  if (ctx.classifiedError.category === 'transient') {
    const waitMs = ctx.classifiedError.waitMs || 60_000;
    const result: DiagnosisResult = {
      rootCause: `一時的なエラー: ${ctx.classifiedError.subcategory}`,
      category: 'transient',
      recommendation: 'retry_after_wait',
      actionPlan: `${ctx.classifiedError.suggestedAction}。${waitMs / 1000}秒後にリトライします。`,
      waitMs,
    };
    dbLog('info', 'dev-agent', `[チーム診断] 即判定: ${result.recommendation}`, { convId: ctx.convId });
    return result;
  }

  // ── 即判定: 自動修正可能な環境エラー ──
  if (ctx.classifiedError.category === 'environment' && ctx.classifiedError.autoFixable) {
    const result: DiagnosisResult = {
      rootCause: `環境問題: ${ctx.classifiedError.subcategory}`,
      category: 'environment',
      recommendation: 'retry_with_fix',
      actionPlan: `${ctx.classifiedError.suggestedAction}。自動修正後にリトライします。`,
      fixInstructions: ctx.classifiedError.suggestedAction,
    };
    dbLog('info', 'dev-agent', `[チーム診断] 即判定(環境): ${result.recommendation}`, { convId: ctx.convId });
    return result;
  }

  // ── 即判定: 自動修正不可の環境エラー ──
  if (ctx.classifiedError.category === 'environment' && !ctx.classifiedError.autoFixable) {
    const result: DiagnosisResult = {
      rootCause: `環境問題（自動修正不可）: ${ctx.classifiedError.subcategory}`,
      category: 'environment',
      recommendation: 'escalate_to_user',
      actionPlan: `${ctx.classifiedError.suggestedAction}。手動での対応が必要です。`,
    };
    dbLog('info', 'dev-agent', `[チーム診断] 即判定(環境/手動): escalate_to_user`, { convId: ctx.convId });
    return result;
  }

  // ── Claude APIによる深層診断: コード/不明エラー ──
  try {
    const prompt = buildDiagnosisPrompt(ctx);
    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + DIAGNOSIS_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      model: 'default', // Sonnet（コスト節約）
    });

    const parsed = safeParseJson(text);
    if (parsed && parsed.recommendation) {
      const result: DiagnosisResult = {
        rootCause: parsed.root_cause || ctx.classifiedError.message,
        category: parsed.category || ctx.classifiedError.category,
        recommendation: validateRecommendation(parsed.recommendation),
        actionPlan: parsed.action_plan || '',
        fixInstructions: parsed.fix_instructions,
        teamAnalysis: {
          pm: parsed.pm_analysis || '',
          engineer: parsed.engineer_analysis || '',
          deployer: parsed.deployer_analysis || '',
        },
      };
      dbLog('info', 'dev-agent', `[チーム診断] API結果: ${result.recommendation} - ${result.rootCause.slice(0, 100)}`, { convId: ctx.convId });
      return result;
    }

    dbLog('warn', 'dev-agent', `[チーム診断] APIレスポンスのパース失敗`, { convId: ctx.convId });
  } catch (err) {
    // 診断のためのAPI呼び出しも失敗した場合（レートリミット等）
    const errMsg = err instanceof Error ? err.message : String(err);
    dbLog('warn', 'dev-agent', `[チーム診断] API呼び出し失敗: ${errMsg.slice(0, 200)}`, { convId: ctx.convId });

    // API自体がレートリミットなら待機を推奨
    if (/429|rate_limit/i.test(errMsg)) {
      return {
        rootCause: 'APIレートリミットにより診断も実行不可',
        category: 'transient',
        recommendation: 'retry_after_wait',
        actionPlan: '60秒待機後にリトライします。',
        waitMs: 60_000,
      };
    }
  }

  // ── フォールバック ──
  // リトライ上限に達している場合はユーザーにエスカレーション
  if (ctx.retryCount >= ctx.maxRetries) {
    return {
      rootCause: ctx.classifiedError.message,
      category: ctx.classifiedError.category,
      recommendation: 'escalate_to_user',
      actionPlan: `${ctx.maxRetries}回のリトライで解決できませんでした。エラー内容を確認してください。`,
    };
  }

  return {
    rootCause: ctx.classifiedError.message,
    category: ctx.classifiedError.category,
    recommendation: 'retry_with_fix',
    actionPlan: 'チーム診断を完了できませんでしたが、修正を再試行します。',
  };
}

function buildDiagnosisPrompt(ctx: DiagnosisContext): string {
  let prompt = `## 障害情報\n`;
  prompt += `- フェーズ: ${ctx.phase}\n`;
  prompt += `- リトライ回数: ${ctx.retryCount}/${ctx.maxRetries}\n`;
  prompt += `- エラー分類: ${ctx.classifiedError.category} / ${ctx.classifiedError.subcategory}\n`;
  prompt += `- エラーメッセージ:\n${ctx.error.slice(0, 1000)}\n\n`;

  if (ctx.buildOutput) {
    prompt += `## ビルド出力\n${ctx.buildOutput.slice(0, 2000)}\n\n`;
  }

  if (ctx.testResults) {
    prompt += `## テスト結果\n${formatTestResults(ctx.testResults)}\n\n`;
  }

  if (ctx.filesChanged.length > 0) {
    prompt += `## 変更ファイル\n${ctx.filesChanged.join('\n')}\n\n`;
  }

  prompt += `上記の情報を分析して、チーム診断結果をJSON形式で出力してください。`;
  return prompt;
}

function validateRecommendation(raw: string): DiagnosisRecommendation {
  const valid: DiagnosisRecommendation[] = ['retry_with_fix', 'retry_after_wait', 'rollback', 'escalate_to_user'];
  return valid.includes(raw as DiagnosisRecommendation) ? raw as DiagnosisRecommendation : 'escalate_to_user';
}

function safeParseJson(text: string): any {
  let jsonStr = text.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
  try { return JSON.parse(jsonStr); } catch { /* continue */ }
  const objMatch = jsonStr.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try { return JSON.parse(objMatch[1]); } catch { /* continue */ }
  }
  return null;
}
