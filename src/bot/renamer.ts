import fs from 'fs';
import path from 'path';
import os from 'os';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { CustomFile } from 'telegram/client/uploads';
import { parseFilename, formatRenamedFilename } from './file_parser';
import * as db from './database';
import { pino } from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

export const RENAMED_CHANNELS: Record<string, string> = {
  movies: process.env.RENAMED_MOVIES || '@renamed_movies',
  series: process.env.RENAMED_SERIES || '@renamed_series',
  anime: process.env.RENAMED_ANIME || '@renamed_anime',
};

const apiId = process.env.API_ID ? parseInt(process.env.API_ID) : 0;
const apiHash = process.env.API_HASH || '';
const botToken = process.env.BOT_TOKEN || '';

let client: TelegramClient | null = null;
let isClientReady = false;
let floodWaitUntil = 0;
let floodAlertSent = false;

export async function initMTProtoClient(): Promise<TelegramClient | null> {
  if (client && isClientReady) return client;
  if (!apiId || !apiHash || !botToken) {
    logger.warn('MTProto Client not configured (API_ID, API_HASH, or BOT_TOKEN missing). Running in Telegraf fallback mode.');
    return null;
  }

  // If currently in FloodWait cooldown, skip attempt to avoid spamming Telegram
  if (Date.now() < floodWaitUntil) {
    const remainingSecs = Math.ceil((floodWaitUntil - Date.now()) / 1000);
    logger.info(`⏳ MTProto in FloodWait cooldown (${remainingSecs}s remaining). Using Bot API fallback.`);
    return null;
  }

  try {
    const sessionString = process.env.TELEGRAM_SESSION || db.getConfig('TELEGRAM_SESSION') || '';
    const session = new StringSession(sessionString);
    client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
      useWSS: false,
    });

    await client.start({
      botAuthToken: botToken,
    });

    isClientReady = true;
    floodWaitUntil = 0;
    floodAlertSent = false;

    // Persist authenticated session in SQLite so future restarts reuse it and avoid auth flood limits
    try {
      const savedSession = client.session.save() as unknown as string;
      if (savedSession && savedSession !== sessionString) {
        db.setConfig('TELEGRAM_SESSION', savedSession);
        logger.info('💾 Persisted Telegram MTProto session to database.');
      }
    } catch (saveErr) {
      logger.warn({ saveErr }, 'Could not save MTProto session');
    }

    logger.info('🚀 GramJS MTProto client initialized successfully (2GB file pipeline active)!');
    return client;
  } catch (error: any) {
    if (error?.message?.includes('FloodWaitError') || error?.seconds || error?.errorMessage === 'FLOOD') {
      const waitSecs = Number(error.seconds) || 3600;
      floodWaitUntil = Date.now() + (waitSecs * 1000);
      const minutes = Math.ceil(waitSecs / 60);
      logger.warn(`⏳ GramJS MTProto FloodWait active: wait of ${waitSecs}s (~${minutes} mins) required. Bot API fallback active.`);

      const adminId = getAdminId();
      if (adminId && !floodAlertSent) {
        floodAlertSent = true;
        bot.telegram.sendMessage(
          adminId,
          `⚠️ <b>Telegram MTProto FloodWait Active</b>\n\n` +
          `Telegram requires a wait of <b>${minutes} minutes</b> (${waitSecs}s) before new authorizations.\n\n` +
          `🛡️ <b>No files will be skipped!</b> Staging files are automatically processed via the <b>Bot API Fallback</b> (copied, renamed caption attached, and indexed) until the cooldown completes.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    } else {
      logger.error({ err: error }, 'Failed to start GramJS MTProto client');
    }
    client = null;
    isClientReady = false;
    return null;
  }
}

import { bot, getAdminId } from './client';

import { TMDBMeta } from './tmdb';

export interface RenameJob {
  id?: string;
  sourceChannelId: string;
  sourceMessageId: number;
  originalFileName: string;
  fileSize: number;
  category: 'movies' | 'series' | 'anime' | string;
  isCancelled?: boolean;
  progressMsgId?: number;
  targetChannelId?: string;
  adminChatId?: string | number;
  customTitle?: string;
  customYear?: number;
  verifiedMeta?: TMDBMeta;
}

const renameQueue: RenameJob[] = [];
let isProcessingRename = false;
let currentActiveJob: RenameJob | null = null;

export function getActiveRenameJob(): RenameJob | null {
  return currentActiveJob;
}

export function getRenameQueue(): RenameJob[] {
  return [...renameQueue];
}

export function cancelActiveRenameJob(jobId?: string): boolean {
  if (!currentActiveJob) return false;
  if (jobId && currentActiveJob.id !== jobId) return false;

  currentActiveJob.isCancelled = true;
  logger.info(`🛑 Cancellation requested for active job ${currentActiveJob.id} (${currentActiveJob.originalFileName})`);
  return true;
}

export function queueRenameJob(job: RenameJob) {
  if (!job.id) {
    job.id = `rjob_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
  renameQueue.push(job);
  logger.info(`Queued rename job [${job.id}] for ${job.originalFileName} (${(job.fileSize / (1024 * 1024)).toFixed(1)} MB)`);
  processRenameQueue();
}

export async function processRenameQueue() {
  if (isProcessingRename || renameQueue.length === 0) return;
  isProcessingRename = true;

  while (renameQueue.length > 0) {
    const job = renameQueue.shift()!;
    try {
      await executeRenameJob(job);
    } catch (err) {
      logger.error({ err, job }, 'Error executing rename job');
    }
  }

  isProcessingRename = false;
}

export function hasRelatedRenameJob(
  category: string,
  title: string,
  tmdbId?: number | null,
  excludeJobId?: string
): boolean {
  if (!['series', 'anime'].includes(category)) return false;

  const normalizedTitle = title.trim().toLowerCase();

  const isMatching = (job: RenameJob | null) => {
    if (!job || job.isCancelled) return false;
    if (excludeJobId && job.id === excludeJobId) return false;
    if (job.category !== category) return false;

    // Check TMDB ID match
    if (tmdbId && job.verifiedMeta?.tmdb_id && job.verifiedMeta.tmdb_id === tmdbId) {
      return true;
    }

    // Check parsed or custom title match
    const jobTitle = (job.customTitle || job.verifiedMeta?.title || parseFilename(job.originalFileName).title || '').trim().toLowerCase();
    if (jobTitle && (jobTitle === normalizedTitle || jobTitle.includes(normalizedTitle) || normalizedTitle.includes(jobTitle))) {
      return true;
    }

    return false;
  };

  if (isMatching(currentActiveJob)) {
    return true;
  }

  return renameQueue.some(job => isMatching(job));
}

async function executeBotApiFallback(job: RenameJob, destinationChannel: string) {
  const parsed = parseFilename(job.originalFileName);
  if (job.customTitle) parsed.title = job.customTitle;
  if (job.customYear) parsed.year = job.customYear;

  const targetFileName = formatRenamedFilename(parsed, job.originalFileName);
  // Compact caption for renamed channel: file name only
  const caption = `<code>${targetFileName}</code>`;

  try {
    const sourcePeer = /^-?\d+$/.test(job.sourceChannelId)
      ? parseInt(job.sourceChannelId)
      : job.sourceChannelId;

    logger.info(`📋 Bot API Fallback: Transferring "${job.originalFileName}" from ${job.sourceChannelId} (msg: ${job.sourceMessageId}) to ${destinationChannel}...`);

    const copiedMsg = await bot.telegram.copyMessage(destinationChannel, sourcePeer, job.sourceMessageId, {
      caption,
      parse_mode: 'HTML',
    });

    if (copiedMsg && copiedMsg.message_id) {
      const { handleUploadedRenamedMedia } = await import('./handlers/indexer');
      await handleUploadedRenamedMedia(
        copiedMsg,
        job.category,
        targetFileName,
        destinationChannel,
        job.fileSize,
        job.verifiedMeta,
        job.id
      );
      logger.info(`✅ Successfully copied and indexed "${targetFileName}" via Bot API fallback!`);
    }
  } catch (fallbackErr) {
    logger.error({ fallbackErr, job }, `Failed to execute Bot API fallback for ${job.originalFileName}`);
  }
}

async function executeRenameJob(job: RenameJob) {
  currentActiveJob = job;

  const destinationChannel = RENAMED_CHANNELS[job.category];
  if (!destinationChannel) {
    logger.error(`No destination channel found for category: ${job.category}`);
    currentActiveJob = null;
    return;
  }

  job.targetChannelId = destinationChannel;

  const mtClient = await initMTProtoClient();
  if (!mtClient) {
    logger.info(`ℹ️ MTProto client unavailable for "${job.originalFileName}". Executing zero-loss Bot API fallback to ${destinationChannel}...`);
    try {
      await executeBotApiFallback(job, destinationChannel);
    } catch (fallbackErr) {
      logger.error({ fallbackErr }, `Bot API fallback failed for ${job.originalFileName}`);
    } finally {
      currentActiveJob = null;
      try {
        const { notifyRenameJobFinished } = await import('./handlers/indexer');
        const showTitle = job.customTitle || job.verifiedMeta?.title || parseFilename(job.originalFileName).title;
        await notifyRenameJobFinished(job.category, showTitle, job.verifiedMeta?.tmdb_id);
      } catch (notifyErr) {
        logger.debug({ notifyErr }, 'Error notifying rename job completion to indexer');
      }
    }
    return;
  }

  const parsed = parseFilename(job.originalFileName);
  if (job.customTitle) parsed.title = job.customTitle;
  if (job.customYear) parsed.year = job.customYear;
  const targetFileName = formatRenamedFilename(parsed, job.originalFileName);

  logger.info(`⚡ Starting Download & Rename Pipeline:`);
  logger.info(`   Source: ${job.originalFileName}`);
  logger.info(`   Target: ${targetFileName}`);
  logger.info(`   Destination: ${destinationChannel}`);

  // Channel live progress notification so channel admins can monitor and cancel
  let progressMsgId: number | null = null;
  let lastProgressEditTime = 0;
  const PROGRESS_THROTTLE_MS = 2500;
  const sizeMB = (job.fileSize / (1024 * 1024)).toFixed(1);

  try {
    const initialText =
      `⚡ <code>${targetFileName}</code> (${sizeMB} MB)\n` +
      `⏳ Initializing download...`;

    const sent = await bot.telegram.sendMessage(destinationChannel, initialText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛑 Cancel', callback_data: `cancel_rename:${job.id}` }]
        ]
      }
    });
    progressMsgId = sent.message_id;
    job.progressMsgId = progressMsgId;
  } catch (notifyErr) {
    logger.debug({ notifyErr, destinationChannel }, 'Could not send initial progress message to channel');
  }

  const updateChannelProgress = async (statusText: string, force = false, showButton = true) => {
    if (!destinationChannel || !progressMsgId) return;
    const now = Date.now();
    if (!force && now - lastProgressEditTime < PROGRESS_THROTTLE_MS) return;
    lastProgressEditTime = now;

    const text =
      `⚡ <code>${targetFileName}</code> (${sizeMB} MB)\n` +
      `⏳ ${statusText}`;

    const extra: any = { parse_mode: 'HTML' };
    if (showButton) {
      extra.reply_markup = {
        inline_keyboard: [
          [{ text: '🛑 Cancel', callback_data: `cancel_rename:${job.id}` }]
        ]
      };
    }

    try {
      await bot.telegram.editMessageText(destinationChannel, progressMsgId, undefined, text, extra);
    } catch {
      // Ignore Telegram rate limit or unedited text errors
    }
  };

  // Telegram Bot MTProto upload limit is 2,000 MB (upload.SaveBigFilePart limit)
  const MAX_BOT_UPLOAD_BYTES = 2000 * 1024 * 1024;
  if (job.fileSize > MAX_BOT_UPLOAD_BYTES) {
    logger.warn(`⚠️ File "${job.originalFileName}" (${sizeMB} MB) exceeds Telegram's 2,000 MB bot re-upload limit.`);
    logger.info(`⏩ Forwarding message directly to ${destinationChannel} to preserve file without upload limit...`);

    try {
      if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

      const forwardedMsgs = await mtClient.forwardMessages(destinationChannel, {
        messages: [job.sourceMessageId],
        fromPeer: job.sourceChannelId,
      });

      const forwardedMsg = forwardedMsgs?.[0];
      if (forwardedMsg) {
        const { handleUploadedRenamedMedia } = await import('./handlers/indexer');
        await handleUploadedRenamedMedia(forwardedMsg, job.category, targetFileName, destinationChannel, job.fileSize, job.verifiedMeta, job.id);
        logger.info(`✅ Successfully forwarded & indexed oversized file: ${targetFileName}`);

        if (destinationChannel && progressMsgId) {
          bot.telegram.editMessageText(
            destinationChannel,
            progressMsgId,
            undefined,
            `✅ <code>${targetFileName}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});

          setTimeout(() => {
            bot.telegram.deleteMessage(destinationChannel, progressMsgId!).catch(() => {});
          }, 10000);
        }
      }
    } catch (fwdErr: any) {
      if (fwdErr?.message === 'CANCELED_BY_ADMIN' || job.isCancelled) {
        logger.warn(`🛑 Oversized forward for "${job.originalFileName}" was cancelled.`);
        if (destinationChannel && progressMsgId) {
          bot.telegram.editMessageText(
            destinationChannel,
            progressMsgId,
            undefined,
            `🛑 Cancelled: <code>${job.originalFileName}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});

          setTimeout(() => {
            bot.telegram.deleteMessage(destinationChannel, progressMsgId!).catch(() => {});
          }, 10000);
        }
      } else {
        logger.error({ fwdErr }, `Failed to forward oversized file: ${job.originalFileName}`);
      }
    } finally {
      currentActiveJob = null;
      try {
        const { notifyRenameJobFinished } = await import('./handlers/indexer');
        const showTitle = job.customTitle || job.verifiedMeta?.title || parseFilename(job.originalFileName).title;
        await notifyRenameJobFinished(job.category, showTitle, job.verifiedMeta?.tmdb_id);
      } catch (notifyErr) {
        logger.debug({ notifyErr }, 'Error notifying rename job completion to indexer');
      }
    }
    return;
  }

  // Create temporary directory on disk
  const tempDir = path.join(os.tmpdir(), 'vinehill_cache');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFilePath = path.join(tempDir, targetFileName);

  try {
    if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

    // 1. Fetch source message
    const messages = await mtClient.getMessages(job.sourceChannelId, {
      ids: [job.sourceMessageId],
    });

    const msg = messages?.[0];
    if (!msg || !msg.media) {
      throw new Error(`Source message or media not found: id ${job.sourceMessageId}`);
    }

    if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

    // 2. Download to disk with progress tracking
    logger.info(`📥 Downloading file to NVMe temporary cache...`);
    let lastLoggedPercent = 0;
    await mtClient.downloadMedia(msg.media, {
      outputFile: tempFilePath,
      progressCallback: ((downloaded: any, total: any) => {
        if (job.isCancelled) {
          throw new Error('CANCELED_BY_ADMIN');
        }
        const percent = total ? Math.floor((Number(downloaded) / Number(total)) * 100) : 0;
        if (percent >= lastLoggedPercent + 20 || percent === 100) {
          lastLoggedPercent = percent;
          logger.info(`   Download progress: ${percent}%`);
          updateChannelProgress(`📥 Downloading: <b>${percent}%</b>`);
        }
      }) as any,
    });

    if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

    logger.info(`✅ Download complete. Preparing upload as "${targetFileName}"...`);
    await updateChannelProgress(`⚙️ Uploading <code>${targetFileName}</code>...`, true);

    // 3. Upload to target channel with compact caption (file name only)
    const caption = `<code>${targetFileName}</code>`;

    let lastUploadPercent = 0;
    const uploadedMessage = await mtClient.sendFile(destinationChannel, {
      file: tempFilePath,
      caption,
      parseMode: 'html',
      forceDocument: true,
      progressCallback: (progress: number) => {
        if (job.isCancelled) {
          throw new Error('CANCELED_BY_ADMIN');
        }
        const percent = Math.floor(progress * 100);
        if (percent >= lastUploadPercent + 20 || percent === 100) {
          lastUploadPercent = percent;
          logger.info(`   Upload progress: ${percent}%`);
          updateChannelProgress(`📤 Uploading: <b>${percent}%</b>`);
        }
      },
    });

    if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

    logger.info(`🎉 File successfully renamed and re-uploaded to ${destinationChannel} (Message ID: ${uploadedMessage.id})!`);

    // 4. Pass the newly uploaded media to the indexer so it announces and indexes from the renamed channel
    const { handleUploadedRenamedMedia } = await import('./handlers/indexer');
    await handleUploadedRenamedMedia(uploadedMessage, job.category, targetFileName, destinationChannel, job.fileSize, job.verifiedMeta, job.id);

    if (destinationChannel && progressMsgId) {
      bot.telegram.editMessageText(
        destinationChannel,
        progressMsgId,
        undefined,
        `✅ <code>${targetFileName}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});

      setTimeout(() => {
        bot.telegram.deleteMessage(destinationChannel, progressMsgId!).catch(() => {});
      }, 10000);
    }

  } catch (err: any) {
    if (err?.message === 'CANCELED_BY_ADMIN' || job.isCancelled) {
      logger.warn(`🛑 Job ${job.id} for "${job.originalFileName}" was cancelled.`);
      if (destinationChannel && progressMsgId) {
        bot.telegram.editMessageText(
          destinationChannel,
          progressMsgId,
          undefined,
          `🛑 Cancelled: <code>${job.originalFileName}</code>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        setTimeout(() => {
          bot.telegram.deleteMessage(destinationChannel, progressMsgId!).catch(() => {});
        }, 10000);
      }
    } else {
      logger.error({ err }, `Pipeline failed for ${job.originalFileName}`);
      if (destinationChannel && progressMsgId) {
        bot.telegram.editMessageText(
          destinationChannel,
          progressMsgId,
          undefined,
          `❌ Failed: <code>${job.originalFileName}</code>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});

        setTimeout(() => {
          bot.telegram.deleteMessage(destinationChannel, progressMsgId!).catch(() => {});
        }, 10000);
      }
    }
  } finally {
    currentActiveJob = null;
    // Notify indexer that this job has completed/exited
    try {
      const { notifyRenameJobFinished } = await import('./handlers/indexer');
      const showTitle = job.customTitle || job.verifiedMeta?.title || parseFilename(job.originalFileName).title;
      await notifyRenameJobFinished(job.category, showTitle, job.verifiedMeta?.tmdb_id);
    } catch (notifyErr) {
      logger.debug({ notifyErr }, 'Error notifying rename job completion to indexer');
    }

    // 5. Always delete the temporary file to keep disk clear
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        logger.info(`🧹 Cleaned up temporary file: ${tempFilePath}`);
      } catch (cleanErr) {
        logger.warn({ cleanErr }, 'Failed to remove temp file');
      }
    }
  }
}

