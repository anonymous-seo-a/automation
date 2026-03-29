import { Agent, Task, TaskResult } from '../baseAgent';
import { callClaude } from '../../claude/client';
import { sendLineMessage } from '../../line/sender';
import { logger, dbLog } from '../../utils/logger';
import {
  getActiveConversation,
  createConversation,
  getConversation,
  updateConversationStatus,
  appendHearingLog,
  setRequirements,
  setGeneratedFiles,
  cancelConversation,
  getHearingRound,
  DevConversation,
} from './conversation';
import {
  DEV_SYSTEM_PROMPT,
  PM_HEARING_PROMPT,
  PM_REQUIREMENTS_PROMPT,
  PM_DECOMPOSE_PROMPT,
  ENGINEER_PROMPT,
  REVIEWER_PROMPT,
} from './prompts';
import {
  writeFiles,
  runBuild,
  deployWithHealthCheck,
  prepareGitBranch,
  rollbackGit,
  commitAndStay,
  FileToWrite,
} from './deployer';

const MAX_BUILD_RETRIES = 5;
const MAX_HEARING_ROUNDS = 3;
const MAX_REVIEW_RETRIES = 3;

interface Subtask {
  index: number;
  path: string;
  action: 'create' | 'update';
  description: string;
}

export class DevAgent implements Agent {
  name = 'dev';

  async execute(task: Task): Promise<TaskResult> {
    return {
      success: true,
      output: '開発エージェントはLINE会話経由で動作します。LINEから「〇〇を開発して」と送信してください。',
      needsExecution: false,
    };
  }

