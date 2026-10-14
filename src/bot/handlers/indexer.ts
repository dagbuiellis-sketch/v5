import { bot, getAdminId } from '../client';
import { parseFilename } from '../file_parser';
import { searchTMDB } from '../tmdb';
import * as db from '../database';
import { pino } from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

import { queueRenameJob, RENAMED_CHANNELS } from '../renamer';

const STORAGE_CHANNELS: Record<string, string> = {
  movies: process.env.STORAGE_MOVIES || '',
  series: process.env.STORAGE_SERIES || '',
  anime: process.env.STORAGE_ANIME || '',
  games: process.env.STORAGE_GAMES || '',
  music: process.env.STORAGE_MUSIC || '',
};

const queue: any[] = [];
let processing = false;

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const { ctx, category } = queue.shift();
    try {
      await handleIndexing(ctx, category);
      // Wait at least 1 second between processing files to respect Telegram limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      if (error.response?.status === 429) {
        const retryAfter = (error.parameters?.retry_after || 5) * 1000;
        logger.warn(`Rate limited. Waiting ${retryAfter}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        // Put it back at the start of the queue
        queue.unshift({ ctx, category });
      } else {
        logger.error(`Processing error: ${error}`);
      }
    }
  }

  processing = false;
}

async function handleIndexing(ctx: any, category: string, isScan = false) {
  logger.info(`Processing ${category} storage... ${isScan ? '(Deep Scan)' : ''}`);

  const msg = ctx.channelPost || ctx.message;
  if (!msg) return;

  const media = msg.document || msg.video || msg.audio;
  if (!media) return;

  const fileName = media.file_name || msg.caption || `${category}_file`;
  const fileSize = media.file_size || 0;
  const fileId = media.file_id;

  const parsed = parseFilename(fileName);
  
  // Strict deduplication: check file_id or (title/season/episode/quality)
  const isDup = db.db.prepare(`
    SELECT id FROM files WHERE file_id = ? OR (title = ? AND quality = ? AND season IS ? AND episode IS ?)
  `).get(fileId, parsed.title, parsed.quality, parsed.season, parsed.episode);

  if (isDup) {
    if (!isScan) logger.info(`Duplicate skipped: ${parsed.title} (ID: ${fileId})`);
    return;
  }

  const meta = await searchTMDB(parsed.title, parsed.year, category);

  const fileData = {
    title: meta.title || parsed.title,
    year: meta.year || parsed.year,
    category,
    quality: parsed.quality,
    season: parsed.season,
    episode: parsed.episode,
    file_id: fileId,
    file_name: fileName,
    file_size: fileSize,
    tags: parsed.tags,
    tmdb_id: meta.tmdb_id,
    poster_url: meta.poster_url,
    overview: meta.overview,
    rating: meta.rating,
    genres: meta.genres,
    channel_id: msg.chat?.id?.toString() || '',
    message_id: msg.message_id || null,
  };

  db.addFile(fileData);
  logger.info(`Indexed: ${fileData.title} S${fileData.season}E${fileData.episode}`);
  
  // Grouping logic for all categories to avoid spam and allow quality grouping
  queueBatchAnnouncement(fileData);
}

// Logic for batching announcements to avoid channel spam
const _batchAnnounce = new Map<string, { data: any, count: number, timeout: NodeJS.Timeout }>();

function queueBatchAnnouncement(data: any) {
  // Use TMDB ID as key if available, otherwise fallback to title + category
  // This prevents splitting show seasons if filenames have different years
  const key = data.tmdb_id ? `tmdb:${data.tmdb_id}:${data.category}` : `${data.title}:${data.category}`;
  
  if (_batchAnnounce.has(key)) {
    const existing = _batchAnnounce.get(key)!;
    existing.count++;
    
    // Track the highest episode/season for the announcement summary
    const currentMax = existing.data;
    const isNewHigher = (data.season > (currentMax.season || 0)) || 
                       (data.season === currentMax.season && (data.episode || 0) > (currentMax.episode || 0));
    
    if (isNewHigher) {
      existing.data = data;
    }

    clearTimeout(existing.timeout);
    existing.timeout = setTimeout(() => flushBatch(key), 30000); // 30s window
  } else {
    _batchAnnounce.set(key, {
      data,
      count: 1,
      timeout: setTimeout(() => flushBatch(key), 30000)
    });
  }
}

async function flushBatch(key: string) {
  const info = _batchAnnounce.get(key);
  if (!info) return;
  _batchAnnounce.delete(key);

  const { data, count } = info;
  const { sendForConfirmation } = await import('./announcer');
  
  logger.info(`Flushing announcement batch for ${data.title} (${count} episodes)`);
  // Overload total files for announcer UI
  data.batchCount = count;
  await sendForConfirmation(data);
}

export async function scanChannel(ctx: any, category: string, limitCount = 100) {
  const channelId = STORAGE_CHANNELS[category];
  if (!channelId) {
    return ctx.reply(`❌ Storage channel for <b>${category}</b> not found in config.`, { parse_mode: 'HTML' });
  }

  const statusMsg = await ctx.reply(`🔍 <b>Scanning ${category}...</b>\n\nStarting historical deep scan of the storage channel. This might take a while...`, { parse_mode: 'HTML' });

  try {
    // 1. Find Max ID
    const sample = await ctx.telegram.sendMessage(channelId, "Index Sync Running...");
    const maxId = sample.message_id;
    await ctx.telegram.deleteMessage(channelId, maxId);

    const startId = Math.max(1, maxId - limitCount);
    let found = 0;
    let errors = 0;

    const me = await ctx.telegram.getMe();

    for (let id = maxId; id >= startId; id--) {
      try {
        // We use forwardMessage because bots can't read channel history directly.
        // Forwarding to themselves reveals the message object.
        const fwd = await ctx.telegram.forwardMessage(me.id, channelId, id);
        
        if (fwd.document || fwd.video || fwd.audio) {
          await handleIndexing({ ...ctx, message: fwd, channelPost: null }, category, true);
          found++;
        }
        
        await ctx.telegram.deleteMessage(me.id, fwd.message_id).catch(() => {});
        
        if (found % 10 === 0 && found > 0) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, 
            statusMsg.message_id, 
            undefined, 
            `🔍 <b>Scanning ${category}...</b>\n\nFound <b>${found}</b> new items so far.\nScanning ID: <code>${id}</code>`, 
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }

        // Delay to avoid flood
        await new Promise(r => setTimeout(r, 300));
      } catch (err: any) {
        // Message might not exist or be deleted
        errors++;
      }
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, 
      statusMsg.message_id, 
      undefined, 
      `✅ <b>Scan Complete: ${category}</b>\n\nRecovered <b>${found}</b> forgotten files.\nAny new items have been queued for announcement.`, 
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error(`Scan error: ${err}`);
    ctx.reply(`❌ Scan failed: ${err}`);
  }
}

export async function handleUploadedRenamedMedia(
  uploadedMessage: any, 
  category: string, 
  renamedFileName: string, 
  destinationChannel?: string
) {
  try {
    const parsed = parseFilename(renamedFileName);
    const meta = await searchTMDB(parsed.title, parsed.year, category);

    const docId = uploadedMessage.media?.document?.id?.toString() || `${category}_${Date.now()}`;
    const channelId = destinationChannel ? destinationChannel.toString() : '';
    const messageId = uploadedMessage.id || null;

    const fileData = {
      title: meta.title || parsed.title,
      year: meta.year || parsed.year,
      category,
      quality: parsed.quality,
      season: parsed.season,
      episode: parsed.episode,
      file_id: docId,
      file_name: renamedFileName,
      file_size: Number(uploadedMessage.media?.document?.size || 0),
      tags: parsed.tags,
      tmdb_id: meta.tmdb_id,
      poster_url: meta.poster_url,
      overview: meta.overview,
      rating: meta.rating,
      genres: meta.genres,
      channel_id: channelId,
      message_id: messageId,
    };

    db.addFile(fileData);
    logger.info(`Indexed renamed upload: ${fileData.title} (msg_id: ${messageId} in ${channelId})`);
    queueBatchAnnouncement(fileData);
  } catch (err) {
    logger.error({ err }, 'Error handling uploaded renamed media');
  }
}

export function registerIndexer() {
  const handler = async (ctx: any) => {
    const post = ctx.channelPost || ctx.message;
    if (!post) return;

    const channelId = post.chat.id.toString();
    const chatUsername = post.chat.username ? `@${post.chat.username}` : '';
    
    // 1. Check if post is in RAW STAGING storage channels
    let rawCategory: string | null = null;
    for (const [cat, id] of Object.entries(STORAGE_CHANNELS)) {
      if (id && (id === channelId || id === chatUsername)) {
        rawCategory = cat;
        break;
      }
    }

    if (rawCategory) {
      const media = post.document || post.video || post.audio;
      if (media && ['movies', 'series', 'anime'].includes(rawCategory)) {
        const detectedName = media.file_name || post.caption || `${rawCategory}_file`;
        logger.info(`📥 Raw file detected in staging channel (${rawCategory}): ${detectedName}`);
        queueRenameJob({
          sourceChannelId: channelId,
          sourceMessageId: post.message_id,
          originalFileName: detectedName,
          fileSize: media.file_size || 0,
          category: rawCategory,
        });
        return;
      } else if (media) {
        // Categories not requiring rename (e.g. games, music) get indexed directly
        queue.push({ ctx, category: rawCategory });
        processQueue();
        return;
      }
    }

    // 2. Check if post is in RENAMED DESTINATION channels (@renamed_movies, etc.)
    let renamedCategory: string | null = null;
    for (const [cat, target] of Object.entries(RENAMED_CHANNELS)) {
      if (target && (target.toLowerCase() === chatUsername.toLowerCase() || target === channelId)) {
        renamedCategory = cat;
        break;
      }
    }

    if (renamedCategory) {
      logger.info(`✨ Renamed file posted to destination channel (${renamedCategory}): indexing & announcing...`);
      queue.push({ ctx, category: renamedCategory });
      processQueue();
      return;
    }
  };

  bot.on('channel_post', handler);
  bot.on('message', async (ctx, next) => {
    const channelId = ctx.chat.id.toString();
    const chatUsername = (ctx.chat as any)?.username ? `@${(ctx.chat as any).username}` : '';
    let match = false;

    for (const id of [...Object.values(STORAGE_CHANNELS), ...Object.values(RENAMED_CHANNELS)]) {
      if (id && (id === channelId || id.toLowerCase() === chatUsername.toLowerCase())) {
        match = true;
        break;
      }
    }

    if (match) {
      return handler(ctx);
    }

    return next();
  });
}

function postChatUsername(ctx: any): string {
  return (ctx.chat as any)?.username || '';
}

