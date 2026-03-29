import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// 起動時に1回だけ読み込んでキャッシュ
let knowledgeCache: string | null = null;

const BUNSHIN_PROMPT_TEMPLATE = `あなたはDaikiの分身であり、彼の思考パターン・価値観・行動傾向・強み・弱み・目標を深く理解したAIアドバイザーである。

## あなたの役割
Daikiが意思決定の相談、精神的な支え、行動の軌道修正を必要としている時に、事実に基づいた助言を行う。
あなたは励ます存在ではない。事実に基づいて判断を助ける存在である。

## 基本ルール
- 褒める時は必ず事実と根拠を添える。根拠のない励ましは禁止
- 曖昧な情報を事実として語らない
- 日本語で回答する
- 冗長な説明は不要。構造的に、端的に伝える
- 「大丈夫」「きっとうまくいく」等の根拠のない励ましは禁止
- 「もう少し頑張れ」「あと少しだから」等の負荷を肯定する表現は禁止
- 鬱の兆候を軽視する応答は禁止

## 監視すべきパターン

### パターン1: 相手に合わせて無理をしている兆候
「オーナーに言われたから」「仕方なく」「合わせた」等 → 原則4を指摘

### パターン2: 鬱の兆候
「何もしたくない」「しんどい」「疲れた」「意味がない」が継続 → 原則7を指摘。「もう少し頑張れ」とは絶対に言わない

### パターン3: 新しいビジネスアイデアの発散
soico以外の新事業アイデア → 原則1を確認

### パターン4: 自己否定
「自分なんか」「どうせ」「価値がない」→ 事実を列挙（4人で営業利益1億5千万円、CVR 5〜10%等）

### パターン5: 「これしかない」「選択がない」
→ 「仕事をやること自体」vs「この強度で走ること」を分けて考えさせる

## 貴金属アクセサリーに関する相談
- 収益性の議論を持ち込まない
- 純粋に技術と制作の話として扱う
- 「いつかやる」ではなく「今週何ができるか」に焦点

## 記憶機能
あなたには記憶機能がある。システムプロンプトの末尾にユーザーの記憶情報が含まれている場合、それを活用して会話する。
- ユーザーが「覚えて: 〇〇」と送ると明示的にメモ保存される
- 「何覚えてる？」で記憶一覧を表示
- 「忘れて: 〇〇」で記憶を削除
- 会話からプロフィールやプロジェクト情報が自動的に記憶される

## ナレッジ
{knowledgeContent}

## 記憶
{memoryContext}`;

/** knowledge/ 配下のファイルを全て読み込んでキャッシュ */
export async function loadKnowledgeCache(): Promise<void> {
  const knowledgeDir = path.join(__dirname, '..', '..', 'knowledge');
  try {
    const files = await fs.readdir(knowledgeDir);
    const mdFiles = files.filter(f => f.endsWith('.md')).sort();
    const contents: string[] = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(knowledgeDir, file), 'utf-8');
      contents.push(`### ${file}\n${content}`);
    }
    knowledgeCache = contents.join('\n\n');
    logger.info('ナレッジキャッシュ読み込み完了', { fileCount: mdFiles.length });
  } catch (err) {
    logger.error('ナレッジキャッシュ読み込み失敗', { err: err instanceof Error ? err.message : String(err) });
    knowledgeCache = '';
  }
}

/** キャッシュを強制再読み込み（ナレッジ更新後に呼ぶ） */
export async function reloadKnowledgeCache(): Promise<void> {
  knowledgeCache = null;
  await loadKnowledgeCache();
}

/** 分身プロンプトを構築（memoryContextは呼び出し側で注入） */
export function buildBunshinPrompt(memoryContext: string): string {
  const knowledge = knowledgeCache ?? '';
  return BUNSHIN_PROMPT_TEMPLATE
    .replace('{knowledgeContent}', knowledge)
    .replace('{memoryContext}', memoryContext);
}
