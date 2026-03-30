import * as line from '@line/bot-sdk';
import { config } from '../config';
import { logger } from '../utils/logger';

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const MAX_LINE_LENGTH = 4900;

export async function sendLineMessage(
  userId: string,
  text: string
): Promise<void> {
  try {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: chunk }],
      });
    }
  } catch (err: any) {
    // LINE月間無料枠超過 (429) の場合は明確にログ
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
