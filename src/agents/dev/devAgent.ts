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

  // タスクキュー経由の実行（互換性のため）
  async execute(task: Task): Promise<TaskResult> {
    return {
      success: true,
      output: '開発エージェントはLINE会話経由で動作します。LINEから「〇〇を開発して」と送信してください。',
      needsExecution: false,
    };
  }

  // LINE会話経由のメイン処理
  async handleMessage(userId: string, text: string): Promise<void> {
    try {
      // キャンセル処理
      if (/開発(キャンセル|中止|やめ)|やめて|やめる|キャンセル/.test(text.trim())) {
        const conv = getActiveConversation(userId);
        if (conv) {
          cancelConversation(conv.id);
          await sendLineMessage(userId, '🛑 開発を中止しました。');
        } else {
          await sendLineMessage(userId, '進行中の開発はありません。');
        }
        return;
      }

      let conv = getActiveConversation(userId);

      if (!conv) {
        conv = createConversation(userId, text);
        await sendLineMessage(userId, `🔧 開発モード起動\n「${text}」を承りました。\nいくつか確認させてください。`);
        await this.runHearing(conv, text);
        return;
      }

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
          await sendLineMessage(userId, '⏳ 現在実装中です。完了次第ご報告します。');
          break;
        case 'deployed':
          await sendLineMessage(userId, '✅ 前回の開発は完了済みです。新しい依頼を送ってください。');
          break;
        case 'failed':
          await sendLineMessage(userId, '❌ 前回の開発は失敗しています。新しい依頼を送ってください。');
          break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('DevAgent処理エラー', { err: errMsg, userId });
      await sendLineMessage(userId, `❌ 開発エージェントエラー:\n${errMsg.slice(0, 300)}`);
    }
  }

  // Phase 1: ヒアリング（初回）
  private async runHearing(conv: DevConversation, initialMessage: string): Promise<void> {
    appendHearingLog(conv.id, 'user', initialMessage);

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

    await this.processHearingResponse(conv, text);
  }

  // Phase 1: ヒアリング（2回目以降）
  private async handleHearing(conv: DevConversation, userReply: string): Promise<void> {
    appendHearingLog(conv.id, 'user', userReply);

    const round = getHearingRound(conv.id);
    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = JSON.parse(updatedConv.hearing_log);

    // 最大回数に達したら強制的に要件定義へ
    if (round >= MAX_HEARING_ROUNDS) {
      appendHearingLog(conv.id, 'agent', 'ヒアリング最大回数到達。収集済み情報で要件定義に進みます。');
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

    await this.processHearingResponse(conv, text);
  }

  private async processHearingResponse(conv: DevConversation, text: string): Promise<void> {
    const parsed = safeParseJson(text);

    if (parsed && parsed.hearing_complete) {
      appendHearingLog(conv.id, 'agent', parsed.summary || 'ヒアリング完了');
      await this.transitionToDefining(conv);
    } else if (parsed && parsed.questions && parsed.questions.length > 0) {
      const questions = (parsed.questions as string[]).slice(0, 3);
      const msg = `📝 確認事項:\n${questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}`;
      appendHearingLog(conv.id, 'agent', msg);
      await sendLineMessage(conv.user_id, msg);
    } else {
      appendHearingLog(conv.id, 'agent', text);
      await sendLineMessage(conv.user_id, text);
    }
  }

  // Phase 2: 要件定義
  private async transitionToDefining(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'defining');

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;
    const hearingLog = JSON.parse(updatedConv.hearing_log);

    await sendLineMessage(conv.user_id, '📋 ヒアリング完了。要件定義書を作成中...');

    const { text } = await callClaude({
      system: DEV_SYSTEM_PROMPT + '\n\n' + REQUIREMENTS_PROMPT,
      messages: [
        { role: 'user', content: `開発依頼: ${conv.topic}\n\nヒアリング内容:\n${JSON.stringify(hearingLog)}` },
      ],
      model: 'opus',
    });

    setRequirements(conv.id, text);
    await sendLineMessage(conv.user_id, text);
    await sendLineMessage(conv.user_id, '「OK」で実装開始、修正指示があれば伝えてください。');
  }

  private async handleDefining(conv: DevConversation, userReply: string): Promise<void> {
    const normalized = userReply.trim().toLowerCase();

    if (/^(ok|おk|はい|いいよ|お願い|問題ない|大丈夫)$/.test(normalized)) {
      updateConversationStatus(conv.id, 'approved');
      await sendLineMessage(conv.user_id, '🚀 実装を開始します。完了まで数分お待ちください...');
      await this.runImplementation(conv);
    } else {
      await sendLineMessage(conv.user_id, '📝 要件を修正中...');

      const updatedConv = getConversation(conv.id);
      const { text } = await callClaude({
        system: DEV_SYSTEM_PROMPT + '\n\n' + REQUIREMENTS_PROMPT,
        messages: [
          { role: 'user', content: `元の要件:\n${updatedConv?.requirements || conv.requirements}\n\n修正指示: ${userReply}` },
        ],
        model: 'opus',
      });

      setRequirements(conv.id, text);
      await sendLineMessage(conv.user_id, text);
      await sendLineMessage(conv.user_id, '「OK」で実装開始、修正指示があれば伝えてください。');
    }
  }

  // Phase 3: 実装（git安全策付き）
  private async runImplementation(conv: DevConversation): Promise<void> {
    updateConversationStatus(conv.id, 'implementing');

    const updatedConv = getConversation(conv.id);
    if (!updatedConv) return;

    let branchName = '';

    try {
      // git安全策: ブランチ作成
      branchName = await prepareGitBranch();
      await sendLineMessage(conv.user_id, `🌿 ブランチ作成: ${branchName}`);

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
      const writtenFiles = await writeFiles(files);
      setGeneratedFiles(conv.id, writtenFiles);

      // Phase 4: ビルド & デプロイ
      updateConversationStatus(conv.id, 'testing');
      await this.runBuildAndDeploy(conv, files, 0, branchName);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // ビルド失敗 → ロールバック
      if (branchName) {
        await rollbackGit(branchName);
        await sendLineMessage(conv.user_id, '🔙 コードをロールバックしました。');
      }

      updateConversationStatus(conv.id, 'failed');
      dbLog('error', 'dev-agent', '実装失敗', { convId: conv.id, error: errMsg });
      await sendLineMessage(conv.user_id,
        `❌ 実装に失敗しました:\n${errMsg.slice(0, 500)}\n\n新しい依頼を送ってリトライできます。`
      );
    }
  }

  // Phase 4: ビルド＆デプロイ（git安全策付き）
  private async runBuildAndDeploy(
    conv: DevConversation,
    lastFiles: FileToWrite[],
    retryCount: number,
    branchName: string,
  ): Promise<void> {
    const buildResult = await runBuild();

    if (buildResult.success) {
      // コミット
      await commitAndStay(branchName, `feat(dev-agent): ${conv.topic}`);

      // デプロイ（ヘルスチェック付き）
      const deployResult = await deployWithHealthCheck(branchName);
      if (deployResult.success) {
        updateConversationStatus(conv.id, 'deployed');
        const updatedConv = getConversation(conv.id) || conv;
        const generatedFiles = JSON.parse(updatedConv.generated_files || '[]') as string[];

        await sendLineMessage(conv.user_id,
          `✅ 開発完了！\n\n` +
          `📋 ${conv.topic}\n` +
          `🌿 ブランチ: ${branchName}\n\n` +
          `📁 ファイル一覧:\n${generatedFiles.map(f => `  - ${f}`).join('\n')}\n\n` +
          `🔨 ビルド: 成功\n` +
          `🚀 デプロイ: 完了（ヘルスチェック通過）\n\n` +
          `正常に反映されました。`
        );
        dbLog('info', 'dev-agent', '開発完了・デプロイ成功', { convId: conv.id, branch: branchName });
      } else {
        updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `❌ ${deployResult.message}\n前の状態に復帰済みです。`
        );
      }
    } else if (retryCount < MAX_BUILD_RETRIES) {
      // ビルドエラー自己修正
      await sendLineMessage(conv.user_id,
        `🔧 ビルドエラー検出。自動修正中... (${retryCount + 1}/${MAX_BUILD_RETRIES})`
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
        // ロールバック
        await rollbackGit(branchName);
        await sendLineMessage(conv.user_id, '🔙 コードをロールバックしました。');
        updateConversationStatus(conv.id, 'failed');
        await sendLineMessage(conv.user_id,
          `❌ ビルドエラーの自動修正に失敗しました:\n${errMsg.slice(0, 300)}`
        );
      }
    } else {
      // 最大リトライ超過 → ロールバック
      await rollbackGit(branchName);
      await sendLineMessage(conv.user_id, '🔙 コードをロールバックしました。');
      updateConversationStatus(conv.id, 'failed');
      await sendLineMessage(conv.user_id,
        `❌ ビルドエラーを${MAX_BUILD_RETRIES}回修正しましたが解決できませんでした:\n${buildResult.buildOutput?.slice(0, 500)}\n\n手動での修正が必要です。`
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
