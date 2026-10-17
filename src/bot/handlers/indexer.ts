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
  
  await dispatchAnnouncement(fileData);
}

// Logic for smart batching announcements:
// 1. Movies are announced IMMEDIATELY upon appearing in the renamed channel.
// 2. Series & Anime hold announcements while any related episodes are in queue or actively renaming.
// 3. Immediately once queue and active rename are empty, the show announcement fires.
interface ShowBatchEntry {
  category: string;
  title: string;
  tmdb_id?: number | null;
  files: any[];
  highestFile: any;
  safetyTimer?: NodeJS.Timeout;
}

const _showBatches = new Map<string, ShowBatchEntry>();

function getBatchKey(category: string, title: string, tmdbId?: number | null): string {
  if (tmdbId) {
    return `tmdb:${tmdbId}:${category.toLowerCase()}`;
  }
  return `${category.toLowerCase()}:${title.trim().toLowerCase()}`;
}

async function dispatchAnnouncement(fileData: any, fromJobId?: string) {
  if (fileData.category === 'movies') {
    logger.info(`🎬 Movie indexed in renamed channel: announcing immediately: "${fileData.title}"`);
    const { announce } = await import('./announcer');
    await announce(fileData);
    return;
  }

  if (['series', 'anime'].includes(fileData.category)) {
    await handleSeriesEpisodeAnnouncement(fileData, fromJobId);
    return;
  }

  // Other categories (e.g. games) announce directly
  const { announce } = await import('./announcer');
  await announce(fileData);
}

async function handleSeriesEpisodeAnnouncement(fileData: any, fromJobId?: string) {
  const key = getBatchKey(fileData.category, fileData.title, fileData.tmdb_id);
  
  let batch = _showBatches.get(key);
  if (!batch) {
    batch = {
      category: fileData.category,
      title: fileData.title,
      tmdb_id: fileData.tmdb_id,
      files: [],
      highestFile: fileData,
    };
    _showBatches.set(key, batch);
  }

  const alreadyInBatch = batch.files.some(f => f.file_id === fileData.file_id);
  if (!alreadyInBatch) {
    batch.files.push(fileData);
  }

  // Track the highest episode/season for the announcement summary
  const currentMax = batch.highestFile;
  const isNewHigher = (fileData.season > (currentMax.season || 0)) ||
                     (fileData.season === currentMax.season && (fileData.episode || 0) > (currentMax.episode || 0));
  if (isNewHigher) {
    batch.highestFile = fileData;
  }

  const { hasRelatedRenameJob } = await import('../renamer');
  const hasRelated = hasRelatedRenameJob(fileData.category, fileData.title, fileData.tmdb_id, fromJobId);

  if (hasRelated) {
    logger.info(`⏳ Related rename job(s) in queue or actively renaming for "${fileData.title}". Holding announcement...`);
    if (batch.safetyTimer) clearTimeout(batch.safetyTimer);
    // 10-minute fallback safety timer
    batch.safetyTimer = setTimeout(() => {
      logger.warn(`⚠️ Safety timeout reached for show batch "${fileData.title}". Flushing announcement.`);
      flushShowBatch(key);
    }, 10 * 60 * 1000);
    return;
  }

  // No related jobs in queue or active rename:
  if (batch.safetyTimer) clearTimeout(batch.safetyTimer);

  if (fromJobId) {
    logger.info(`✨ All rename jobs finished for "${fileData.title}". Announcing immediately!`);
    await flushShowBatch(key);
  } else {
    // Direct channel post: short 3s window to group simultaneous uploads if any
    batch.safetyTimer = setTimeout(() => {
      flushShowBatch(key);
    }, 3000);
  }
}

