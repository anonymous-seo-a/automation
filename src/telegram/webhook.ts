import { Router, Request, Response } from 'express';
import { isAuthorizedTelegramUser, TELEGRAM_WEBHOOK_SECRET } from './client';
import { handleMessage } from '../line/webhook';
import { logger, dbLog } from '../utils/logger';

export const telegramRouter = Router();

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
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
  if (!update.message?.text) return;

  const chatId = update.message.chat.id;
  const text = update.message.text.trim();

  if (!isAuthorizedTelegramUser(chatId)) {
    logger.warn('未認証Telegramユーザー', { chatId, username: update.message.from.username });
    return;
  }

  dbLog('info', 'telegram', `受信: ${text.slice(0, 100)}`, { chatId });

  // "tg:" プレフィックス付きユーザーIDで共通handleMessageを呼ぶ
  const userId = `tg:${chatId}`;
  handleMessage(userId, text).catch(err => {
    logger.error('Telegram メッセージ処理エラー', { err: err instanceof Error ? err.message : String(err) });
  });
});
