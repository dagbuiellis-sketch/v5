import { bot, getAdminId, setMessageReaction } from '../client';
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

  // Callback for "I've Joined"
  bot.action(/^chk:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const payload = ctx.match[1];
    const userId = ctx.from.id;
    
    const missing = await checkMembership(ctx, userId);
    if (missing.length > 0) {
      return ctx.answerCbQuery('⚠️ Please join our main channel first to get access!', { show_alert: true });
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

  // Callback for "Retry Download" (Instant Recovery)
  bot.action(/^retry_dl:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('🔄 Retrying download...').catch(() => {});
    const payload = ctx.match[1];
    const userId = ctx.from.id;

    const missing = await checkMembership(ctx, userId);
    if (missing.length > 0) {
      return showJoinRequired(ctx, missing, payload);
    }

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
      let files = db.getSeasonFiles(title, season, category);
      if (files.length === 0) {
        const alt = db.findAlternativeMedia(title, category);
        if (alt.length > 0) files = alt.filter((f: any) => f.season === season);
      }
      if (files.length === 0) {
        return await handleDownloadFailure(ctx, `${title} Season ${season}`, category, encodedPayload, `No files found for Season ${season}`);
      }
      await sendMediaBatch(ctx, files, encodedPayload, `${title} Season ${season}`, category);
    } else {
      const season = parseInt(params[0]);
      const episode = parseInt(params[1]);
      let files = db.db.prepare(`SELECT * FROM files WHERE title = ? AND season = ? AND episode = ? AND category = ? AND file_id != ''`).all(title, season, episode, category) as any[];
      if (files.length === 0) {
        const alt = db.findAlternativeMedia(title, category);
        if (alt.length > 0) files = alt.filter((f: any) => f.season === season && f.episode === episode);
      }
      if (files.length === 0) {
        return await handleDownloadFailure(ctx, `${title} S${season}E${episode}`, category, encodedPayload, `File not found for S${season}E${episode}`);
      }
      await sendMediaBatch(ctx, files, encodedPayload, `${title} S${season}E${episode}`, category);
    }
  });
}

async function checkMembership(ctx: any, userId: number): Promise<string[]> {
  // Check if admin has disabled joined channel check
  const forceSub = db.getConfig('FORCE_SUB_ENABLED');
  if (forceSub === 'false' || forceSub === 'off') {
    return [];
  }

  // Admin users bypass channel check
  if (userId.toString() === getAdminId()) {
    return [];
  }

  // Limit check to ONLY the main channel as requested
  const mainChannel = PUBLIC_CHANNELS.main || process.env.CH_MAIN || '';
  if (!mainChannel) return [];

  try {
    const member = await ctx.telegram.getChatMember(mainChannel, userId);
    if (['left', 'kicked', 'restricted'].includes(member.status)) {
      return ['main'];
    }
  } catch (e) {
    logger.error({ err: e, channel: mainChannel }, 'Error checking membership for main channel');
  }
  return [];
}

