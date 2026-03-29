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
  HEARING_PROMPT,
  REQUIREMENTS_PROMPT,
  IMPLEMENTATION_PROMPT,
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
      // キャンセル処理
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

  private async runHearing(conv: DevConversation, initialMessage: string): Promise<void> {
    appendHearingLog(conv.id, 'user', initialMessage);
    dbLog('info', 'dev-agent', `ヒアリング開始: round 1/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = JSON.parse(updatedConv.hearing_log);

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + HEARING_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${initialMessage}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\n現在のヒアリング回数: 1/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'default',
    });

    dbLog('info', 'dev-agent', `ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async handleHearing(conv: DevConversation, userReply: string): Promise<void> {
    appendHearingLog(conv.id, 'user', userReply);

    const round = getHearingRound(conv.id);
    dbLog('info', 'dev-agent', `ヒアリング回答受信: round ${round}/${MAX_HEARING_ROUNDS}`, { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = JSON.parse(updatedConv.hearing_log);

    if (round >= MAX_HEARING_ROUNDS) {
      dbLog('info', 'dev-agent', 'ヒアリング最大回数到達 → 要件定義へ', { convId: conv.id });
      appendHearingLog(conv.id, 'agent', 'ヒアリング最大回数到達。要件定義に進みます。');
      await this.transitionToDefining(conv);
      return;
    }

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + HEARING_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${conv.topic}\n\nヒアリングログ:\n${JSON.stringify(hearingLog)}\n\nユーザーの最新回答: ${userReply}\n\n現在のヒアリング回数: ${round}/${MAX_HEARING_ROUNDS}` },
      ],
      model: 'default',
    });

    dbLog('info', 'dev-agent', `ヒアリング応答: ${text.slice(0, 100)}`, { convId: conv.id });
    await this.processHearingResponse(conv, text);
  }

  private async processHearingResponse(conv: DevConversation, text: string): Promise<void> {
    const parsed = safeParseJson(text);

    if (parsed && parsed.hearing_complete) {
      dbLog('info', 'dev-agent', 'ヒアリング完了 → 要件定義へ', { convId: conv.id });
      appendHearingLog(conv.id, 'agent', parsed.summary || 'ヒアリング完了');
      await this.transitionToDefining(conv);
    } else if (parsed && parsed.questions && parsed.questions.length > 0) {
      const questions = (parsed.questions as string[]).slice(0, 3);
      const msg = questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n') + '\n\n（「やめる」で中止できます）';
      appendHearingLog(conv.id, 'agent', msg);
      await sendLineMessage(conv.user_id, msg);
    } else {
      // JSONパース失敗時はそのまま送信
      dbLog('warn', 'dev-agent', `ヒアリング応答がJSON外: ${text.slice(0, 80)}`, { convId: conv.id });
      appendHearingLog(conv.id, 'agent', text);
      await sendLineMessage(conv.user_id, text);
    }
  }

  private async transitionToDefining(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'defining');
    dbLog('info', 'dev-agent', '要件定義書作成開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = JSON.parse(updatedConv.hearing_log);

    await sendLineMessage(conv.user_id, 'ヒアリング完了。要件定義書を作成中...');

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + REQUIREMENTS_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${conv.topic}\n\nヒアリング内容:\n${JSON.stringify(hearingLog)}` },
      ],
      model: 'opus',
    });

    setRequirements(conv.id, text);
    dbLog('info', 'dev-agent', `要件定義書作成完了 (${text.length}文字)`, { convId: conv.id });
    await sendLineMessage(conv.user_id, text);
    await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
  }

  private async handleDefining(conv: DevConversation, userReply: string): Promise<void> {
    dbLog('info', 'dev-agent', `要件定義フェーズ応答: ${userReply.slice(0, 40)}`, { convId: conv.id });

    if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫|進めて|実装して|それで)$/i.test(userReply.trim())) {
      updateConversationStatus(conv.id, 'approved');
      dbLog('info', 'dev-agent', '要件承認 → 実装開始', { convId: conv.id });
      await sendLineMessage(conv.user_id, '実装を開始します。完了まで数分お待ちください...');
      await this.runImplementation(conv);
    } else {
      dbLog('info', 'dev-agent', '要件修正指示を受信', { convId: conv.id });
      await sendLineMessage(conv.user_id, '要件を修正中...');

      const updatedConv = getConversation(conv.id);
      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + REQUIREMENTS_PROMPT,
        messages: [
          { role: 'user', content: `元の要件:\n${updatedConv?.requirements || conv.requirements}\n\n修正指示: ${userReply}` },
        ],
        model: 'opus',
      });

      setRequirements(conv.id, text);
      dbLog('info', 'dev-agent', `要件修正完了 (${text.length}文字)`, { convId: conv.id });
      await sendLineMessage(conv.user_id, text);
      await sendLineMessage(conv.user_id, '「OK」で実装開始。修正指示も可。\n（「やめる」で中止、別の話題はそのまま送れます）');
    }
  }

  private async runImplementation(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'implementing');
    dbLog('info', 'dev-agent', '実装フェーズ開始', { convId: conv.id });

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;

    let branchName = '';

    try {
      branchName = await prepareGitBranch();
      dbLog('info', 'dev-agent', `ブランチ作成: ${branchName}`, { convId: conv.id });
      await sendLineMessage(conv.user_id, `ブランチ作成: ${branchName}`);

      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + IMPLEMENTATION_PROMPT,
        messages: [
          { role: 'user', content: `以下の要件を実装してください:\n\n${updatedConv.requirements}` },
        ],
        model: 'opus',
        maxTokens: 8192,
      });

      const parsed = safeParseJson(text);
      if (!parsed || !parsed.files || !Array.isArray(parsed.files)) {
        throw new Error('実装コードのパースに失敗しました');
      }

      const files = parsed.files as FileToWrite[];
      dbLog('info', 'dev-agent', `コード生成: ${files.length}ファイル`, { convId: conv.id, files: files.map(f => f.path) });
      const writtenFiles = await writeFiles(files);
      setGeneratedFiles(conv.id, writtenFiles);

      updateConversationStatus(conv.id, 'testing');
      await this.runBuildAndDeploy(conv, files, 0, branchName);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dbLog('error', 'dev-agent', `実装失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });

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

  private async runBuildAndDeploy(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
  ): Promise<void> {
    dbLog('info', 'dev-agent', `ビルド開始 (試行 ${retryCount + 1})`, { convId: conv.id });
    const buildResult = await runBuild();

    if (buildResult.success) {
      dbLog('info', 'dev-agent', 'ビルド成功 → デプロイ開始', { convId: conv.id });
      await commitAndStay(branchName, `feat(dev-agent): ${conv.topic}`);

      const deployResult = await deployWithHealthCheck(branchName);
      if (deployResult.success) {
        updateConversationStatus(conv.id, 'deployed');
        const updatedConv = getConversation(conv.id) || conv;
        const generatedFiles = JSON.parse(updatedConv.generated_files || '[]') as string[];

        dbLog('info', 'dev-agent', `デプロイ成功: ${branchName}`, { convId: conv.id, files: generatedFiles });
        await sendLineMessage(conv.user_id,
          `開発完了!\n\n` +
          `${conv.topic}\n` +
          `ブランチ: ${branchName}\n` +
          `ファイル: ${generatedFiles.join(', ')}\n\n` +
          `ビルド・デプロイ・ヘルスチェック全て通過。`
        );
      } else {
        updateConversationStatus(conv.id, 'failed');
        dbLog('error', 'dev-agent', `デプロイ失敗: ${deployResult.message}`, { convId: conv.id });
        await sendLineMessage(conv.user_id,
          `${deployResult.message}\n前の状態に復帰済みです。`
        );
      }
    } else if (retryCount < MAX_BUILD_RETRIES) {
      dbLog('warn', 'dev-agent', `ビルドエラー → 自動修正 (${retryCount + 1}/${MAX_BUILD_RETRIES})`, {
        convId: conv.id,
        buildOutput: buildResult.buildOutput?.slice(0, 300),
      });
      await sendLineMessage(conv.user_id,
        `ビルドエラー検出。自動修正中... (${retryCount + 1}/${MAX_BUILD_RETRIES})`
      );

      try {
        const { text } = await callClaude({
          system: DEV_SYSTEM_PROMPT + '\n\n' + IMPLEMENTATION_PROMPT,
          messages: [
            {
              role: 'user',
              content: `以下のコードにビルドエラーがあります。修正してください。\n\n` +
                `## ビルドエラー\n${buildResult.buildOutput}\n\n` +
                `## 現在のコード\n${lastFiles.map(f => `### ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``).join('\n\n')}`,
            },
          ],
          model: 'opus',
          maxTokens: 8192,
        });

        const parsed = safeParseJson(text);
        if (parsed && parsed.files && Array.isArray(parsed.files)) {
          const files = parsed.files as FileToWrite[];
          await writeFiles(files);
          await this.runBuildAndDeploy(conv, files, retryCount + 1, branchName);
        } else {
          throw new Error('修正コードのパースに失敗');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        dbLog('error', 'dev-agent', `自動修正失敗: ${errMsg.slice(0, 200)}`, { convId: conv.id });
        await rollbackGit(branchName);
        await sendLineMessage(conv.user_id, 'コードをロールバックしました。');
        updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `ビルドエラーの自動修正に失敗しました:\n${errMsg.slice(0, 300)}`
        );
      }
    } else {
      dbLog('error', 'dev-agent', `ビルド修正${MAX_BUILD_RETRIES}回失敗`, { convId: conv.id });
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
