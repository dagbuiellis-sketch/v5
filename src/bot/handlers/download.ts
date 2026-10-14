import { bot, getAdminId } from '../client';
import * as db from '../database';
import { pino } from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const PUBLIC_CHANNELS: Record<string, string> = {
  main: process.env.CH_MAIN || '',
  movies: process.env.CH_MOVIES || '',
  series: process.env.CH_SERIES || '',
  anime: process.env.CH_ANIME || '',
  games: process.env.CH_GAMES || '',
  music: process.env.CH_MUSIC || '',
};

export function registerDownload() {
  // Deep link handler
  bot.start(async (ctx) => {
    const payload = ctx.payload;
    const userId = ctx.from.id;
    
    // Track user
    db.upsertUser(userId, ctx.from.username || undefined, ctx.from.first_name);

    if (!payload || payload.trim() === '') {
      // Feature: Recent Arrivals Preview
      const recent = db.getRecentlyAdded(3);
      let recentText = '';
      if (recent.length > 0) {
        recentText = `\n\n🤡 <b>New Arrivals:</b>\n` + recent.map(r => `• ${db.cleanTitle(r.title).toUpperCase()}${r.year ? ` (${r.year})` : ''}`).join('\n');
      }

      const welcomeMsg = 
        `🤡 <b>Welcome to Vinehill!</b>\n\n` +
        `I am your personal library for Movies, Series, Anime, and more.\n\n` +
        `🔎 <b>How to find files:</b>\n` +
        `1. Simply <b>type the name</b> of a movie/series.\n` +
        `2. Use the <b>/search</b> command.\n` +
        `3. Use <b>/trending</b> to see what's hot.${recentText}\n\n` +
        `<i>Start by searching for your favorite title!</i>`;

      const buttons = [
        [{ text: '🎬 Movies', callback_data: 'nav:movies' }, { text: '📺 Series', callback_data: 'nav:series' }, { text: '🍀 Anime', callback_data: 'nav:anime' }],
        [{ text: '🤡 Search Library', callback_data: 'nav:search' }, { text: '🤡 Trending', callback_data: 'nav:trending' }],
        [{ text: '🤡 My Favorites', callback_data: 'nav:favorites' }, { text: '🤡 My Profile', callback_data: 'nav:profile' }],
        [{ text: '🤡 Help & FAQ', callback_data: 'nav:help' }, { text: '📢 Main Channel', url: `https://t.me/${PUBLIC_CHANNELS.main.replace('@', '')}` }]
      ];

      // Add admin panel button if applicable
      if (ctx.from.id.toString() === getAdminId()) {
        buttons.push([{ text: '⚙️ Admin Dashboard', callback_data: 'nav:admin' }]);
        ctx.reply('🤡 <b>Admin Mode Active</b>\n\nYour management commands have been updated in the menu!', { parse_mode: 'HTML' });
      }

      return ctx.reply(welcomeMsg, { 
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons }
      });
    }

    // Check membership
    const missing = await checkMembership(ctx, userId);
    if (missing.length > 0) {
      return showJoinRequired(ctx, missing, payload);
    }

    // Deliver files
    await deliverFiles(ctx, payload);
  });

  // Callback for "I've Joined All"
  bot.action(/^chk:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const payload = ctx.match[1];
    const userId = ctx.from.id;
    
    const missing = await checkMembership(ctx, userId);
    if (missing.length > 0) {
      return ctx.answerCbQuery(`Still missing channels: ${missing.length}`, { show_alert: true });
    }

    await ctx.deleteMessage().catch(() => {});
    await deliverFiles(ctx, payload);
  });

  // Callback for "Request Again"
  bot.action(/^ra:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const payload = ctx.match[1];
    await ctx.deleteMessage().catch(() => {});
    await deliverFiles(ctx, payload);
  });

  // Callback for selecting a season
  bot.action(/^sel_s:([^:]+):([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const category = ctx.match[1];
    const season = parseInt(ctx.match[2]);
    const encodedPayload = ctx.match[3];
    const sanitized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const payload = Buffer.from(sanitized, 'base64').toString('ascii');
    const [_, title] = payload.split(':');

    await showEpisodePicker(ctx, title, season, category, encodedPayload);
  });

  // Callback for selecting an episode or downloading all
  bot.action(/^ep:([^:]+):([^:]+):([^:]+):(.+)$/, async (ctx) => {
    const action = ctx.match[1]; // 'one' or 'all'
    const category = ctx.match[2];
    const encodedPayload = ctx.match[4];
    const params = ctx.match[3].split(','); // [season, episode]

    await ctx.answerCbQuery(action === 'all' ? '🚀 Preparing Season Batch...' : '🍿 Fetching Episode...');

    const sanitized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const payload = Buffer.from(sanitized, 'base64').toString('ascii');
    const [_, title] = payload.split(':');

    if (action === 'all') {
      const season = parseInt(params[0]);
      await sendMediaBatch(ctx, db.getSeasonFiles(title, season, category), encodedPayload);
    } else {
      const season = parseInt(params[0]);
      const episode = parseInt(params[1]);
      const files = db.db.prepare(`SELECT * FROM files WHERE title = ? AND season = ? AND episode = ? AND category = ? AND file_id != ''`).all(title, season, episode, category);
      await sendMediaBatch(ctx, files, encodedPayload);
    }
  });
}