function showJoinRequired(ctx: any, missing: string[], payload: string) {
  const mainChannel = PUBLIC_CHANNELS.main || process.env.CH_MAIN || '@VinehillMain';
  const channelLink = `https://t.me/${mainChannel.replace('@', '')}`;

  const keyboard: any[][] = [
    [{
      text: '📢 Join Our Main Channel',
      url: channelLink
    }],
    [{
      text: "🤡 I've Joined",
      callback_data: `chk:${payload}`
    }]
  ];

  return ctx.reply(
    '🤡 <b>Access Required</b>\n\n' +
    'Please join our <b>Main Channel</b> to download files from Vinehill.\n\n' +
    'Once joined, click the <b>I\'ve Joined</b> button below to receive your files!',
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

/**
 * Handles failed download attempts:
 * 1. Logs failure in SQLite `failed_deliveries`
 * 2. Alerts Admin via Telegram with user, file, and error details + resolve button
 * 3. Sends user an instant recovery prompt with a 1-click retry button and search options
 */
async function handleDownloadFailure(
  ctx: any,
  title: string,
  category: string,
  encodedPayload: string,
  errorReason: string
) {
  const userId = ctx.from?.id || ctx.chat?.id;
  const username = ctx.from?.username ? `@${ctx.from.username}` : 'No username';
  const fullName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'User';

  logger.warn({ userId, title, category, errorReason }, 'Download failure detected. Initiating recovery & admin alert...');

  // 1. Record in database
  const failureId = db.recordFailedDelivery(userId, title, category, errorReason);

  // 2. Alert Admin
  const adminId = getAdminId();
  if (adminId) {
    const adminAlertText =
      `🚨 <b>Failed Download Detected</b>\n\n` +
      `👤 <b>User:</b> ${fullName} (${username}) [ID: <code>${userId}</code>]\n` +
      `📦 <b>Media:</b> <b>${db.cleanTitle(title)}</b> (${category})\n` +
      `❌ <b>Reason:</b> <code>${errorReason}</code>\n` +
      `🕒 <b>Time:</b> ${new Date().toISOString()}\n\n` +
      `<i>Auto-recovery was attempted. The user received an instant retry card.</i>`;

    const adminButtons = [
      [{ text: '✅ Mark Resolved', callback_data: `adm_res:${failureId}` }]
    ];

    await bot.telegram.sendMessage(adminId, adminAlertText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: adminButtons }
    }).catch(err => {
      logger.error({ err }, 'Failed to alert admin of download failure');
    });
  }

  // 3. User Recovery Card
  const userMsg =
    `🤡 <b>Download Notice</b>\n\n` +
    `We encountered a technical issue preparing <b>${db.cleanTitle(title)}</b>.\n\n` +
    `🚨 <b>Don't worry!</b> Our administrator has been automatically notified and is looking into this.\n\n` +
    `You can click <b>🔄 Retry Download</b> below to try again, or search our library for alternatives:`;

  const userButtons = [
    [{ text: '🔄 Retry Download', callback_data: `retry_dl:${encodedPayload}` }],
    [
      { text: '🔍 Search Library', callback_data: 'nav:search' },
      { text: '🚩 Report Issue', callback_data: `rpt:${encodedPayload}` }
    ]
  ];

  await ctx.reply(userMsg, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: userButtons }
  }).catch(() => {});
}

