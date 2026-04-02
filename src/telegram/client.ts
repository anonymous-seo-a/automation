import { config } from '../config';
import { logger } from '../utils/logger';

const API_BASE = `https://api.telegram.org/bot${config.telegram.botToken}`;
const MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_TIMEOUT_MS = 15_000; // 15秒

/** Telegram webhook シークレットトークン（setWebhook で設定する値と一致させる） */
export const TELEGRAM_WEBHOOK_SECRET = config.telegram.webhookSecret || '';

/** Telegram にテキストメッセージを送信 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!config.telegram.botToken) {
    logger.warn('TELEGRAM_BOT_TOKEN が未設定のため送信スキップ');
    return;
  }

  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: 'Markdown',
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        // Markdown パース失敗時はプレーンテキストで再送
        if (res.status === 400) {
          const ctrl2 = new AbortController();
          const tid2 = setTimeout(() => ctrl2.abort(), TELEGRAM_TIMEOUT_MS);
          try {
            await fetch(`${API_BASE}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: chunk,
              }),
              signal: ctrl2.signal,
            });
          } finally {
            clearTimeout(tid2);
          }
        } else {
          const err = await res.text();
          logger.error('Telegram送信エラー', { status: res.status, err });
        }
      }
    } catch (err) {
      logger.error('Telegram送信失敗', { err: err instanceof Error ? err.message : String(err), chatId });
      throw err; // sender.ts のリトライに伝播させる
    }
  }
}

/** 認証チェック: 許可されたユーザーか */
export function isAuthorizedTelegramUser(chatId: number | string): boolean {
  return String(chatId) === config.telegram.allowedChatId;
}

/** Telegram のファイルをダウンロードしてbase64変換 */
export async function downloadTelegramFile(fileId: string): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }> {
  // Step 1: getFile でファイルパスを取得
  const fileRes = await fetch(`${API_BASE}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!fileRes.ok) throw new Error(`Telegram getFile failed: ${fileRes.status}`);
  const fileData = await fileRes.json() as { ok: boolean; result: { file_path: string } };
  if (!fileData.ok || !fileData.result?.file_path) throw new Error('Telegram getFile: no file_path');

  // Step 2: ファイル本体をダウンロード
  const downloadUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${fileData.result.file_path}`;
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`Telegram file download failed: ${dlRes.status}`);

  const arrayBuffer = await dlRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString('base64');

  // マジックバイトでmediaType判定
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) mediaType = 'image/png';
  else if (buffer[0] === 0x47 && buffer[1] === 0x49) mediaType = 'image/gif';
  else if (buffer[0] === 0x52 && buffer[1] === 0x49) mediaType = 'image/webp';

  return { base64, mediaType };
}

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx === -1 || splitIdx < MAX_MESSAGE_LENGTH * 0.5) {
      splitIdx = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
