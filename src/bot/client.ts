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
 * Safely react to a message with an emoji (e.g. 🤡) with playful big animation.
 * Attempts native MTProto client first (Api.messages.SendReaction with big: true, which is the
 * exact protocol official Telegram apps use when users manually tap reactions), and falls back to
 * Telegraf Bot API with boolean is_big: true.
 */
export async function setMessageReaction(
  telegram: any,
  chatId: string | number,
  messageId: number,
  emoji = '🤡',
  isBig = true
) {
  let mtSuccess = false;

  // 1. Primary: Use MTProto SendReaction with big: true for native playful animations
  try {
    const { initMTProtoClient } = await import('./renamer');
    const { Api } = await import('telegram');
    const mtClient = await initMTProtoClient();
    if (mtClient) {
      await mtClient.invoke(
        new Api.messages.SendReaction({
          peer: chatId,
          msgId: messageId,
          reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
          big: isBig,
          addToRecent: true,
        })
      );
      mtSuccess = true;
      logger.info({ chatId, messageId, emoji, isBig }, '✨ Native MTProto big reaction applied successfully');
    }
  } catch (mtErr: any) {
    logger.debug({ err: mtErr?.message, chatId, messageId }, 'MTProto reaction attempt failed, falling back to Bot API');
  }

  if (mtSuccess) return;

  // 2. Fallback: Telegram Bot API with strict boolean is_big
  try {
    if (typeof telegram.callApi === 'function') {
      await (telegram as any).callApi('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
        is_big: Boolean(isBig),
      });
      logger.info({ chatId, messageId, emoji }, 'Bot API reaction applied');
    } else if (typeof telegram.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }], Boolean(isBig));
      logger.info({ chatId, messageId, emoji }, 'Bot API reaction applied');
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, chatId, messageId }, 'Reaction call skipped or failed');
  }
}
