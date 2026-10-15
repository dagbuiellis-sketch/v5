import { bot, getAdminId, setMessageReaction } from '../client';
import * as db from '../database';
import { getShowStatus } from '../tmdb';
import { pino } from 'pino';
import { Markup } from 'telegraf';

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
};

// In-Memory State
const _batches: Map<string, { files: any[], timer: NodeJS.Timeout }> = new Map();
const _pending: Map<string, any> = new Map();

// Announcement Queue (for low-level posting)
const announceQueue: any[] = [];
let isAnnouncing = false;

async function processAnnounceQueue() {
  if (isAnnouncing || announceQueue.length === 0) return;
  isAnnouncing = true;

  while (announceQueue.length > 0) {
    const f = announceQueue.shift();
    try {
      await _doAnnounce(f);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      if (error.response?.status === 429) {
        const retryAfter = (error.parameters?.retry_after || 10) * 1000;
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        announceQueue.unshift(f);
      } else {
        logger.error(`Queue error: ${error}`);
      }
    }
  }

  isAnnouncing = false;
}

/**
 * Entry Point: Movies go straight to announce, others go to confirmation flow.
 */
export async function announce(fileData: any) {
  announceQueue.push(fileData);
  processAnnounceQueue();
}

/**
 * Batched entry for Series, Anime, and Games
 */
export async function sendForConfirmation(fileData: any) {
  const category = fileData.category;
  const title = fileData.title;
  const batchKey = `${category}_${title}`.replace(/ /g, '_');

  if (_batches.has(batchKey)) {
    clearTimeout(_batches.get(batchKey)!.timer);
  }

  const batch = _batches.get(batchKey) || { files: [], timer: null as any };
  batch.files.push(fileData);

  batch.timer = setTimeout(async () => {
    await flushBatch(batchKey);
  }, 90000); // 90 seconds sliding window

  _batches.set(batchKey, batch);
}

async function flushBatch(batchKey: string) {
  const batch = _batches.get(batchKey);
  if (!batch) return;
  _batches.delete(batchKey);

  // Pick last file as representative
  const rep = batch.files[batch.files.length - 1];
  
  // Calculate summary
  let summary = '';
  const seasons = Array.from(new Set(batch.files.map(f => f.season).filter(s => s !== null)));
  if (seasons.length === 1) {
    summary = `Season ${seasons[0]} — ${batch.files.length} episode(s)`;
  } else if (seasons.length > 1) {
    summary = `Seasons ${Math.min(...seasons)}–${Math.max(...seasons)} — ${batch.files.length} files`;
  } else {
    summary = `${batch.files.length} file(s)`;
  }

  const pendingData = { ...rep, batchCount: batch.files.length, summary };
  _pending.set(batchKey, pendingData);

  // Auto-announce without waiting for confirmation
  announce(pendingData);
  _pending.delete(batchKey);

  const adminId = getAdminId();
  if (adminId) {
    const logMsg = 
      `🚀 <b>Auto-Announced Batch</b>\n\n` +
      `📺 <b>${pendingData.title}</b> (${pendingData.year})\n` +
      `📦 ${summary}\n` +
      `Category: ${pendingData.category}`;

    await bot.telegram.sendMessage(adminId, logMsg, { parse_mode: 'HTML' }).catch(() => {});
  }
}

/**
 * Post to specific channels
 */
async function _doAnnounce(f: any) {
  const category = f.category;
  if (['series', 'anime'].includes(category)) {
    await _announceSeries(f);
  } else if (category === 'games') {
    await _announceGame(f);
  } else {
    await _announceMovie(f);
  }
}

function scheduleClownReaction(telegram: any, chatId: string | number, messageId: number, delayMs = 1000) {
  setTimeout(() => {
    setMessageReaction(telegram, chatId, messageId, '🤡').catch(() => {});
  }, delayMs);
}