async function checkMembership(ctx: any, userId: number): Promise<string[]> {
  const missing: string[] = [];
  for (const [key, channel] of Object.entries(PUBLIC_CHANNELS)) {
    if (!channel) continue;
    try {
      const member = await ctx.telegram.getChatMember(channel, userId);
      if (['left', 'kicked', 'restricted'].includes(member.status)) {
        missing.push(key);
      }
    } catch (e) {
      logger.error({ err: e, channel }, 'Error checking membership');
      // If channel is private or inaccessible, skip
    }
  }
  return missing;
}

function showJoinRequired(ctx: any, missing: string[], payload: string) {
  const keyboard: any[][] = missing.map(key => ([{
    text: `🤡 Join ${key.toUpperCase()}`,
    url: `https://t.me/${PUBLIC_CHANNELS[key].replace('@', '')}`
  }]));

  keyboard.push([{
    text: "🤡 I've Joined All",
    callback_data: `chk:${payload}`
  }]);

  return ctx.reply('<b>🤡 Access Required</b>\n\nYou must join our channels to receive files.', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function deliverFiles(ctx: any, encodedPayload: string, skipCheck = false) {
  const chat_id = ctx.chat.id;
  const user_id = ctx.from.id;

  try {
    const sanitized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const payload = Buffer.from(sanitized, 'base64').toString('utf8');
    
    const firstColon = payload.indexOf(':');
    if (firstColon === -1) return ctx.reply('🤡 <b>Invalid request payload.</b>', { parse_mode: 'HTML' });
    
    const category = payload.substring(0, firstColon);
    const title = payload.substring(firstColon + 1);
    
    if (['series', 'anime'].includes(category)) {
      const seasons = db.getSeriesSeasons(title, category);
      if (seasons.length === 0) {
        return ctx.reply('🤡 <b>No episodes found for this title.</b>', { parse_mode: 'HTML' });
      }
      
      // Always show season picker if it's series/anime, to allow episode-level choice
      await showSeasonPicker(ctx, title, seasons, category, encodedPayload);
    } else if (category === 'movies') {
      await sendMediaBatch(ctx, db.getMoviesByTitle(title), encodedPayload);
    } else if (category === 'games') {
      await sendMediaBatch(ctx, db.getGameFiles(title), encodedPayload);
    } else {
      ctx.reply('Unknown category.');
    }

  } catch (error) {
    logger.error(`Delivery failed: ${error}`);
    ctx.reply('Error delivering files.');
  }
}

async function showEpisodePicker(ctx: any, title: string, season: number, category: string, encodedPayload: string) {
  const episodes = db.getSeasonFiles(title, season, category);
  const buttons = [];
  let row = [];

  for (const ep of episodes) {
    if (!ep.episode) continue;
    row.push({
      text: `Ep ${ep.episode}`,
      callback_data: `ep:one:${category}:${season},${ep.episode}:${encodedPayload}`
    });
    if (row.length === 4) {
      buttons.push(row);
      row = [];
    }
  }
  if (row.length > 0) buttons.push(row);

  buttons.push([{ text: '🚀 Download Full Season', callback_data: `ep:all:${category}:${season},0:${encodedPayload}` }]);
  buttons.push([{ text: '⬅️ Back to Seasons', callback_data: `chk:${encodedPayload}` }]);

  const cleanedTitle = db.cleanTitle(title);
  const msg = `📺 <b>${cleanedTitle.toUpperCase()}</b>\nSeason ${season}\n\nSelect an episode to download or get the full season:`;

  await ctx.editMessageText(msg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  }).catch(() => ctx.reply(msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }));
}
async function showSeasonPicker(ctx: any, title: string, seasons: number[], category: string, encodedPayload: string) {
  const buttons = [];
  let row = [];
  const cleanedTitle = db.cleanTitle(title);
  
  for (const s of seasons) {
    row.push({
      text: `Season ${s}`,
      callback_data: `sel_s:${category}:${s}:${encodedPayload}`
    });
    if (row.length === 2) { // Smaller rows for better mobile view
      buttons.push(row);
      row = [];
    }
  }
  if (row.length > 0) buttons.push(row);

  buttons.push([{ text: '🤡 Back to Search', callback_data: 'nav:search' }]);

  const messageText = `🤡 <b>${cleanedTitle.toUpperCase()}</b>\n\nThis is a <b>${category}</b>. Please select a season to view episodes:`;
  
  if (ctx.callbackQuery) {
    await ctx.editMessageText(messageText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    }).catch(() => ctx.reply(messageText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }));
  } else {
    await ctx.reply(messageText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  }
}

