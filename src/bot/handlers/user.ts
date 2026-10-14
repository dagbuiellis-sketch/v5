import { Telegraf } from 'telegraf';
import * as db from '../database';
import { getAdminId } from '../client';

export function registerUserHandlers(bot: Telegraf<any>) {
  // Favorites Menu
  bot.action('nav:favorites', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const favorites = db.getFavorites(userId);

    if (favorites.length === 0) {
      return ctx.editMessageText(
        '🤡 <b>Your Favorites</b>\n\n' +
        'You haven\'t added any favorites yet. Use the 🤡 button on any movie or series to save it here!',
        { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🤡 Back to Menu', callback_data: 'nav:start' }]]
          }
        }
      ).catch(() => ctx.reply('🤡 Your Favorites is empty.'));
    }

    const buttons: any[][] = favorites.map(f => {
      const payloadString = `${f.category}:${f.title}`;
      const payload = Buffer.from(payloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const displayTitle = db.cleanTitle(f.title);
      const categoryEmoji = '🤡';
      return [{
        text: `${categoryEmoji} ${displayTitle.toUpperCase()}`,
        url: `https://t.me/${bot.botInfo?.username}?start=${payload}`
      }];
    });

    buttons.push([{ text: '🤡 Back to Menu', callback_data: 'nav:start' }]);

    await ctx.editMessageText('🤡 <b>Your Favorite Content</b>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => {});
  });

  // Toggle Favorite Action
  bot.action(/^fav:(.+)$/, async (ctx) => {
    const payload = ctx.match[1];
    try {
      const sanitized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decodedPayload = Buffer.from(sanitized, 'base64').toString('utf8');
      
      const firstColon = decodedPayload.indexOf(':');
      if (firstColon === -1) return ctx.answerCbQuery('Invalid Data');
      
      const category = decodedPayload.substring(0, firstColon);
      const title = decodedPayload.substring(firstColon + 1);
      
      const isAdded = db.toggleFavorite(ctx.from.id, title, category);
      await ctx.answerCbQuery(isAdded ? '🤡 Added to Favorites' : '🤡 Removed from Favorites');
      
      // Update the message keyboard to reflect the change
      const message = ctx.callbackQuery.message as any;
      if (!message || !message.reply_markup) return;
      
      const keyboard = message.reply_markup.inline_keyboard;
      const callbackData = (ctx.callbackQuery as any).data;
      
      const newKeyboard = keyboard.map((row: any[]) => row.map((btn: any) => {
        if (btn.callback_data === callbackData) {
          return { ...btn, text: isAdded ? '🤡 Unfavorite' : '🤡 Favorite' };
        }
        return btn;
      }));
      
      await ctx.editMessageReplyMarkup({ inline_keyboard: newKeyboard }).catch(() => {});
    } catch (e) {
      await ctx.answerCbQuery('Error toggling favorite');
    }
  });

  // Toggle Like Action
  bot.action(/^like:(.+)$/, async (ctx) => {
    const payload = ctx.match[1];
    try {
      const sanitized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decodedPayload = Buffer.from(sanitized, 'base64').toString('utf8');
      
      const firstColon = decodedPayload.indexOf(':');
      if (firstColon === -1) return ctx.answerCbQuery('Invalid Data');
      
      const category = decodedPayload.substring(0, firstColon);
      const title = decodedPayload.substring(firstColon + 1);
      
      const isLiked = db.toggleLike(ctx.from.id, title, category);
      const newCount = db.getLikeCount(title, category);
      await ctx.answerCbQuery(isLiked ? '🤡 Liked!' : '💔 Unliked');
      
      const message = ctx.callbackQuery.message as any;
      if (!message || !message.reply_markup) return;

      const keyboard = message.reply_markup.inline_keyboard;
      const callbackData = (ctx.callbackQuery as any).data;
      
      const newKeyboard = keyboard.map((row: any[]) => row.map((btn: any) => {
        if (btn.callback_data === callbackData) {
          return { ...btn, text: `🤡 ${newCount}` };
        }
        return btn;
      }));
      
      await ctx.editMessageReplyMarkup({ inline_keyboard: newKeyboard }).catch(() => {});
    } catch (e) {
       await ctx.answerCbQuery('Error liking message');
    }
  });

  // Report Broken Media Action
  bot.action(/^rpt:(.+)$/, async (ctx) => {
    const payload = ctx.match[1];
    try {
      const sanitized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decodedPayload = Buffer.from(sanitized, 'base64').toString('utf8');
      
      const firstColon = decodedPayload.indexOf(':');
      if (firstColon === -1) return ctx.answerCbQuery('Invalid Data');
      
      const category = decodedPayload.substring(0, firstColon);
      const title = decodedPayload.substring(firstColon + 1);
      
      db.reportMedia(ctx.from.id, title, category);
      const reportCount = db.getReportCount(title, category);
      
      await ctx.answerCbQuery('🚩 Reported to Admin. Thanks!');

      // Notify Admin
      const adminId = getAdminId();
      if (adminId) {
        const delPayload = Buffer.from(`${category}:${title}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const alertMsg = 
          `🚩 <b>Broken Media Report</b>\n\n` +
          `Title: <b>${db.cleanTitle(title)}</b>\n` +
          `Category: <b>${category}</b>\n` +
          `Reports: <b>${reportCount}</b>\n` +
          `Reported by: <i>${ctx.from.first_name}</i> (@${ctx.from.username || 'N/A'})\n\n` +
          `Check if the file is still functional.`;
          
        await ctx.telegram.sendMessage(adminId, alertMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🗑️ Delete Now (Admin)', callback_data: `adm_del_conf:${delPayload}` }],
              [{ text: '🔎 Search it', url: `https://t.me/${bot.botInfo?.username}?start=${payload}` }]
            ]
          }
        }).catch(() => {});
      }
    } catch (e) {
      await ctx.answerCbQuery('Error reporting content');
    }
  });

  // Request Command
  bot.command('request', async (ctx) => {
    const query = ctx.payload;
    if (!query) {
      return ctx.reply('🤡 <b>How to Request:</b>\n\nUse /request followed by the movie or series title.\nExample: <code>/request Spider-Man</code>', { parse_mode: 'HTML' });
    }
    
    db.saveRequest(ctx.from.id, query);
    ctx.reply(`🤡 <b>Request Received!</b>\n\nWe have added "<b>${query}</b>" to our tracking list. Our team will notify everyone once it's available.`, { parse_mode: 'HTML' });
  });

  // Profile Menu
  bot.action('nav:profile', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;
    const favorites = db.getFavorites(userId).length;
    
    const profileMsg = 
      `🤡 <b>Your Vinehill Profile</b>\n\n` +
      `🤡 ID: <code>${userId}</code>\n` +
      `🤡 Favorites: <b>${favorites}</b>\n` +
      `🤡 Joined: <i>${ctx.from.username || 'Anonymous'}</i>\n\n` +
      `Keep searching and liking to help us improve the library!`;

    await ctx.editMessageText(profileMsg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🤡 Back to Menu', callback_data: 'nav:start' }]]
      }
    }).catch(() => {});
  });
}