async function _announceMovie(f: any) {
  const channel = PUBLIC_CHANNELS.movies;
  if (!channel) return;

  const old = db.getAnnouncementInfo(f.title, f.category);
  if (old) {
    await bot.telegram.deleteMessage(channel, old.msg_id).catch(() => {});
    if (PUBLIC_CHANNELS.main && old.main_msg_id) {
      await bot.telegram.deleteMessage(PUBLIC_CHANNELS.main, old.main_msg_id).catch(() => {});
    }
  }

  const { caption, keyboard } = _buildCaptionKeyboard(f);
  
  const sent = await bot.telegram.sendPhoto(channel, f.poster_url, {
    caption,
    parse_mode: 'HTML',
    ...keyboard
  });
  scheduleClownReaction(bot.telegram, channel, sent.message_id, 1000);

  // Cross-post to Main
  let mainMsgId = null;
  if (PUBLIC_CHANNELS.main) {
    const copied = await bot.telegram.copyMessage(PUBLIC_CHANNELS.main, channel, sent.message_id, {
      reply_markup: keyboard.reply_markup
    });
    mainMsgId = copied.message_id;
    scheduleClownReaction(bot.telegram, PUBLIC_CHANNELS.main, copied.message_id, 1000);
  }
  db.saveAnnouncementInfo(f.title, f.category, sent.message_id, mainMsgId, channel);
}

async function _announceGame(f: any) {
  const channel = PUBLIC_CHANNELS.games;
  if (!channel) return;

  const { caption, keyboard } = _buildCaptionKeyboard(f);
  
  const sent = await bot.telegram.sendPhoto(channel, f.poster_url, {
    caption,
    parse_mode: 'HTML',
    ...keyboard
  });
  scheduleClownReaction(bot.telegram, channel, sent.message_id, 1000);

  db.saveAnnouncementInfo(f.title, f.category, sent.message_id, null, channel);
}

async function _announceSeries(f: any) {
  const channel = PUBLIC_CHANNELS[f.category];
  if (!channel) return;

  const status = await getShowStatus(f.title, f.category);
  const isFinished = ['Ended', 'Canceled'].includes(status);

  if (isFinished) {
    // Finished show: Post fresh
    const { caption, keyboard } = _buildSeriesCaption(f, false);
    const sent = await bot.telegram.sendPhoto(channel, f.poster_url, { caption, parse_mode: 'HTML', ...keyboard });
    scheduleClownReaction(bot.telegram, channel, sent.message_id, 1000);
    
    let mainMsgId = null;
    if (PUBLIC_CHANNELS.main) {
      const copied = await bot.telegram.copyMessage(PUBLIC_CHANNELS.main, channel, sent.message_id, { reply_markup: keyboard.reply_markup });
      mainMsgId = copied.message_id;
      scheduleClownReaction(bot.telegram, PUBLIC_CHANNELS.main, copied.message_id, 1000);
    }
    db.saveAnnouncementInfo(f.title, f.category, sent.message_id, mainMsgId, channel);
  } else {
    // Ongoing: Delete old and post fresh
    const old = db.getAnnouncementInfo(f.title, f.category);
    if (old) {
      await bot.telegram.deleteMessage(channel, old.msg_id).catch(() => {});
      if (PUBLIC_CHANNELS.main && old.main_msg_id) {
        await bot.telegram.deleteMessage(PUBLIC_CHANNELS.main, old.main_msg_id).catch(() => {});
      }
    }

    const { caption, keyboard } = _buildSeriesCaption(f, true);
    const sent = await bot.telegram.sendPhoto(channel, f.poster_url, { caption, parse_mode: 'HTML', ...keyboard });
    scheduleClownReaction(bot.telegram, channel, sent.message_id, 1000);

    let mainMsgId = null;
    if (PUBLIC_CHANNELS.main) {
      const copied = await bot.telegram.copyMessage(PUBLIC_CHANNELS.main, channel, sent.message_id, { reply_markup: keyboard.reply_markup });
      mainMsgId = copied.message_id;
      scheduleClownReaction(bot.telegram, PUBLIC_CHANNELS.main, copied.message_id, 1000);
    }
    db.saveAnnouncementInfo(f.title, f.category, sent.message_id, mainMsgId, channel);
  }
}

