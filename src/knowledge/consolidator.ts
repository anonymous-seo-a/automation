import { promises as fs } from 'fs';
import path from 'path';
import { callClaude } from '../claude/client';
import { getAllMemories } from '../memory/store';
import { getDB } from '../db/database';
import { loadKnowledgeFiles } from './loader';
import { reloadKnowledgeCache } from '../line/bunshinPrompt';
import { logger, dbLog } from '../utils/logger';
import { randomUUID } from 'crypto';

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'knowledge');

interface ConsolidationResult {
  diffs: string[];
  updatedFiles: string[];
}

/**
 * 記憶をナレッジに統合する。
 * 既存ナレッジ + 直近30日の記憶 → Claude Opus で更新版を生成。
 * ファイルには書き込まず、差分と更新内容を返す。
 */
export async function consolidateKnowledge(userId: string): Promise<ConsolidationResult> {
  // 直近30日の記憶を取得
  const db = getDB();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentMemories = await db.prepare(
    "SELECT * FROM memories WHERE user_id = ? AND updated_at >= ? ORDER BY updated_at DESC"
  ).all(userId, thirtyDaysAgo) as Array<{ type: string; key: string; content: string; updated_at: string }>;

  if (recentMemories.length === 0) {
    return { diffs: ['直近30日の記憶がありません。統合する内容がありません。'], updatedFiles: [] };
  }

  const memoryText = recentMemories
    .map(m => `[${m.type}] ${m.key}: ${m.content} (${m.updated_at})`)
    .join('\n');

  // knowledge/ のファイルを読み込み
  let files: string[];
  try {
    files = (await fs.readdir(KNOWLEDGE_DIR)).filter(f => f.endsWith('.md')).sort();
  } catch {
    return { diffs: ['knowledge/ ディレクトリが見つかりません。'], updatedFiles: [] };
  }

  const diffs: string[] = [];
  const updatedFiles: string[] = [];
  const pendingContents: Array<{ fileName: string; newContent: string }> = [];

  // ファイルごとに個別処理
  for (const fileName of files) {
    const filePath = path.join(KNOWLEDGE_DIR, fileName);
    const currentContent = await fs.readFile(filePath, 'utf-8');

    try {
      const { text: newContent } = await callClaude({
        system: `あなたはナレッジファイルの更新担当です。
以下は既存のナレッジファイルです。その後に最近の記憶が続きます。
記憶の中で既存ナレッジに追加・更新すべき情報があれば反映した新しいバージョンを出力してください。
変更がなければ既存の内容をそのまま返してください。

重要:
- マークダウン形式を維持する
- 既存の構造（見出し・箇条書き）を壊さない
- 事実に基づく変更のみ行う
- 推測や憶測は追加しない
- ファイルの内容だけを出力する（説明文やコードブロック囲みは不要）`,
        messages: [
          {
            role: 'user',
            content: `## 既存ナレッジ（${fileName}）\n\n${currentContent}\n\n## 直近の記憶（${recentMemories.length}件）\n\n${memoryText}`,
          },
        ],
        model: 'opus',
        maxTokens: 8192,
      });

      const trimmedNew = newContent.trim();
      const trimmedOld = currentContent.trim();

      if (trimmedNew === trimmedOld) {
        diffs.push(`📄 ${fileName}: 変更なし`);
      } else {
        updatedFiles.push(fileName);
        pendingContents.push({ fileName, newContent: trimmedNew });
        // 差分サマリを生成（長すぎるとLINEで送れないので要約）
        const diffSummary = generateDiffSummary(trimmedOld, trimmedNew, fileName);
        diffs.push(diffSummary);
      }
    } catch (err) {
      logger.error('ナレッジ統合エラー', { fileName, err: err instanceof Error ? err.message : String(err) });
      diffs.push(`❌ ${fileName}: 処理エラー`);
    }
  }

  // pending_updates に保存
  if (pendingContents.length > 0) {
    const updateId = randomUUID();
    await db.prepare(
      "INSERT INTO pending_updates (id, user_id, update_type, content, status) VALUES (?, ?, ?, ?, 'pending')"
    ).run(updateId, userId, 'knowledge_consolidation', JSON.stringify(pendingContents));
    logger.info('ナレッジ統合結果をpending_updatesに保存', { updateId, fileCount: pendingContents.length });
  }

  return { diffs, updatedFiles };
}

/** 差分の要約を生成（LINE送信用に短くする） */
function generateDiffSummary(oldContent: string, newContent: string, fileName: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const added = newLines.filter(l => l.trim() && !oldLines.includes(l));
  const removed = oldLines.filter(l => l.trim() && !newLines.includes(l));

  const parts: string[] = [`📝 ${fileName}:`];

  if (added.length > 0) {
    parts.push(`  追加 ${added.length}行:`);
    for (const line of added.slice(0, 5)) {
      parts.push(`  + ${line.slice(0, 60)}`);
    }
    if (added.length > 5) parts.push(`  ...他${added.length - 5}行`);
  }

  if (removed.length > 0) {
    parts.push(`  削除 ${removed.length}行:`);
    for (const line of removed.slice(0, 3)) {
      parts.push(`  - ${line.slice(0, 60)}`);
    }
    if (removed.length > 3) parts.push(`  ...他${removed.length - 3}行`);
  }

  return parts.join('\n');
}

/**
 * 承認されたpending_updatesを実際にファイルに反映する。
 */
export async function applyPendingUpdate(userId: string): Promise<string> {
  const db = getDB();
  const pending = await db.prepare(
    "SELECT * FROM pending_updates WHERE user_id = ? AND status = 'pending' AND update_type = 'knowledge_consolidation' ORDER BY created_at DESC LIMIT 1"
  ).get(userId) as { id: string; content: string } | undefined;

  if (!pending) {
    return '反映待ちの更新はありません。';
  }

  const updates = JSON.parse(pending.content) as Array<{ fileName: string; newContent: string }>;
  const applied: string[] = [];

  for (const { fileName, newContent } of updates) {
    const filePath = path.join(KNOWLEDGE_DIR, fileName);
    try {
      await fs.writeFile(filePath, newContent, 'utf-8');
      applied.push(fileName);
    } catch (err) {
      logger.error('ナレッジファイル書き込み失敗', { fileName, err: err instanceof Error ? err.message : String(err) });
    }
  }

  // ステータス更新
  await db.prepare(
    "UPDATE pending_updates SET status = 'applied' WHERE id = ?"
  ).run(pending.id);

  // ナレッジキャッシュ再読み込み
  await reloadKnowledgeCache();

  // DBのナレッジも再ロード
  await loadKnowledgeFiles(KNOWLEDGE_DIR);

  dbLog('info', 'consolidator', `ナレッジ反映完了: ${applied.join(', ')}`, { userId });

  return `ナレッジを反映しました 📚\n更新ファイル: ${applied.join(', ')}`;
}
