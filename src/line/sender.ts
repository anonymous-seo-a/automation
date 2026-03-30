import * as line from '@line/bot-sdk';
import { config } from '../config';
import { sendTelegramMessage } from '../telegram/client';
import { logger } from '../utils/logger';

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const MAX_LINE_LENGTH = 4900;

// 最後にメッセージを送ってきたユーザーの送信先ID（tg: プレフィックス付き含む）
let lastActiveSendToId: string = config.line.allowedUserId;

/** 最後にアクティブだったプラットフォームの送信先IDを更新（webhook から呼ぶ） */
export function setActiveSendTo(userId: string): void {
  lastActiveSendToId = userId;
}

/** 最後にアクティブだったプラットフォームの送信先IDを取得 */
export function getActiveSendTo(): string {
  return lastActiveSendToId;
}

/**
 * ユニファイド送信関数: userId が "tg:" プレフィックスならTelegram、それ以外はLINE
 */
export async function sendMessage(userId: string, text: string): Promise<void> {
  if (userId.startsWith('tg:')) {
    const chatId = userId.slice(3);
    await sendTelegramMessage(chatId, text);
  } else {
    await sendLineMessageDirect(userId, text);
  }
}

/** 後方互換エイリアス（sendMessage と同一） */
export async function sendLineMessage(userId: string, text: string): Promise<void> {
  await sendMessage(userId, text);
}

async function sendLineMessageDirect(userId: string, text: string): Promise<void> {
  try {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: chunk }],
      });
    }
  } catch (err: any) {
    if (err?.status === 429 || err?.statusCode === 429) {
      logger.error('LINE送信失敗: 月間メッセージ上限到達', { userId });
    } else {
      logger.error('LINE送信エラー', { err: err instanceof Error ? err.message : String(err), userId });
    }
  }
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_LINE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LINE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', MAX_LINE_LENGTH);
    if (splitIdx === -1 || splitIdx < MAX_LINE_LENGTH * 0.5) {
      splitIdx = MAX_LINE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
