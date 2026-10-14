import { bot, getAdminId } from '../client';
import { reannounceAll, wipeAllPublicChannels } from './announcer';
import { pino } from 'pino';
import * as db from '../database';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

export function registerAdmin() {
  bot.command('flash', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    
    const confirmation = ctx.payload.trim();
    if (confirmation !== 'NOW') {
      return ctx.reply('⚠️ <b>CRITICAL WARNING</b> ⚠️\n\nThis command will <b>DELETE EVERYTHING</b>:\n1. Every message in all public channels.\n2. All indexed files and data in the database.\n3. All users, likes, and reports.\n\nTo proceed, type: <code>/flash NOW</code>', { parse_mode: 'HTML' });
    }

    const msg = await ctx.reply('🚀 <b>FLASH WIPED INITIATED...</b>\n\n1. Wiping Channels...\n2. Clearing Database...', { parse_mode: 'HTML' });

    try {
      // 1. Wipe Channels
      await wipeAllPublicChannels(ctx);
      
      // 2. Wipe Database
      db.flashWipeDatabase();

      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, '💥 <b>FLASH COMPLETE</b>\n\nAll channels cleared. Database reset to factory settings.', { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`Flash wipe failed: ${err}`);
      ctx.reply(`❌ <b>ERROR:</b> Flash wipe failed mid-process. Some data may be partially removed.\n\n<code>${err}</code>`, { parse_mode: 'HTML' });
    }
  });

  bot.command('setadmin', async (ctx) => {
    const currentAdminId = getAdminId();
    if (ctx.from.id.toString() !== currentAdminId) {
      return ctx.reply('Forbidden.');
    }
    
    const newAdminId = ctx.payload.trim();
    if (!newAdminId || !/^\d+$/.test(newAdminId)) {
      return ctx.reply('Usage: /setadmin <user_id>');
    }
    
    db.setConfig('ADMIN_ID', newAdminId);
    ctx.reply(`✅ <b>Admin ID updated!</b>\n\nNew Admin: <code>${newAdminId}</code>\n\n<i>Note: You may lose access if this is not your ID.</i>`, { parse_mode: 'HTML' });
  });

  bot.command('reannounce', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) {
      return ctx.reply('Forbidden.');
    }
    
    try {
      await reannounceAll(ctx);
    } catch (error) {
      logger.error(`Reannounce command failed: ${error}`);
      ctx.reply('An error occurred during re-announcement.');
    }
  });

  bot.command('sync', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const { syncAnnouncements } = await import('./announcer');
    await syncAnnouncements(ctx);
  });

  bot.command('cloudsync', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const msg = await ctx.reply('🚀 <b>Initiating Cloud Sync...</b>\n\nMoving indices to Firestore...', { parse_mode: 'HTML' });
    
    try {
      const { syncSqliteToFirestore } = await import('../../services/firebaseService');
      const { db: localDb } = await import('../database');
      await syncSqliteToFirestore(localDb);
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, '✅ <b>Cloud Sync Complete</b>\n\nAll existing indices and announcements are now persistent in Firestore.', { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`Cloud sync failed: ${err}`);
      ctx.reply(`❌ <b>Cloud Sync Failed:</b> ${err}`);
    }
  });

  bot.command('repair', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const statusMsg = await ctx.reply('⏳ <b>Repairing Metadata...</b>\n\nRe-parsing filenames and syncing with TMDB...', { parse_mode: 'HTML' });
    
    try {
      const repairedCount = await db.repairTitles();
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, `✅ <b>Repair Complete</b>\n\nProcessed <b>${repairedCount}</b> items. Titles and metadata unified using TMDB.`, { parse_mode: 'HTML' });
    } catch (err) {
      logger.error(`Repair failed: ${err}`);
      ctx.reply('❌ Repair task failed.');
    }
  });

  bot.command('scan', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const parts = ctx.payload.split(' ');
    const category = parts[0];
    const limit = parseInt(parts[1]) || 100;
    
    if (!['movies', 'series', 'anime', 'games'].includes(category)) {
      return ctx.reply('Usage: /scan <category> [limit]\n\nCategories: movies, series, anime, games');
    }
    
    const { scanChannel } = await import('./indexer');
    await scanChannel(ctx, category, limit);
  });

  bot.command('stats', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    
    const { getStats } = await import('../database');
    const stats = getStats();
    
    if (!stats) {
      return ctx.reply('❌ <b>Error:</b> Failed to fetch database statistics.', { parse_mode: 'HTML' });
    }
    
    ctx.reply(
      `📊 <b>🤡 Vinehill Admin Stats</b>\n\n` +
      `📦 <b>Total Files:</b> ${stats.totalFiles}\n` +
      `👥 <b>Total Users:</b> ${stats.totalUsers}\n` +
      `📈 <b>Today's Requests:</b> ${stats.todayRequests}\n` +
      `❤️ <b>Total Likes:</b> ${stats.totalLikes}\n\n` +
      `🎬 <b>Movies:</b> ${stats.movies}\n` +
      `📺 <b>Series:</b> ${stats.series}\n` +
      `🍜 <b>Anime:</b> ${stats.anime}\n` +
      `🎮 <b>Games:</b> ${stats.games}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  bot.command('broadcast', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const msg = ctx.payload;
    if (!msg) return ctx.reply('Usage: /broadcast <message>');
    
    const { getAllUserIds } = await import('../database');
    const userIds = getAllUserIds();
    ctx.reply(`📢 <b>🤡 Starting Broadcast...</b>\n\nTargeting <b>${userIds.length}</b> users.`, { parse_mode: 'HTML' });
    
    let success = 0;
    let failed = 0;
    
    for (const id of userIds) {
      try {
        await ctx.telegram.sendMessage(id, `📢 <b>🤡 ANNOUNCEMENT</b>\n\n${msg}`, { parse_mode: 'HTML' });
        success++;
      } catch (err) {
        failed++;
      }
      if (success % 20 === 0) await new Promise(r => setTimeout(r, 1000));
    }
    
    ctx.reply(`🏁 <b>🤡 Broadcast Finished</b>\n\n✅ Success: ${success}\n❌ Failed: ${failed}`, { parse_mode: 'HTML' });
  });
  
  bot.command('checkgaps', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    
    const db = await import('../database');
    const series = db.db.prepare("SELECT DISTINCT title, category FROM files WHERE category IN ('series', 'anime')").all() as { title: string, category: string }[];
    
    if (series.length === 0) return ctx.reply('No series or anime found to check.');
    
    let report = '⚠️ <b>Missing Episodes Report</b>\n\n';
    let foundGaps = false;

    for (const item of series) {
      const gaps = db.checkSeriesGaps(item.title, item.category);
      if (gaps.length > 0) {
        foundGaps = true;
        report += `• <b>${item.title}</b> (${item.category})\n`;
        for (const g of gaps) {
          report += `  Season ${g.season}: ${g.missing.join(', ')}\n`;
        }
        report += '\n';
      }
      
      // Split large messages
      if (report.length > 3500) {
        await ctx.reply(report, { parse_mode: 'HTML' });
        report = '';
      }
    }

    if (!foundGaps) {
      ctx.reply('✅ No missing episodes found in any series or anime.');
    } else if (report.length > 0) {
      ctx.reply(report, { parse_mode: 'HTML' });
    }
  });

  bot.command('delete', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const query = ctx.payload;
    if (!query) return ctx.reply('🤡 Usage: /delete <query>');

    const db = await import('../database');
    const results = db.db.prepare("SELECT title, category, year FROM files WHERE title LIKE ? GROUP BY title, category LIMIT 10").all(`%${query}%`) as any[];

    if (results.length === 0) return ctx.reply('🤡 No matches found to delete.');

    const buttons = results.map(r => {
      const payload = Buffer.from(`${r.category}:${r.title}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return [{ text: `🗑️ ${r.title} (${r.category})`, callback_data: `adm_del_conf:${payload}` }];
    });

    ctx.reply(`🤡 <b>Select media to DELETE PERMANENTLY:</b>\n\nThis will remove it from the DB and attempt to delete channel posts.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  });

  bot.action(/^adm_del_conf:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id.toString() !== getAdminId()) return;
    
    const sanitized = ctx.match[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = Buffer.from(sanitized, 'base64').toString('utf8');
    
    const firstColon = payload.indexOf(':');
    if (firstColon === -1) return ctx.answerCbQuery('Invalid Data');
    
    const category = payload.substring(0, firstColon);
    const title = payload.substring(firstColon + 1);

    const db = await import('../database');
    const announcer = await import('./announcer');

    // 1. Delete from channels
    await announcer.deleteAnnouncementsByTitle(title, category);

    // 2. Delete from DB
    db.deleteMediaByTitle(title, category);

    await ctx.answerCbQuery('✅ Media Deleted Permanently');
    await ctx.editMessageText(`🤡 <b>Deleted Successfully</b>\n\n<b>Title:</b> ${title}\n<b>Category:</b> ${category}`, { parse_mode: 'HTML' });
  });

  bot.command('purge', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const db = await import('../database');
    const result = db.purgeEmptyFiles();
    ctx.reply(`🤡 <b>Purge Complete</b>\n\nRemoved <b>${result.changes}</b> orphaned file entries.`, { parse_mode: 'HTML' });
  });

  bot.command('deletelink', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const input = ctx.payload;
    if (!input) return ctx.reply('🤡 Usage: /deletelink <link_or_code>');

    let encodedPayload = input.trim();
    if (input.includes('?start=')) {
      encodedPayload = input.split('?start=')[1].split('&')[0];
    }

    try {
      const sanitized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
      const payload = Buffer.from(sanitized, 'base64').toString('utf8');
      
      const firstColon = payload.indexOf(':');
      if (firstColon === -1) return ctx.reply('🤡 <b>Invalid link payload.</b>', { parse_mode: 'HTML' });
      
      const category = payload.substring(0, firstColon);
      const title = payload.substring(firstColon + 1);

      const db = await import('../database');
      const announcer = await import('./announcer');

      // 1. Delete from channels
      await announcer.deleteAnnouncementsByTitle(title, category);

      // 2. Delete from DB
      db.deleteMediaByTitle(title, category);

      ctx.reply(`✅ <b>Media Deleted via Link</b>\n\n<b>Title:</b> ${title}\n<b>Category:</b> ${category}`, { parse_mode: 'HTML' });
    } catch (e) {
      ctx.reply('❌ <b>Error:</b> Failed to decode or delete the link provided.', { parse_mode: 'HTML' });
    }
  });

  // Helper for force-sub state
  function isForceSubEnabled(): boolean {
    const val = db.getConfig('FORCE_SUB_ENABLED');
    return val !== 'false' && val !== 'off';
  }

  function getDashboardView() {
    const isEnabled = isForceSubEnabled();
    const mainChan = process.env.CH_MAIN || '@VinehillMain';
    const stats = db.getStats();

    const text = 
      `⚙️ 🤡 <b>Vinehill Admin Dashboard</b>\n\n` +
      `📢 <b>Joined Channel Check:</b> ${isEnabled ? '🟢 <b>ENABLED</b> (Main Channel Only)' : '🔴 <b>DISABLED</b> (Open / Free Access)'}\n` +
      `🎯 <b>Main Channel:</b> <code>${mainChan}</code>\n` +
      `📦 <b>Total Files in Library:</b> ${stats?.totalFiles ?? 'N/A'}\n` +
      `👥 <b>Total Registered Users:</b> ${stats?.totalUsers ?? 'N/A'}\n\n` +
      `<i>Use the buttons below to toggle channel checks or manage library tasks:</i>`;

    const buttons = [
      [{ text: `📢 Channel Check: ${isEnabled ? '🟢 ENABLED (Click to Turn OFF)' : '🔴 DISABLED (Click to Turn ON)'}`, callback_data: 'adm_toggle_forcesub' }],
      [
        { text: '📊 Full Stats', callback_data: 'adm:stats' },
        { text: '🔄 Sync Announcements', callback_data: 'adm:sync' }
      ],
      [
        { text: '🧹 Purge Orphaned Files', callback_data: 'adm:purge' },
        { text: '❌ Close Dashboard', callback_data: 'adm:close' }
      ]
    ];

    return { text, buttons };
  }

  // /admin command & nav:admin callback
  bot.command('admin', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const { text, buttons } = getDashboardView();
    ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
  });

  bot.action('nav:admin', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id.toString() !== getAdminId()) return;
    const { text, buttons } = getDashboardView();
    ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }).catch(() => {
      ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    });
  });

  // Toggle Force-Sub Action
  bot.action('adm_toggle_forcesub', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) {
      return ctx.answerCbQuery('Forbidden', { show_alert: true });
    }
    const current = isForceSubEnabled();
    const nextVal = current ? 'false' : 'true';
    db.setConfig('FORCE_SUB_ENABLED', nextVal);
    
    const nextStateStr = nextVal === 'true' ? '🟢 ENABLED' : '🔴 DISABLED';
    await ctx.answerCbQuery(`Channel Check is now ${nextStateStr}!`, { show_alert: true });

    const { text, buttons } = getDashboardView();
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => {});
  });

  // /forcesub & /checkchannel commands
  bot.command(['forcesub', 'checkchannel'], async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const arg = ctx.payload.trim().toLowerCase();
    let isEnabled = isForceSubEnabled();

    if (arg === 'on' || arg === 'enable' || arg === 'true') {
      db.setConfig('FORCE_SUB_ENABLED', 'true');
      isEnabled = true;
    } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
      db.setConfig('FORCE_SUB_ENABLED', 'false');
      isEnabled = false;
    } else if (arg === 'toggle') {
      const next = isEnabled ? 'false' : 'true';
      db.setConfig('FORCE_SUB_ENABLED', next);
      isEnabled = !isEnabled;
    }

    const { text, buttons } = getDashboardView();
    return ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  });

  // Dashboard quick actions
  bot.action('adm:stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id.toString() !== getAdminId()) return;
    const stats = db.getStats();
    if (!stats) return ctx.reply('Error loading stats.');
    
    ctx.reply(
      `📊 <b>🤡 Vinehill Admin Stats</b>\n\n` +
      `📦 <b>Total Files:</b> ${stats.totalFiles}\n` +
      `👥 <b>Total Users:</b> ${stats.totalUsers}\n` +
      `📈 <b>Today's Requests:</b> ${stats.todayRequests}\n` +
      `❤️ <b>Total Likes:</b> ${stats.totalLikes}\n\n` +
      `🎬 <b>Movies:</b> ${stats.movies}\n` +
      `📺 <b>Series:</b> ${stats.series}\n` +
      `🍜 <b>Anime:</b> ${stats.anime}\n` +
      `🎮 <b>Games:</b> ${stats.games}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  bot.action('adm:sync', async (ctx) => {
    await ctx.answerCbQuery('Starting announcement sync...').catch(() => {});
    if (ctx.from.id.toString() !== getAdminId()) return;
    const { syncAnnouncements } = await import('./announcer');
    await syncAnnouncements(ctx);
  });

  bot.action('adm:purge', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (ctx.from.id.toString() !== getAdminId()) return;
    const result = db.purgeEmptyFiles();
    ctx.reply(`🤡 <b>Purge Complete</b>\n\nRemoved <b>${result.changes}</b> orphaned file entries.`, { parse_mode: 'HTML' });
  });

  bot.action('adm:close', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  });
}
