import { Router, Request, Response } from 'express';
import { isAuthorizedTelegramUser, TELEGRAM_WEBHOOK_SECRET, downloadTelegramFile } from './client';
import { handleMessage, handleImageMessage } from '../line/webhook';
import { logger, dbLog } from '../utils/logger';

export const telegramRouter = Router();

interface TelegramPhoto {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    photo?: TelegramPhoto[];
    caption?: string;
  };
}

telegramRouter.post('/', (req: Request, res: Response) => {
  // シークレットトークン検証（設定されている場合）
  if (TELEGRAM_WEBHOOK_SECRET) {
    const token = req.headers['x-telegram-bot-api-secret-token'];
    if (token !== TELEGRAM_WEBHOOK_SECRET) {
      logger.warn('Telegram webhook シークレット不一致', { token });
      res.status(403).end();
      return;
    }
  }

  // Telegram は即座に 200 を返す必要がある
  res.status(200).end();

  const update = req.body as TelegramUpdate;
  if (!update.message) return;

  const chatId = update.message.chat.id;
  if (!isAuthorizedTelegramUser(chatId)) {
    logger.warn('未認証Telegramユーザー', { chatId, username: update.message.from.username });
    return;
  }

  const userId = `tg:${chatId}`;

  // 画像メッセージ（photoが配列で届く。最後の要素が最高解像度）
  if (update.message.photo && update.message.photo.length > 0) {
    const bestPhoto = update.message.photo[update.message.photo.length - 1];
    const caption = update.message.caption?.trim();
    dbLog('info', 'telegram', `画像受信${caption ? `: ${caption.slice(0, 50)}` : ''}`, { chatId });

    downloadTelegramFile(bestPhoto.file_id).then(({ base64, mediaType }) => {
      dbLog('info', 'telegram', `画像ダウンロード完了: ${mediaType}, ${Math.round(base64.length * 3 / 4 / 1024)}KB`, { chatId });
      return handleImageMessage(userId, base64, mediaType, caption);
    }).catch(err => {
      logger.error('Telegram画像処理エラー', { err: err instanceof Error ? err.message : String(err) });
    });
    return;
  }

  // テキストメッセージ
  if (!update.message.text) return;
  const text = update.message.text.trim();

  dbLog('info', 'telegram', `受信: ${text.slice(0, 100)}`, { chatId });

  handleMessage(userId, text).catch(err => {
    logger.error('Telegram メッセージ処理エラー', { err: err instanceof Error ? err.message : String(err) });
  });
});