function _formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function _buildCaptionKeyboard(f: any) {
  const ratingStars = f.rating ? '⭐'.repeat(Math.round(parseFloat(f.rating) / 2)) || '⭐' : '⭐';
  const payloadString = `${f.category}:${f.title}`;
  const encoded = Buffer.from(payloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dlLink = `https://t.me/${bot.botInfo?.username}?start=${encoded}`;

  const tagsStr = f.tags ? `🏷 <b>${f.tags}</b>\n` : '';
  const sizeStr = f.file_size && !f.batchCount ? `💾 <b>Size: ${_formatSize(f.file_size)}</b>\n` : '';

  const qualities = db.getAvailableQualities(f.title, f.category);
  const qualityStr = qualities.length > 0 ? qualities.join(' | ') : f.quality || 'Unknown';

  const caption = 
    `🎬 <b>NOW AVAILABLE</b>\n\n` +
    `<b>${f.title}</b> (${f.year})\n` +
    `${ratingStars} <b>${f.rating || 'N/A'}/10</b> | 🎭 <b>${f.genres || 'N/A'}</b>\n` +
    `📝 ${f.overview ? f.overview.slice(0, 200) + '...' : 'No description available.'}\n\n` +
    tagsStr +
    sizeStr +
    `📦 <b>Format: ${qualityStr}</b>`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('📥 DOWNLOAD NOW', dlLink)],
    ..._getCrossPromoButtons(f.category)
  ]);

  return { caption, keyboard };
}

function _formatSE(season: any, episode: any): string {
  if (season === undefined || season === null) return '';
  const s = season.toString().padStart(2, '0');
  if (episode === undefined || episode === null) return `S${s}`;
  const e = episode.toString().padStart(2, '0');
  return `S${s}E${e}`;
}

function _buildSeriesCaption(f: any, ongoing: boolean) {
  const ratingStars = f.rating ? '⭐'.repeat(Math.round(parseFloat(f.rating) / 2)) || '⭐' : '⭐';
  const payloadString = `${f.category}:${f.title}`;
  const encoded = Buffer.from(payloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dlLink = `https://t.me/${bot.botInfo?.username}?start=${encoded}`;

  const seasons = db.getSeriesSeasons(f.title, f.category);
  const seasonCount = seasons.length;

  let releaseInfo = '';
  const seCode = _formatSE(f.season, f.episode);

  if (f.batchCount && f.batchCount > 1) {
    releaseInfo = `🆕 <b>${f.batchCount} New Episodes Added!</b>\n` +
                  (seCode ? `🚀 Latest: ${seCode}` : '');
  } else if (ongoing && seCode) {
    releaseInfo = `🆕 <b>${seCode} just added!</b>`;
  } else {
    releaseInfo = `📦 <b>${seasonCount} season${seasonCount > 1 ? 's' : ''} available</b>`;
  }

  const tagsStr = f.tags ? `🏷 <b>${f.tags}</b>\n` : '';
  const qualities = db.getAvailableQualities(f.title, f.category);
  const qualityStr = qualities.length > 0 ? `🎞 <b>Quality: ${qualities.join(' | ')}</b>\n` : '';

  const caption = 
    `🎬 <b>NOW AVAILABLE</b>\n\n` +
    `<b>${f.title}</b> (${f.year})\n` +
    `${ratingStars} <b>${f.rating || 'N/A'}/10</b> | 🎭 <b>${f.genres || 'N/A'}</b>\n` +
    `📝 ${f.overview ? f.overview.slice(0, 200) + '...' : 'No description available.'}\n\n` +
    tagsStr +
    qualityStr +
    `${releaseInfo}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.url('📥 DOWNLOAD NOW', dlLink)],
    ..._getCrossPromoButtons(f.category)
  ]);

  return { caption, keyboard };
}

function _getCrossPromoButtons(exclude: string) {
  const btns = [];
  const channels = [
    { text: '📺 Vinehill Series', url: `https://t.me/${PUBLIC_CHANNELS.series?.replace('@', '')}`, key: 'series' },
    { text: '🎬 Vinehill Movies', url: `https://t.me/${PUBLIC_CHANNELS.movies?.replace('@', '')}`, key: 'movies' },
    { text: '🍜 Vinehill Anime', url: `https://t.me/${PUBLIC_CHANNELS.anime?.replace('@', '')}`, key: 'anime' },
    { text: '🎮 Vinehill Games', url: `https://t.me/${PUBLIC_CHANNELS.games?.replace('@', '')}`, key: 'games' }
  ].filter(c => c.key !== exclude);

  // Group into pairs
  for (let i = 0; i < channels.length; i += 2) {
    const row = [Markup.button.url(channels[i].text, channels[i].url)];
    if (channels[i+1]) {
      row.push(Markup.button.url(channels[i+1].text, channels[i+1].url));
    }
    btns.push(row);
  }
  return btns;
}