  async handleMessage(userId: string, text: string): Promise<void> {
    try {
      if (/開発(キャンセル|中止|やめ)|やめて|やめる|キャンセル|別の話/.test(text.trim())) {
        const conv = getActiveConversation(userId);
        if (conv) {
          cancelConversation(conv.id);
          dbLog('info', 'dev-agent', `開発キャンセル: ${conv.topic}`, { convId: conv.id });
          await sendLineMessage(userId, '開発を中止しました。');
        } else {
          await sendLineMessage(userId, '進行中の開発はありません。');
        }
        return;
      }

      let conv = getActiveConversation(userId);

      if (!conv) {
        conv = createConversation(userId, text);
        dbLog('info', 'dev-agent', `新規開発会話: ${text.slice(0, 60)}`, { convId: conv.id });
        await sendLineMessage(userId, `「${text}」について、いくつか確認させてください。`);
        await this.runHearing(conv, text);
        return;
      }

      dbLog('info', 'dev-agent', `handleMessage: status=${conv.status}`, { convId: conv.id, text: text.slice(0, 60) });

      switch (conv.status) {
        case 'hearing':
          await this.handleHearing(conv, text);
          break;
        case 'defining':
          await this.handleDefining(conv, text);
          break;
        case 'approved':
        case 'implementing':
        case 'testing':
          dbLog('info', 'dev-agent', `実装中メッセージ受信（無視）: ${text.slice(0, 30)}`, { convId: conv.id });
          await sendLineMessage(userId, '現在実装中です。完了次第ご報告します。');
          break;
        default:
          dbLog('warn', 'dev-agent', `想定外ステータス: ${conv.status}`, { convId: conv.id });
          break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('DevAgent処理エラー', { err: errMsg, userId });
      dbLog('error', 'dev-agent', `処理エラー: ${errMsg.slice(0, 200)}`, { userId });
      await sendLineMessage(userId, `開発エージェントエラー:\n${errMsg.slice(0, 300)}`);
    }
  }

  // ========================================
  // Phase 1: ヒアリング（PM）
  // ========================================

  private async runHearing(conv: DevConversation, initialMessage: string): Promise<void> {
    appendHearingLog(conv.id, 'user', initialMessage);
    dbLog('info', 'dev-agent', `[PM] ヒアリング開始: round 1/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_HEARING_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${initialMessage}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\n現在のヒアリング回数: 1/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'default',
    });

    dbLog('info', 'dev-agent', `[PM] ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async handleHearing(conv: DevConversation, userReply: string): Promise<void> {
    appendHearingLog(conv.id, 'user', userReply);

    const round = getHearingRound(conv.id);
    dbLog('info', 'dev-agent', `[PM] ヒアリング回答受信: round ${round}/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    if (round >= MAX_HEARING_ROUNDS) {
      dbLog('info', 'dev-agent', '[PM] ヒアリング最大回数到達 → 要件定義へ', { convId: conv.id });
      appendHearingLog(conv.id, 'agent', 'ヒアリング最大回数到達。要件定義に進みます。');
      await this.transitionToDefining(conv);
      return;
    }

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_HEARING_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${conv.topic}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\nユーザーの最新回答: ${userReply}\n\n現在のヒアリング回数: ${round}/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'default',
    });

    dbLog('info', 'dev-agent', `[PM] ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async processHearingResponse(conv: DevConversation, text: string): Promise<void> {
    const parsed = safeParseJson(text);

    if (parsed && parsed.hearing_complete) {
      dbLog('info', 'dev-agent', '[PM] ヒアリング完了 → 要件定義へ', { convId: conv.id });
      appendHearingLog(conv.id, 'agent', parsed.summary || 'ヒアリング完了');
      await this.transitionToDefining(conv);
    } else if (parsed && parsed.questions && parsed.questions.length > 0) {
      const questions = (parsed.questions as string[]).slice(0, 3);
      const msg = questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n') + '\n\n（「やめる」で中止できます）';
      appendHearingLog(conv.id, 'agent', msg);
      await sendLineMessage(conv.user_id, msg);
    } else {
      dbLog('warn', 'dev-agent', `[PM] ヒアリング応答がJSON外: ${text.slice(0, 80)}`, { convId: conv.id });
      appendHearingLog(conv.id, 'agent', text);
      await sendLineMessage(conv.user_id, text);
    }
  }

  // ========================================
  // Phase 2: 要件定義（PM - Opus）
  // ========================================

  private async transitionToDefining(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'defining');
    dbLog('info', 'dev-agent', '[PM] 要件定義書作成開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = safeParseJson(updatedConv.hearing_log) || [];

    await sendLineMessage(conv.user_id, 'ヒアリング完了。要件定義書を作成中...');

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_REQUIREMENTS_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${conv.topic}\n\nヒアリング内容:\n${JSON.stringify(hearingLog)}` },
      ],
      model: 'opus',
    });

    setRequirements(conv.id, text);
    dbLog('info', 'dev-agent', `[PM] 要件定義書作成完了 (${text.length}文字)`, { convId: conv.id });
    await sendLineMessage(conv.user_id, text);
    await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
  }

  private async handleDefining(conv: DevConversation, userReply: string): Promise<void> {
    dbLog('info', 'dev-agent', `[PM] 要件定義フェーズ応答: ${userReply.slice(0, 40)}`, { convId: conv.id });

    if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで)$/i.test(userReply.trim())) {
      updateConversationStatus(conv.id, 'approved');
      dbLog('info', 'dev-agent', '[PM] 要件承認 → 実装開始', { convId: conv.id });
      await sendLineMessage(conv.user_id, '実装を開始します。チーム体制で進めます。\n（PM → エンジニア → レビュアー の順で各ファイルを処理）');
      await this.runImplementation(conv);
    } else {
      dbLog('info', 'dev-agent', '[PM] 要件修正指示を受信', { convId: conv.id });
      await sendLineMessage(conv.user_id, '要件を修正中...');

      const updatedConv = getConversation(conv.id);
      const requirements = updatedConv?.requirements || conv.requirements || '(要件未記録)';
      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + PM_REQUIREMENTS_PROMPT,
        messages: [
          { role: 'user', content: `元の要件:\n${requirements}\n\n修正指示: ${userReply}` },
        ],
        model: 'opus',
      });

      setRequirements(conv.id, text);
      dbLog('info', 'dev-agent', `[PM] 要件修正完了 (${text.length}文字)`, { convId: conv.id });
      await sendLineMessage(conv.user_id, text);
      await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
    }
  }

  // ========================================
  // Phase 3: 実装（チーム体制）
  // ========================================

  private async runImplementation(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'implementing');
    dbLog('info', 'dev-agent', '[チーム] 実装フェーズ開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;

    let branchName = '';

    try {
      // git安全策
      branchName = await prepareGitBranch();
      dbLog('info', 'dev-agent', `[チーム] ブランチ作成: ${branchName}`, { convId: conv.id });
      await sendLineMessage(conv.user_id, `ブランチ: ${branchName}`);

      // Step 1: PM がサブタスクに分解
      const subtasks = await this.pmDecompose(updatedConv);
      dbLog('info', 'dev-agent', `[PM] サブタスク分解完了: ${subtasks.length}件`, { convId: conv.id });
      await sendLineMessage(conv.user_id, `📋 ${subtasks.length}個のサブタスクに分解しました:\n${subtasks.map(s => `${s.index}. ${s.path}`).join('\n')}`);

      // Step 2: サブタスクごとに エンジニア→レビュアー のループ
      const allFiles: FileToWrite[] = [];
      const completedFiles: Array<{ path: string; content: string }> = [];

      for (const subtask of subtasks) {
        dbLog('info', 'dev-agent', `[エンジニア] サブタスク ${subtask.index}/${subtasks.length}: ${subtask.path}`, { convId: conv.id });

        const file = await this.engineerAndReview(conv, subtask, subtasks, completedFiles);
        allFiles.push(file);
        completedFiles.push({ path: file.path, content: file.content });

        // ファイル書き出し
        await writeFiles([file]);

        await sendLineMessage(conv.user_id, `📦 ${subtask.index}/${subtasks.length} 完了: ${subtask.path}`);
      }

      setGeneratedFiles(conv.id, allFiles.map(f => f.path));

      // Step 3: ビルド → デプロイ
      updateConversationStatus(conv.id, 'testing');
      dbLog('info', 'dev-agent', '[チーム] 全サブタスク完了 → ビルド開始', { convId: conv.id });
      await sendLineMessage(conv.user_id, `全${subtasks.length}ファイル完了。ビルド開始...`);
      await this.runBuildAndDeploy(conv, allFiles, 0, branchName);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[チーム] 実装失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });

      if (branchName) {
        await rollbackGit(branchName);
        await sendLineMessage(conv.user_id, 'コードをロールバックしました。');
      }

      updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id,
        `実装に失敗しました:\n${errMsg.slice(0, 500)}\n\n新しい依頼を送ってリトライできます。`
      );
    }
  }

  // ========================================
  // PM: サブタスク分解
  // ========================================

  private async pmDecompose(conv: DevConversation): Promise<Subtask[]> {
    dbLog('info', 'dev-agent', '[PM] サブタスク分解開始', { convId: conv.id });

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + PM_DECOMPOSE_PROMPT,
      messages: [
        { role: 'user', content: `以下の要件をサブタスクに分解してください:\n\n${conv.requirements}` },
      ],
      model: 'opus',
    });

    const parsed = safeParseJson(text);
    if (!parsed || !parsed.subtasks || !Array.isArray(parsed.subtasks)) {
      throw new Error('PM: サブタスク分解のパースに失敗');
    }

    return parsed.subtasks as Subtask[];
  }

  // ========================================
  // エンジニア + レビュアー ループ
  // ========================================

  private async engineerAndReview(
    conv: DevConversation,
    subtask: Subtask,
    allSubtasks: Subtask[],
    completedFiles: Array<{ path: string; content: string }>,
  ): Promise<FileToWrite> {

    let reviewRetry = 0;
    let lastCode: FileToWrite | null = null;
    let reviewFeedback = '';

    while (reviewRetry <= MAX_REVIEW_RETRIES) {
      // --- エンジニア ---
      const engineerContext = this.buildEngineerContext(conv, subtask, allSubtasks, completedFiles, reviewFeedback);

      dbLog('info', 'dev-agent', `[エンジニア] コード生成 (試行 ${reviewRetry + 1})`, { convId: conv.id, path: subtask.path });

      const { text: engineerOutput } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
        messages: [{ role: 'user', content: engineerContext }],
        model: 'default',
        maxTokens: 8192,
      });

      const engineerParsed = safeParseJson(engineerOutput);
      if (!engineerParsed || !engineerParsed.file || !engineerParsed.file.path || !engineerParsed.file.content) {
        throw new Error(`エンジニア: ${subtask.path} のパースに失敗`);
      }

      lastCode = {
        path: engineerParsed.file.path,
        content: engineerParsed.file.content,
        action: engineerParsed.file.action || subtask.action,
      };

      // --- レビュアー ---
      dbLog('info', 'dev-agent', `[レビュアー] レビュー開始: ${subtask.path}`, { convId: conv.id });

      const reviewContext = this.buildReviewContext(subtask, lastCode, completedFiles);

      const { text: reviewOutput } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + REVIEWER_PROMPT,
        messages: [{ role: 'user', content: reviewContext }],
        model: 'default',
      });

      const reviewParsed = safeParseJson(reviewOutput);

      if (!reviewParsed) {
        dbLog('warn', 'dev-agent', `[レビュアー] レビュー結果パース失敗。承認扱い`, { convId: conv.id });
        break;
      }

      if (reviewParsed.approved) {
        dbLog('info', 'dev-agent', `[レビュアー] 承認: ${subtask.path} - ${reviewParsed.summary}`, { convId: conv.id });
        break;
      }

      // レビューNG → フィードバックを元にリトライ
      reviewRetry++;
      const issues = (reviewParsed.issues || []) as Array<{ severity: string; message: string; fix: string }>;
      reviewFeedback = issues.map(i => `[${i.severity}] ${i.message}\n修正: ${i.fix}`).join('\n\n');

      dbLog('warn', 'dev-agent', `[レビュアー] NG (${reviewRetry}/${MAX_REVIEW_RETRIES}): ${reviewParsed.summary}`, { convId: conv.id });

      if (reviewRetry > MAX_REVIEW_RETRIES) {
        dbLog('warn', 'dev-agent', `[レビュアー] 最大リトライ到達。最終版で続行`, { convId: conv.id });
        break;
      }
    }

    if (!lastCode) {
      throw new Error(`エンジニア: ${subtask.path} のコード生成に完全に失敗`);
    }

    return lastCode;
  }

  private buildEngineerContext(
    conv: DevConversation,
    subtask: Subtask,
    allSubtasks: Subtask[],
    completedFiles: Array<{ path: string; content: string }>,
    reviewFeedback: string,
  ): string {
    let ctx = `## 要件定義\n${conv.requirements}\n\n`;
    ctx += `## 全サブタスク一覧\n${allSubtasks.map(s => `${s.index}. [${s.path}] ${s.description}`).join('\n')}\n\n`;
    ctx += `## 今回のサブタスク\nindex: ${subtask.index}\npath: ${subtask.path}\naction: ${subtask.action}\n説明: ${subtask.description}\n\n`;

    if (completedFiles.length > 0) {
      ctx += `## 完了済みファイル（参照用）\n`;
      for (const f of completedFiles) {
        ctx += `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\`\n\n`;
      }
    }

    if (reviewFeedback) {
      ctx += `## レビュアーからの修正指示（これを反映して再生成してください）\n${reviewFeedback}\n`;
    }

    return ctx;
  }

  private buildReviewContext(
    subtask: Subtask,
    file: FileToWrite,
    completedFiles: Array<{ path: string; content: string }>,
  ): string {
    let ctx = `## レビュー対象\npath: ${file.path}\naction: ${file.action}\n\n`;
    ctx += `## コード\n\`\`\`typescript\n${file.content}\n\`\`\`\n\n`;
    ctx += `## サブタスクの説明\n${subtask.description}\n\n`;

    if (completedFiles.length > 0) {
      ctx += `## 関連する完了済みファイル\n`;
      for (const f of completedFiles) {
        ctx += `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\`\n\n`;
      }
    }

    return ctx;
  }

  // ========================================
  // Phase 4: ビルド＆デプロイ
  // ========================================

  private async runBuildAndDeploy(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
  ): Promise<void> {
    dbLog('info', 'dev-agent', `[チーム] ビルド開始 (試行 ${retryCount + 1})`, { convId: conv.id });
    const buildResult = await runBuild();

    if (buildResult.success) {
      dbLog('info', 'dev-agent', '[チーム] ビルド成功 → デプロイ開始', { convId: conv.id });
      await commitAndStay(branchName, `feat(dev-agent): ${conv.topic}`);

      const deployResult = await deployWithHealthCheck(branchName);
      if (deployResult.success) {
        updateConversationStatus(conv.id, 'deployed');
        const updatedConv = getConversation(conv.id) || conv;
        const generatedFiles = JSON.parse(updatedConv.generated_files || '[]') as string[];

        dbLog('info', 'dev-agent', `[チーム] デプロイ成功: ${branchName}`, { convId: conv.id, files: generatedFiles });
        await sendLineMessage(conv.user_id,
          `開発完了!\n\n` +
          `${conv.topic}\n` +
          `ブランチ: ${branchName}\n` +
          `ファイル: ${generatedFiles.join(', ')}\n\n` +
          `ビルド・デプロイ・ヘルスチェック全て通過。`
        );
      } else {
        updateConversationStatus(conv.id, 'failed');
        dbLog('error', 'dev-agent', `[チーム] デプロイ失敗: ${deployResult.message}`, { convId: conv.id });
        await sendLineMessage(conv.user_id,
          `${deployResult.message}\n前の状態に復帰済みです。`
        );
      }
    } else if (retryCount < MAX_BUILD_RETRIES) {
      dbLog('warn', 'dev-agent', `[エンジニア] ビルドエラー → 自動修正 (${retryCount + 1}/${MAX_BUILD_RETRIES})`, {
        convId: conv.id,
        buildOutput: buildResult.buildOutput?.slice(0, 300),
      });
      await sendLineMessage(conv.user_id,
        `ビルドエラー検出。自動修正中... (${retryCount + 1}/${MAX_BUILD_RETRIES})`
      );

      try {
        const { text } = await callClaude({
          system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
          messages: [
            {
              role: 'user',
              content: `以下のコードにビルドエラーがあります。修正してください。\n\n` +
                `## ビルドエラー\n${buildResult.buildOutput}\n\n` +
                `## 現在のコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}\n\n` +
                `全ファイルをまとめて修正してください。出力形式:\n{"files": [{"path": "...", "content": "...", "action": "..."}]}`,
            },
          ],
          model: 'default',
          maxTokens: 8192,
        });

        const parsed = safeParseJson(text);
        if (parsed && parsed.files && Array.isArray(parsed.files)) {
          const files = parsed.files as FileToWrite[];
          await writeFiles(files);
          await this.runBuildAndDeploy(conv, files, retryCount + 1, branchName);
        } else if (parsed && parsed.file) {
          // 単一ファイル形式の場合
          const file = parsed.file as FileToWrite;
          await writeFiles([file]);
          const merged = lastFiles.map(f => f.path === file.path ? file : f);
          await this.runBuildAndDeploy(conv, merged, retryCount + 1, branchName);
        } else {
          throw new Error('修正コードのパースに失敗');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `[エンジニア] 自動修正失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });
        await rollbackGit(branchName);
        await sendLineMessage(conv.user_id, 'コードをロールバックしました。');
        updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `ビルドエラーの自動修正に失敗しました:\n${errMsg.slice(0, 300)}`
        );
      }
    } else {
      dbLog('error', 'dev-agent', `[チーム] ビルド修正${MAX_BUILD_RETRIES}回失敗`, { convId: conv.id });
      await rollbackGit(branchName);
      await sendLineMessage(conv.user_id, 'コードをロールバックしました。');
      updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id,
        `ビルドエラーを${MAX_BUILD_RETRIES}回修正しましたが解決できませんでした:\n${buildResult.buildOutput?.slice(0, 500)}\n\n手動での修正が必要です。`
      );
    }
  }
}

function safeParseJson(text: string): any {
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}