export async function flushShowBatch(key: string) {
  const batch = _showBatches.get(key);
  if (!batch) return;
  if (batch.safetyTimer) clearTimeout(batch.safetyTimer);
  _showBatches.delete(key);

  const { files, highestFile } = batch;
  if (!files || files.length === 0) return;

  const count = files.length;
  logger.info(`📢 Flushing announcement for "${highestFile.title}" (${count} episode(s))`);

  // Calculate summary string
  let summary = '';
  const seasons = Array.from(new Set(files.map(f => f.season).filter(s => s !== null && s !== undefined)));
  if (seasons.length === 1) {
    summary = `Season ${seasons[0]} — ${count} episode(s)`;
  } else if (seasons.length > 1) {
    summary = `Seasons ${Math.min(...seasons)}–${Math.max(...seasons)} — ${count} files`;
  } else {
    summary = `${count} file(s)`;
  }

  const payload = {
    ...highestFile,
    batchCount: count,
    summary,
  };

  const { announce } = await import('./announcer');
  await announce(payload);

  const adminId = getAdminId();
  if (adminId) {
    const logMsg =
      `🚀 <b>Auto-Announced Batch</b>\n\n` +
      `📺 <b>${payload.title}</b> (${payload.year})\n` +
      `📦 ${summary}\n` +
      `Category: ${payload.category}`;

    await bot.telegram.sendMessage(adminId, logMsg, { parse_mode: 'HTML' }).catch(() => {});
  }
}

export async function notifyRenameJobFinished(category: string, title: string, tmdbId?: number | null) {
  if (!['series', 'anime'].includes(category)) return;

  const key = getBatchKey(category, title, tmdbId);
  let targetKey = _showBatches.has(key) ? key : null;

  if (!targetKey) {
    for (const [k, b] of _showBatches.entries()) {
      if (b.category === category) {
        if (tmdbId && b.tmdb_id && b.tmdb_id === tmdbId) {
          targetKey = k;
          break;
        }
        if (b.title.trim().toLowerCase() === title.trim().toLowerCase()) {
          targetKey = k;
          break;
        }
      }
    }
  }

  if (!targetKey) return;

  const batch = _showBatches.get(targetKey)!;
  const { hasRelatedRenameJob } = await import('../renamer');
  const hasRelated = hasRelatedRenameJob(category, batch.title, batch.tmdb_id);

  if (!hasRelated) {
    logger.info(`🎯 All rename jobs completed for "${batch.title}". Announcing immediately!`);
    await flushShowBatch(targetKey);
  }
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
  destinationChannel?: string,
  explicitFileSize?: number,
  explicitMeta?: any,
  fromRenameJobId?: string
) {
  try {
    const parsed = parseFilename(renamedFileName);
    const meta = explicitMeta || await searchTMDB(parsed.title, parsed.year, category);

    const docId = uploadedMessage.media?.document?.id?.toString() || 
                  uploadedMessage.document?.file_id || 
                  uploadedMessage.video?.file_id || 
                  uploadedMessage.audio?.file_id || 
                  `${category}_${Date.now()}`;
    const channelId = destinationChannel ? destinationChannel.toString() : '';
    const messageId = uploadedMessage.id || uploadedMessage.message_id || null;

    const fileData = {
      title: meta.title || parsed.title,
      year: meta.year || parsed.year,
      category,
      quality: parsed.quality,
      season: parsed.season,
      episode: parsed.episode,
      file_id: docId,
      file_name: renamedFileName,
      file_size: explicitFileSize || Number(
        uploadedMessage.media?.document?.size || 
        uploadedMessage.document?.file_size || 
        uploadedMessage.video?.file_size || 
        0
      ),
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
    await dispatchAnnouncement(fileData, fromRenameJobId);
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

        const parsed = parseFilename(detectedName);
        const meta = await searchTMDB(parsed.title, parsed.year, rawCategory);
        const hasValidTitle = Boolean(meta.title && meta.title.trim().length > 0);
        const hasValidCover = Boolean(meta.poster_url && meta.poster_url.trim().length > 0);

        if (!hasValidTitle || !hasValidCover) {
          logger.warn(`⚠️ Pre-verification failed for "${detectedName}": ${!hasValidTitle ? 'Title not found on TMDB' : 'Cover art missing on TMDB'}. Holding for admin correction...`);
          const { promptAdminStagingCorrection } = await import('./admin');
          await promptAdminStagingCorrection({
            sourceChannelId: channelId,
            sourceMessageId: post.message_id,
            originalFileName: detectedName,
            fileSize: media.file_size || 0,
            category: rawCategory,
            parsedTitle: parsed.title,
            parsedYear: parsed.year,
            issue: !hasValidTitle ? 'Title not found on TMDB' : 'Poster cover art missing on TMDB',
          });
          return;
        }

        queueRenameJob({
          sourceChannelId: channelId,
          sourceMessageId: post.message_id,
          originalFileName: detectedName,
          fileSize: media.file_size || 0,
          category: rawCategory,
          customTitle: meta.title,
          customYear: meta.year,
          verifiedMeta: meta,
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