async function sendMediaBatch(ctx: any, files: any[], encodedPayload: string) {
  if (files.length === 0) {
    return ctx.reply('🤡 <b>No files found in our storage for this title.</b>', { parse_mode: 'HTML' });
  }

  const sentMsgIds: number[] = [];
  const warnMsg = await ctx.reply('🤡 <b>Fetching your requested files...</b>\n\nThese files will be <b>deleted in 5 minutes</b> for security. Forward them to your <b>Saved Messages</b> to keep them permanently!', { parse_mode: 'HTML' });
  sentMsgIds.push(warnMsg.message_id);

  for (const f of files) {
    try {
      const sizeMB = f.file_size ? (f.file_size / (1024 * 1024)).toFixed(1) + ' MB' : 'Unknown size';
      const yearPart = f.year ? ` (${f.year})` : '';
      const qualityPart = f.quality ? ` [${f.quality}]` : '';
      const episodePart = (f.season && f.episode) ? ` S${f.season.toString().padStart(2, '0')}E${f.episode.toString().padStart(2, '0')}` : '';
      const cleanedTitle = db.cleanTitle(f.title);

      const caption = 
        `🤡 <b>${cleanedTitle}${yearPart}</b>${episodePart}${qualityPart}\n\n` +
        `@VinehillBot`;

      const favPayloadString = `${f.category}:${f.title}`;
      const favPayload = Buffer.from(favPayloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const likeCount = db.getLikeCount(f.title, f.category);
      
      const inline_keyboard: any[][] = [
        [
          { text: `🤡 ${likeCount}`, callback_data: `like:${favPayload}` },
          { text: '🤡 Favorite', callback_data: `fav:${favPayload}` },
          { text: '🚩 Report', callback_data: `rpt:${favPayload}` }
        ]
      ];

      // Add Admin Delete Button
      if (ctx.from.id.toString() === getAdminId()) {
        const delPayload = Buffer.from(`${f.category}:${f.title}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        inline_keyboard.push([{ text: '🗑️ Delete Media (Admin)', callback_data: `adm_del_conf:${delPayload}` }]);
      }

      let sent: any = null;

      // 1. Primary delivery: If channel_id and message_id are available, copyMessage is the most robust
      if (f.channel_id && f.message_id) {
        try {
          sent = await ctx.telegram.copyMessage(ctx.from.id, f.channel_id, f.message_id, {
            caption,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
          });
        } catch (copyErr) {
          logger.warn({ copyErr, file: f.title }, 'copyMessage failed, falling back...');
        }
      }

      // 2. Secondary delivery: If file_id is a valid Bot API file_id (not a raw MTProto digits-only ID)
      if (!sent && f.file_id && !/^\d+$/.test(f.file_id)) {
        try {
          sent = await ctx.replyWithDocument(f.file_id, {
            caption,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard }
          });
        } catch (docErr) {
          logger.warn({ docErr, file: f.title }, 'replyWithDocument failed');
        }
      }

      // 3. Fallback for legacy raw MTProto document IDs (resolves existing files like VisionQuest in DB)
      if (!sent && (/^\d+$/.test(f.file_id) || !f.message_id)) {
        try {
          const { initMTProtoClient, RENAMED_CHANNELS } = await import('../renamer');
          const mtClient = await initMTProtoClient();
          const targetChan = f.channel_id || (RENAMED_CHANNELS as any)[f.category];
          if (mtClient && targetChan) {
            const msgs = await mtClient.getMessages(targetChan, { limit: 100 });
            const matched = msgs.find((m: any) => 
              (m.media?.document?.id?.toString() === f.file_id) || 
              (m.message && m.message.includes(db.cleanTitle(f.title)))
            );
            if (matched) {
              db.updateFileLocation(f.file_id, targetChan.toString(), matched.id);
              sent = await ctx.telegram.copyMessage(ctx.from.id, targetChan, matched.id, {
                caption,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard }
              });
            }
          }
        } catch (legacyErr) {
          logger.error({ legacyErr }, 'Legacy MTProto resolution failed');
        }
      }

      if (sent) {
        sentMsgIds.push(sent.message_id);
        await new Promise(r => setTimeout(r, 800)); // Respect rate limits
      } else {
        throw new Error('File delivery failed: media identifier could not be resolved');
      }
    } catch (error: any) {
      logger.error({ err: error, file_id: f.file_id, title: f.title }, 'File delivery failed');
      if (error.response?.status === 429) {
        const wait = (error.parameters?.retry_after || 5) * 1000;
        await new Promise(r => setTimeout(r, wait));
        const cleanedTitle = db.cleanTitle(f.title);
        const sent = await ctx.replyWithDocument(f.file_id, {
          caption: `🤡 <b>${cleanedTitle}</b>\n@VinehillBot`,
          parse_mode: 'HTML'
        });
        sentMsgIds.push(sent.message_id);
      } else {
        await ctx.reply(`❌ <b>Failed to deliver:</b> ${db.cleanTitle(f.title)}\n<i>Reason: ${error.message || 'Internal Error'}</i>`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  }

  db.saveDelivery(ctx.from.id, files.map(f => f.file_id), sentMsgIds, new Date(Date.now() + 5 * 60 * 1000));

  // Feature: Similar Media Suggestions
  if (files.length > 0) {
    const similar = db.getSimilarMedia(files[0].title, files[0].category, 3);
    if (similar.length > 0) {
      const suggestButtons = similar.map(s => {
        const payloadString = `${s.category}:${s.title}`;
        const payload = Buffer.from(payloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const displayTitle = db.cleanTitle(s.title);
        return [{ text: `🤡 ${displayTitle.toUpperCase()}`, url: `https://t.me/${bot.botInfo?.username}?start=${payload}` }];
      });
      await ctx.reply('🤡 <b>You might also like:</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: suggestButtons }
      });
    }
  }

  // Schedule deletion
  setTimeout(async () => {
    for (const mid of sentMsgIds) {
      await ctx.telegram.deleteMessage(ctx.chat.id, mid).catch(() => {});
    }
    
    await ctx.reply('🤡 <b>Files Expired</b>\n\nNeed them again or want to search for more?', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤡 Request Again', callback_data: `ra:${encodedPayload}` }],
          [{ text: '🤡 Back to Main Menu', callback_data: 'nav:start' }]
        ]
      }
    });
  }, 5 * 60 * 1000);
}