async function deliverFiles(ctx: any, encodedPayload: string, skipCheck = false) {
  const chat_id = ctx.chat.id;
  const user_id = ctx.from.id;

  try {
    const sanitized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const payload = Buffer.from(sanitized, 'base64').toString('utf8');
    
    const firstColon = payload.indexOf(':');
    if (firstColon === -1) {
      return await handleDownloadFailure(ctx, 'Unknown', 'media', encodedPayload, 'Invalid request payload format');
    }
    
    const category = payload.substring(0, firstColon);
    const title = payload.substring(firstColon + 1);
    
    if (['series', 'anime'].includes(category)) {
      let seasons = db.getSeriesSeasons(title, category);
      if (seasons.length === 0) {
        // Auto-Recovery attempt 1: Search for alternative media title matches
        const altFiles = db.findAlternativeMedia(title, category);
        if (altFiles.length > 0) {
          const altTitle = altFiles[0].title;
          seasons = db.getSeriesSeasons(altTitle, category);
          if (seasons.length > 0) {
            const newPayload = Buffer.from(`${category}:${altTitle}`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            return await showSeasonPicker(ctx, altTitle, seasons, category, newPayload);
          }
        }
        
        return await handleDownloadFailure(ctx, title, category, encodedPayload, 'No episodes or seasons found in database');
      }
      
      // Always show season picker if it's series/anime, to allow episode-level choice
      await showSeasonPicker(ctx, title, seasons, category, encodedPayload);
    } else if (category === 'movies') {
      let files = db.getMoviesByTitle(title);
      if (files.length === 0) {
        // Auto-Recovery attempt
        const altFiles = db.findAlternativeMedia(title, 'movies');
        if (altFiles.length > 0) {
          logger.info({ title, count: altFiles.length }, 'Auto-recovered movie files via alternative search');
          files = altFiles;
        }
      }

      if (files.length === 0) {
        return await handleDownloadFailure(ctx, title, category, encodedPayload, 'Movie file not found in library storage');
      }

      await sendMediaBatch(ctx, files, encodedPayload, title, category);
    } else if (category === 'games') {
      let files = db.getGameFiles(title);
      if (files.length === 0) {
        // Auto-Recovery attempt
        const altFiles = db.findAlternativeMedia(title, 'games');
        if (altFiles.length > 0) {
          files = altFiles;
        }
      }

      if (files.length === 0) {
        return await handleDownloadFailure(ctx, title, category, encodedPayload, 'Game file not found in library storage');
      }

      await sendMediaBatch(ctx, files, encodedPayload, title, category);
    } else {
      await handleDownloadFailure(ctx, title, category, encodedPayload, `Unknown media category: ${category}`);
    }

  } catch (error: any) {
    logger.error(`Delivery failed: ${error}`);
    await handleDownloadFailure(ctx, 'Unknown', 'media', encodedPayload, error?.message || 'Internal delivery error');
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

async function sendMediaBatch(ctx: any, files: any[], encodedPayload: string, fallbackTitle?: string, fallbackCategory?: string) {
  if (files.length === 0) {
    return await handleDownloadFailure(ctx, fallbackTitle || 'Media', fallbackCategory || 'media', encodedPayload, 'No files found in storage');
  }

  const sentMsgIds: number[] = [];
  let deliveredCount = 0;
  let lastErrorReason = '';

  const warnMsg = await ctx.reply('🤡 <b>Fetching your requested files...</b>\n\nThese files will be <b>deleted in 5 minutes</b> for security. Forward them to your <b>Saved Messages</b> to keep them permanently!', { parse_mode: 'HTML' });
  sentMsgIds.push(warnMsg.message_id);

  for (const f of files) {
    let inline_keyboard: any[][] | undefined = undefined;
    try {
      const isMovie = f.category === 'movies';

      // Keep buttons attached for ONLY movies as requested
      if (isMovie) {
        const favPayloadString = `${f.category}:${f.title}`;
        const favPayload = Buffer.from(favPayloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const likeCount = db.getLikeCount(f.title, f.category);
        
        inline_keyboard = [
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
      }

      // No caption for delivered files (clean renamed file delivery)
      const copyExtra: any = { caption: '' };
      if (inline_keyboard) {
        copyExtra.reply_markup = { inline_keyboard };
      }

      const docExtra: any = {};
      if (inline_keyboard) {
        docExtra.reply_markup = { inline_keyboard };
      }

      let sent: any = null;

      // 1. Primary delivery: If channel_id and message_id are available, copyMessage is the most robust
      if (f.channel_id && f.message_id) {
        try {
          sent = await ctx.telegram.copyMessage(ctx.from.id, f.channel_id, f.message_id, copyExtra);
        } catch (copyErr: any) {
          logger.warn({ copyErr, file: f.title }, 'copyMessage failed, falling back...');
          lastErrorReason = copyErr?.message || 'copyMessage failed';
        }
      }

      // 2. Secondary delivery: If file_id is a valid Bot API file_id (not a raw MTProto digits-only ID)
      if (!sent && f.file_id && !/^\d+$/.test(f.file_id)) {
        try {
          sent = await ctx.replyWithDocument(f.file_id, docExtra);
        } catch (docErr: any) {
          logger.warn({ docErr, file: f.title }, 'replyWithDocument failed');
          lastErrorReason = docErr?.message || 'replyWithDocument failed';
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
              sent = await ctx.telegram.copyMessage(ctx.from.id, targetChan, matched.id, copyExtra);
            }
          }
        } catch (legacyErr: any) {
          logger.error({ legacyErr }, 'Legacy MTProto resolution failed');
          lastErrorReason = legacyErr?.message || 'MTProto resolution failed';
        }
      }

      if (sent) {
        deliveredCount++;
        sentMsgIds.push(sent.message_id);
        // Add clown emoji reaction to received file!
        setMessageReaction(ctx.telegram, ctx.from.id, sent.message_id, '🤡').catch(() => {});
        await new Promise(r => setTimeout(r, 800)); // Respect rate limits
      } else {
        throw new Error(lastErrorReason || 'File delivery failed: media identifier could not be resolved');
      }
    } catch (error: any) {
      logger.error({ err: error, file_id: f.file_id, title: f.title }, 'File delivery failed');
      lastErrorReason = error?.message || 'Delivery error';
      if (error.response?.status === 429) {
        const wait = (error.parameters?.retry_after || 5) * 1000;
        await new Promise(r => setTimeout(r, wait));
        const retryExtra: any = (f.category === 'movies' && inline_keyboard) ? { reply_markup: { inline_keyboard } } : {};
        try {
          const sent = await ctx.replyWithDocument(f.file_id, retryExtra);
          if (sent) {
            deliveredCount++;
            sentMsgIds.push(sent.message_id);
            setMessageReaction(ctx.telegram, ctx.from.id, sent.message_id, '🤡').catch(() => {});
          }
        } catch (retryErr: any) {
          lastErrorReason = retryErr?.message || 'Retry delivery failed';
        }
      }
    }
  }

  // If nothing was successfully delivered, alert admin and offer user retry
  if (deliveredCount === 0) {
    return await handleDownloadFailure(
      ctx,
      files[0]?.title || fallbackTitle || 'Media',
      files[0]?.category || fallbackCategory || 'media',
      encodedPayload,
      lastErrorReason || 'All delivery channels failed to deliver the file'
    );
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
