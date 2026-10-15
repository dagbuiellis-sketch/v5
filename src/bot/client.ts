import { Telegraf } from 'telegraf';
import { pino } from 'pino';
import * as db from './database';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const token = process.env.BOT_TOKEN;

if (!token) {
  logger.warn('BOT_TOKEN is missing from environment variables. Running in preview/mock mode for dashboard.');
}

// Dummy fallback token to allow Telegraf initialization without throwing immediate crash
export const bot = new Telegraf(token || '000000000:AAFakeBotTokenForPreviewModeOnly');

export function getAdminId(): string {
  const dbAdmin = db.getConfig('ADMIN_ID');
  return dbAdmin || process.env.ADMIN_ID || '';
}

export function setupBot() {
  logger.info('Setting up bot handlers...');
  
  // Debug Log
  bot.use(async (ctx, next) => {
    const adminId = getAdminId();
    if (ctx.from?.id.toString() === adminId) {
      logger.info(`Admin Update: ${ctx.updateType}`);
    }
    return next();
  });

  // Error handling
  bot.catch((err: any, ctx) => {
    logger.error({ err, updateType: ctx.updateType }, 'Telegraf error:');
  });
}

/**
 * Safely react to a message with an emoji (e.g. 🤡)
 * Works across Telegram Bot API versions without failing if permissions are absent
 */
export async function setMessageReaction(telegram: any, chatId: string | number, messageId: number, emoji = '🤡') {
  try {
    if (typeof telegram.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
    } else {
      await (telegram as any).callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      });
    }
  } catch (err: any) {
    logger.debug({ err: err?.message, chatId, messageId }, 'Reaction call skipped or failed');
  }
}
