import { bot, getAdminId } from '../client';
import * as db from '../database';
import { pino } from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

export function registerSearch() {
  // Manual /search command
  bot.command('search', async (ctx) => {
    const query = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!query) {
      return ctx.reply('🤡 <b>Please provide a title to search for.</b> Example: <code>/search Inception</code>', { parse_mode: 'HTML' });
    }
    await performSearch(ctx, query);
  });

  // Global text handler for simple searches
  bot.on('text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    
    const query = ctx.message.text.trim();
    if (query.length < 2) return;
    
    db.upsertUser(ctx.from.id, ctx.from.username || undefined, ctx.from.first_name);
    db.addSearchHistory(ctx.from.id, query);
    await performSearch(ctx, query);
  });
  // Trending command
  bot.command('trending', async (ctx) => {
    await performSearch(ctx, ' ', 'movies', '🤡 Trending Movies');
    await performSearch(ctx, ' ', 'series', '🤡 Top Series');
  });

  // Help command
  bot.command('help', async (ctx) => {
    const helpMsg = 
      `🤡 <b>Vinehill Help Center</b>\n\n` +
      `<b>How to use:</b>\n` +
      `• Send any title to search (e.g. <code>Inception</code>)\n` +
      `• Use /search for advanced results\n` +
      `• Use /trending to see popular media\n\n` +
      `<b>Access:</b>\n` +
      `You must be joined to our channels to receive files. Files are automatically deleted after 5 minutes for security.\n\n` +
      `<b>Admin?</b> Contact @Owner for support.`;
    
    ctx.reply(helpMsg, { parse_mode: 'HTML' });
  });

  // Navigation callbacks
  bot.action('nav:start', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    // Feature: Recent Arrivals Preview
    const recent = db.getRecentlyAdded(3);
    let recentText = '';
    if (recent.length > 0) {
      recentText = `\n\n🤡 <b>New Arrivals:</b>\n` + recent.map(r => `• ${db.cleanTitle(r.title).toUpperCase()}${r.year ? ` (${r.year})` : ''}`).join('\n');
    }

    const welcomeMsg = 
      `🤡 <b>Welcome back to Vinehill!</b>\n\n` +
      `Your library is ready. What would you like to explore today?${recentText}`;
    const buttons = [
      [{ text: '🎬 Movies', callback_data: 'nav:movies' }, { text: '📺 Series', callback_data: 'nav:series' }, { text: '🍀 Anime', callback_data: 'nav:anime' }],
      [{ text: '🤡 Search Library', callback_data: 'nav:search' }, { text: '🤡 Trending', callback_data: 'nav:trending' }],
      [{ text: '🤡 My Favorites', callback_data: 'nav:favorites' }, { text: '🤡 My Profile', callback_data: 'nav:profile' }],
      [{ text: '🤡 Help & FAQ', callback_data: 'nav:help' }]
    ];
    await ctx.editMessageText(welcomeMsg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }).catch(() => {
      ctx.reply(welcomeMsg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    });
  });

  bot.action('nav:search', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const history = db.getSearchHistory(ctx.from.id);
    let msg = '🤡 <b>Search Library</b>\n\nJust send me the name of the movie or series you are looking for!\n\nOr browse by category:';
    
    const buttons = [
      [{ text: '🎬 Movies', callback_data: 'nav:movies' }, { text: '📺 Series', callback_data: 'nav:series' }, { text: '🍀 Anime', callback_data: 'nav:anime' }]
    ];
    
    if (history.length > 0) {
      msg += '\n\n<i>Recent searches:</i>';
      for (const h of history) {
        buttons.push([{ text: `🤡 ${h.query}`, callback_data: `q:${h.query}` }]);
      }
    }
    buttons.push([{ text: '🤡 Back', callback_data: 'nav:start' }]);

    ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }).catch(() => {
       ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    });
  });

  bot.action('nav:movies', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ' ', 'movies', '🤡 All Movies');
  });

  bot.action('nav:series', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ' ', 'series', '🤡 All Series');
  });

  bot.action('nav:anime', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ' ', 'anime', '🤡 All Anime');
  });

  bot.action(/^q:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ctx.match[1]);
  });
  
  bot.action('nav:trending', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ' ', 'movies', '🤡 Trending Movies');
    await performSearch(ctx, ' ', 'series', '🤡 Top Series');
  });

  bot.action('nav:help', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const helpMsg = 
      `🤡 <b>Vinehill Help Center</b>\n\n` +
      `<b>How to use:</b>\n` +
      `• Send any title to search (e.g. <code>Inception</code>)\n` +
      `• Use /search for advanced results\n` +
      `• Use /trending to see popular media\n\n` +
      `<b>Access:</b>\n` +
      `You must be joined to our channels to receive files. Files are automatically deleted after 5 minutes for security.`;
    
    ctx.reply(helpMsg, { parse_mode: 'HTML' });
  });

  bot.action('nav:top_movies', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ' ', 'movies', '🤡 Trending Movies');
  });

  bot.action('nav:top_series', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await performSearch(ctx, ' ', 'series', '🤡 Top Series');
  });

  bot.action('nav:admin', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id.toString() !== getAdminId()) return;
    const stats = db.getStats();
    await ctx.editMessageText(
      `⚙️ <b>Admin Dashboard</b>\n\n` +
      `📦 Items: ${stats.totalFiles}\n` +
      `👤 Users: ${stats.totalUsers}\n` +
      `🚩 Reports: ${stats.totalReports}\n\n` +
      `Use the buttons below to manage the library.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚩 View Reports', callback_data: 'adm:reports' }],
            [{ text: '🔧 Repair Library Titles', callback_data: 'adm:repair' }],
            [{ text: '🔄 Global Re-Announce', callback_data: 'adm:reindex' }],
            [{ text: '🗑️ Mass Delete (Manual)', callback_data: 'nav:search' }],
            [{ text: '⬅️ Back', callback_data: 'nav:start' }]
          ]
        }
      }
    ).catch((e) => {
      ctx.reply(
        `⚙️ <b>Admin Dashboard</b>\n\n` +
        `📦 Items: ${stats.totalFiles}\n` +
        `👤 Users: ${stats.totalUsers}\n` +
        `🚩 Reports: ${stats.totalReports}\n\n` +
        `Use the buttons below to manage the library.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚩 View Reports', callback_data: 'adm:reports' }],
              [{ text: '🔄 Global Re-Index', callback_data: 'adm:reindex' }],
              [{ text: '🗑️ Mass Delete (Manual)', callback_data: 'nav:search' }],
              [{ text: '⬅️ Back', callback_data: 'nav:start' }]
            ]
          }
        }
      );
    });
  });

  bot.action('adm:reports', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const reports = db.getRecentReports(10);
    
    if (reports.length === 0) {
      return ctx.answerCbQuery('✅ No pending reports.');
    }

    let msg = '🚩 <b>Pending Reports</b>\n\n';
    const buttons = [];

    for (const r of reports) {
      const payload = Buffer.from(`${r.category}:${r.title}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      msg += `• <b>${db.cleanTitle(r.title)}</b> (${r.category})\n  Reports: ${r.report_count}\n\n`;
      buttons.push([{ text: `🗑️ Delete: ${db.cleanTitle(r.title).substring(0, 20)}...`, callback_data: `adm_del_conf:${payload}` }]);
    }
    
    buttons.push([{ text: '⬅️ Back to Dashboard', callback_data: 'nav:admin' }]);

    await ctx.editMessageText(msg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => {});
  });

  bot.action('adm:reindex', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    await ctx.answerCbQuery('🔄 Re-announcement started...');
    const { reannounceAll } = await import('./announcer');
    await reannounceAll(ctx);
  });

  bot.action('adm:repair', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    await ctx.answerCbQuery('🔧 Starting Repair...');
    
    const statusMsg = await ctx.reply('⏳ <b>Repairing Library Metadata...</b>\nThis involves TMDB lookups and title unification. Please wait.', { parse_mode: 'HTML' });
    
    try {
      const count = await db.repairTitles();
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, 
        `✅ <b>Repair Complete!</b>\n\nNormalized metadata for ${count} files using TMDB ID unification.\n\n<b>Important:</b> You should now perform a <b>"Global Re-Announce"</b> to update existing channel posts with the fixed titles.`, 
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      await ctx.reply('❌ <b>Repair Failed:</b> ' + (error as any).message, { parse_mode: 'HTML' });
    }
  });
}

async function performSearch(ctx: any, query: string, forceCategory?: string, customTitle?: string) {
  try {
    const limit = 15;
    let results: any[] = [];
    
    if (forceCategory) {
      const stmt = db.db.prepare(`
        SELECT f.title, f.category, f.year, f.rating, COUNT(l.user_id) as likes,
               (SELECT COUNT(*) FROM reports WHERE title = f.title AND category = f.category) as report_count
        FROM files f
        LEFT JOIN likes l ON f.title = l.title AND f.category = l.category
        WHERE f.category = ? AND f.file_id IS NOT NULL AND f.file_id != ''
        GROUP BY f.title, f.category
        HAVING report_count < 3
        ORDER BY f.rating DESC, likes DESC
        LIMIT ?
      `);
      results = stmt.all(forceCategory, limit) as any[];
    } else {
      const stmt = db.db.prepare(`
        SELECT f.title, f.category, f.year, f.rating, COUNT(l.user_id) as likes,
               (SELECT COUNT(*) FROM reports WHERE title = f.title AND category = f.category) as report_count
        FROM files f
        LEFT JOIN likes l ON f.title = l.title AND f.category = l.category
        WHERE f.title LIKE ? AND f.file_id IS NOT NULL AND f.file_id != ''
        GROUP BY f.title, f.category
        HAVING report_count < 3
        ORDER BY likes DESC, f.rating DESC
        LIMIT ?
      `);
      results = stmt.all(`%${query}%`, limit) as any[];
    }

    if (results.length === 0) {
      return ctx.reply('🤡 <b>No results found.</b>\n\nTry searching with a different keyword or check back later!', { parse_mode: 'HTML' });
    }

    const buttons = results.map(r => {
      const cleaned = db.cleanTitle(r.title);
      const payloadString = `${r.category}:${r.title}`;
      const payload = Buffer.from(payloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const yearPart = r.year ? ` (${r.year})` : '';
      const categoryEmoji = '🤡';
      const rating = r.rating ? ` [🤡 ${r.rating}]` : '';
      
      return [{
        text: `${categoryEmoji} ${cleaned.toUpperCase()}${yearPart}${rating}`,
        url: `https://t.me/${bot.botInfo?.username}?start=${payload}`
      }];
    });

    const header = customTitle || `🤡 Search results for: "<b>${query}</b>"`;
    await ctx.reply(header, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (error) {
    logger.error(`Search failed: ${error}`);
    ctx.reply('🤡 <b>Search temporarily unavailable.</b>', { parse_mode: 'HTML' });
  }
}
