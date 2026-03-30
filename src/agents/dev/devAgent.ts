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
  readProjectFile,
  FileToWrite,
} from './deployer';

const MAX_BUILD_RETRIES = 5;
const MAX_HEARING_ROUNDS = 3;
const MAX_REVIEW_RETRIES = 3;
const MAX_ENGINEER_PARSE_RETRIES = 3;

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
        case 'stuck':
          await this.handleStuck(conv, text);
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

  private async runImplementation(conv: DevConversation, resumeFrom?: { branchName: string; subtasks: Subtask[]; completedFiles: Array<{ path: string; content: string }>; startIndex: number }): Promise<void> {
    updateConversationStatus(conv.id, 'implementing');
    dbLog('info', 'dev-agent', '[チーム] 実装フェーズ開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;

    let branchName = resumeFrom?.branchName || '';
    let subtasks: Subtask[] = resumeFrom?.subtasks || [];
    const allFiles: FileToWrite[] = [];
    const completedFiles: Array<{ path: string; content: string }> = resumeFrom?.completedFiles || [];
    let startIndex = resumeFrom?.startIndex || 0;

    try {
      // 新規開始の場合
      if (!resumeFrom) {
        branchName = await prepareGitBranch();
        dbLog('info', 'dev-agent', `[チーム] ブランチ作成: ${branchName}`, { convId: conv.id });
        await sendLineMessage(conv.user_id, `ブランチ: ${branchName}`);

        subtasks = await this.pmDecompose(updatedConv);
        dbLog('info', 'dev-agent', `[PM] サブタスク分解完了: ${subtasks.length}件`, { convId: conv.id });
        await sendLineMessage(conv.user_id, `📋 ${subtasks.length}個のサブタスクに分解しました:\n${subtasks.map(s => `${s.index}. ${s.path}`).join('\n')}`);
      } else {
        await sendLineMessage(conv.user_id, `サブタスク ${startIndex + 1} から再開します...`);
      }

      // サブタスクごとに エンジニア→レビュアー のループ
      for (let i = startIndex; i < subtasks.length; i++) {
        const subtask = subtasks[i];
        dbLog('info', 'dev-agent', `[エンジニア] サブタスク ${subtask.index}/${subtasks.length}: ${subtask.path}`, { convId: conv.id });

        try {
          const file = await this.engineerAndReview(conv, subtask, subtasks, completedFiles);
          allFiles.push(file);
          completedFiles.push({ path: file.path, content: file.content });

          await writeFiles([file]);

          // サブタスクごとにcommitして成果を保護
          await commitAndStay(branchName, `feat: ${subtask.path} - ${subtask.description.slice(0, 50)}`);

          await sendLineMessage(conv.user_id, `📦 ${subtask.index}/${subtasks.length} 完了: ${subtask.path}`);
        } catch (subtaskErr) {
          const errMsg = subtaskErr instanceof Error ? subtaskErr.message : String(subtaskErr);
          dbLog('error', 'dev-agent', `[チーム] サブタスク失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id, subtaskIndex: subtask.index });

          // stuckモードに移行（ロールバックしない）
          this.stuckContext = {
            branchName,
            subtasks,
            completedFiles: [...completedFiles],
            failedSubtaskIndex: i,
            errorMessage: errMsg,
          };
          updateConversationStatus(conv.id, 'stuck');
          await sendLineMessage(conv.user_id,
            `⚠️ サブタスク ${subtask.index}/${subtasks.length} (${subtask.path}) で問題が発生しました:\n` +
            `${errMsg.slice(0, 300)}\n\n` +
            `完了済み: ${completedFiles.length}/${subtasks.length} ファイル（コミット済み）\n\n` +
            `選択肢:\n` +
            `・「リトライ」→ このサブタスクを再試行\n` +
            `・「スキップ」→ このサブタスクを飛ばして次へ\n` +
            `・指示を送る → 追加情報を元に再試行\n` +
            `・「中止」→ 開発を中止（完了分はブランチに残ります）`
          );
          return; // stuckで一旦停止
        }
      }

      setGeneratedFiles(conv.id, [...completedFiles.map(f => f.path), ...allFiles.map(f => f.path)]);

      // ビルド → デプロイ
      updateConversationStatus(conv.id, 'testing');
      dbLog('info', 'dev-agent', '[チーム] 全サブタスク完了 → ビルド開始', { convId: conv.id });
      await sendLineMessage(conv.user_id, `全${subtasks.length}ファイル完了。ビルド開始...`);
      await this.runBuildAndDeploy(conv, allFiles, 0, branchName);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `[チーム] 実装失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });

      // 完了済みサブタスクがある場合はブランチを残す
      if (completedFiles.length > 0 && branchName) {
        await commitAndStay(branchName, `partial: ${completedFiles.length} files completed before error`);
        await sendLineMessage(conv.user_id,
          `実装中にエラーが発生しました:\n${errMsg.slice(0, 400)}\n\n` +
          `完了済み ${completedFiles.length} ファイルはブランチ ${branchName} に保存されています。`
        );
      } else if (branchName) {
        await rollbackGit(branchName);
        await sendLineMessage(conv.user_id, 'コードをロールバックしました。');
      }

      updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id, '新しい依頼を送ってリトライできます。');
    }
  }

  // stuckモードのコンテキスト保持
  private stuckContext: {
    branchName: string;
    subtasks: Subtask[];
    completedFiles: Array<{ path: string; content: string }>;
    failedSubtaskIndex: number;
    errorMessage: string;
  } | null = null;

  private async handleStuck(conv: DevConversation, userReply: string): Promise<void> {
    const ctx = this.stuckContext;
    if (!ctx) {
      await sendLineMessage(conv.user_id, 'スタック情報が失われました。新しい開発依頼を送ってください。');
      updateConversationStatus(conv.id, 'failed');
      return;
    }

    const normalizedReply = userReply.trim().toLowerCase();

    if (/^(中止|キャンセル|やめ)/.test(normalizedReply)) {
      dbLog('info', 'dev-agent', '[stuck] ユーザーが中止を選択', { convId: conv.id });
      this.stuckContext = null;
      updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id,
        `開発を中止しました。完了済みファイルはブランチ ${ctx.branchName} に残っています。`
      );
      return;
    }

    if (/^スキップ/.test(normalizedReply)) {
      dbLog('info', 'dev-agent', `[stuck] サブタスク ${ctx.failedSubtaskIndex + 1} をスキップ`, { convId: conv.id });
      this.stuckContext = null;
      await this.runImplementation(conv, {
        branchName: ctx.branchName,
        subtasks: ctx.subtasks,
        completedFiles: ctx.completedFiles,
        startIndex: ctx.failedSubtaskIndex + 1,
      });
      return;
    }

    // リトライ or 追加指示付きリトライ
    dbLog('info', 'dev-agent', `[stuck] リトライ（指示: ${userReply.slice(0, 50)}）`, { convId: conv.id });
    const failedSubtask = ctx.subtasks[ctx.failedSubtaskIndex];

    // ユーザーの追加指示をサブタスクのdescriptionに反映
    if (!/^リトライ$/.test(normalizedReply)) {
      failedSubtask.description += `\n\n追加指示: ${userReply}`;
    }

    this.stuckContext = null;
    await this.runImplementation(conv, {
      branchName: ctx.branchName,
      subtasks: ctx.subtasks,
      completedFiles: ctx.completedFiles,
      startIndex: ctx.failedSubtaskIndex,
    });
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
      // --- エンジニア（パースリトライ付き） ---
      const engineerContext = this.buildEngineerContext(conv, subtask, allSubtasks, completedFiles, reviewFeedback);

      let engineerParsed: any = null;
      let lastRawOutput = '';

      for (let parseRetry = 0; parseRetry < MAX_ENGINEER_PARSE_RETRIES; parseRetry++) {
        dbLog('info', 'dev-agent', `[エンジニア] コード生成 (レビュー試行 ${reviewRetry + 1}, パース試行 ${parseRetry + 1})`, { convId: conv.id, path: subtask.path });

        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
          { role: 'user', content: engineerContext },
        ];

        // パースリトライ時は前回の出力をフィードバック
        if (parseRetry > 0 && lastRawOutput) {
          messages.push(
            { role: 'assistant', content: lastRawOutput },
            { role: 'user', content: `上記の出力はJSON形式として不正です。以下の形式で正確にJSON"のみ"を出力してください。説明文やマークダウンは不要です。\n\n{"file": {"path": "${subtask.path}", "content": "ファイル内容全体", "action": "${subtask.action}"}}` },
          );
        }

        const { text: engineerOutput } = await callClaude({
          system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
          messages,
          model: 'default',
          maxTokens: 16384,
        });

        lastRawOutput = engineerOutput;
        engineerParsed = safeParseJson(engineerOutput);

        if (engineerParsed?.file?.path && engineerParsed?.file?.content) {
          break; // パース成功
        }

        dbLog('warn', 'dev-agent', `[エンジニア] パース失敗 (${parseRetry + 1}/${MAX_ENGINEER_PARSE_RETRIES}): ${engineerOutput.slice(0, 100)}`, { convId: conv.id });
        engineerParsed = null;
      }

      if (!engineerParsed || !engineerParsed.file || !engineerParsed.file.path || !engineerParsed.file.content) {
        throw new Error(`エンジニア: ${subtask.path} のパースに${MAX_ENGINEER_PARSE_RETRIES}回失敗\n最後の出力: ${lastRawOutput.slice(0, 200)}`);
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
        // ビルドエラーで参照されている既存ファイルも読み込む
        const { extractErrorFiles } = await import('./deployer');
        const errorFiles = extractErrorFiles(buildResult.buildOutput || '');
        let existingContext = '';
        for (const ef of errorFiles) {
          const alreadyInLast = lastFiles.find(f => f.path === ef);
          if (!alreadyInLast) {
            const content = await readProjectFile(ef);
            if (content) {
              existingContext += `### ${ef}（既存ファイル）\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
            }
          }
        }

        const { text } = await callClaude({
          system: DEV_SYSTEM_PROMPT + '\n\n' + ENGINEER_PROMPT,
          messages: [
            {
              role: 'user',
              content: `以下のコードにビルドエラーがあります。修正してください。\n\n` +
                `## ビルドエラー\n${buildResult.buildOutput}\n\n` +
                `## 今回変更したコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}\n\n` +
                (existingContext ? `## 関連する既存ファイル（参照用・変更が必要な場合のみ含めてください）\n${existingContext}\n\n` : '') +
                `## 重要\n- 既存ファイルのimportパスや型定義に合わせてください\n- 存在しないモジュールをimportしないでください\n- package.jsonに無いパッケージは使わないでください\n\n` +
                `全ファイルをまとめて修正してください。出力形式:\n{"files": [{"path": "...", "content": "...", "action": "..."}]}`,
            },
          ],
          model: 'default',
          maxTokens: 16384,
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

  // 1. マークダウンコードブロック除去
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // 2. そのまま試す
  try { return JSON.parse(jsonStr); } catch { /* continue */ }

  // 3. 最初の { ... } または [ ... ] ブロックを抽出
  const objMatch = jsonStr.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try { return JSON.parse(objMatch[1]); } catch { /* continue */ }
  }
  const arrMatch = jsonStr.match(/(\[[\s\S]*\])/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[1]); } catch { /* continue */ }
  }

  // 4. 末尾のカンマ除去して再試行
  if (objMatch) {
    const cleaned = objMatch[1].replace(/,\s*([\]}])/g, '$1');
    try { return JSON.parse(cleaned); } catch { /* continue */ }
  }

  return null;
}