/**
 * Register Callback Handlers
 */
export function registerAnnouncer() {
  // Callback handlers for confirmation are removed since it is now automatic.
}

// Cleanup functions
export async function deleteAnnouncementsByTitle(title: string, category: string) {
  const ann = db.getAnnouncementInfo(title, category);
  if (!ann) return;
  try {
    await bot.telegram.deleteMessage(ann.channel, ann.msg_id).catch(() => {});
    if (PUBLIC_CHANNELS.main && ann.main_msg_id) {
      await bot.telegram.deleteMessage(PUBLIC_CHANNELS.main, ann.main_msg_id).catch(() => {});
    }
  } catch (e) {}
}

export async function wipeAllPublicChannels(ctx: any) {
  const channels = Object.values(PUBLIC_CHANNELS).filter(ch => ch);
  for (const channelId of channels) {
    try {
      logger.info(`Cleaning channel: ${channelId}`);
      // Send dummy to find top ID
      const dummy = await bot.telegram.sendMessage(channelId, "🧹 <b>System Maintenance: Clearing Channel...</b>", { parse_mode: 'HTML' });
      const topId = dummy.message_id;
      
      const range = 2000; // Deep enough for most channels
      const batchSize = 100;

      for (let i = 0; i < range; i += batchSize) {
        const batch = [];
        for (let j = 0; j < batchSize; j++) {
          const id = topId - (i + j);
          if (id > 0) batch.push(id);
        }

        if (batch.length > 0) {
          // Attempt bulk delete if supported, fallback to individual
          await (bot.telegram as any).deleteMessages?.(channelId, batch).catch(async () => {
             for (const mid of batch) {
               await bot.telegram.deleteMessage(channelId, mid).catch(() => {});
               // Minor delay to respect global 30 msg/sec limit if deleteMessages is missing
               await new Promise(r => setTimeout(r, 40)); 
             }
          });
        }
        // Small delay to respect rate limits
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) {
      logger.error(`Brute force error for ${channelId}: ${e}`);
    }
  }
}

export async function syncAnnouncements(ctx: any) {
  const statusMsg = await ctx.reply('⏳ <b>Syncing Announcements...</b>\n\nChecking for missing posts...', { parse_mode: 'HTML' });
  
  const uniqueMedia = db.getAllMediaUnique();
  const announcements = db.getAllAnnouncements();
  const annMap = new Map(announcements.map(a => [`${a.category}:${a.title}`, a]));
  
  let added = 0;
  for (const media of uniqueMedia) {
    const key = `${media.category}:${media.title}`;
    if (!annMap.has(key)) {
      if (media.poster_url) {
        announceQueue.push(media);
        added++;
      }
    }
  }
  
  processAnnounceQueue();
  
  await ctx.telegram.editMessageText(
    ctx.chat.id, 
    statusMsg.message_id, 
    undefined, 
    `✅ <b>Sync Complete</b>\n\nIdentified and queued <b>${added}</b> missing items for announcement.`, 
    { parse_mode: 'HTML' }
  ).catch(() => {});
}

export async function reannounceAll(ctx: any) {
  const statusMsg = await ctx.reply('⏳ <b>Mass Re-announcement Started</b>\n\n1. Wiping channels (Brute-force cleanup)...\n2. Reposting...', { parse_mode: 'HTML' });

  // 1. Brute-force cleanup of all public channels
  await wipeAllPublicChannels(ctx);

  // 2. Clear known announcements from DB
  db.clearAnnouncementsTable();

  // 3. Repost everything
  const uniqueMedia = db.getAllMediaUnique();
  let count = 0;
  for (const media of uniqueMedia) {
    if (media.poster_url) {
      announceQueue.push(media);
      count++;
    }
  }
  processAnnounceQueue();

  await ctx.telegram.editMessageText(
    ctx.chat.id, 
    statusMsg.message_id, 
    undefined, 
    `✅ <b>Re-announcement Initialized</b>\n\nChannels cleared, and ${count} items queued for reposting.`, 
    { parse_mode: 'HTML' }
  ).catch(() => {});
}
