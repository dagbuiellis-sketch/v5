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
const sessionString = process.env.TELEGRAM_SESSION || '';

let client: TelegramClient | null = null;
let isClientReady = false;

export async function initMTProtoClient(): Promise<TelegramClient | null> {
  if (client && isClientReady) return client;
  if (!apiId || !apiHash || !botToken) {
    logger.warn('MTProto Client not configured (API_ID, API_HASH, or BOT_TOKEN missing). Running in Telegraf fallback mode.');
    return null;
  }

  try {
    const session = new StringSession(sessionString);
    client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      useWSS: false,
    });

    await client.start({
      botAuthToken: botToken,
    });

    isClientReady = true;
    logger.info('🚀 GramJS MTProto client initialized successfully (2GB file pipeline active)!');
    return client;
  } catch (error) {
    logger.error({ err: error }, 'Failed to start GramJS MTProto client');
    client = null;
    isClientReady = false;
    return null;
  }
}

import { bot, getAdminId } from './client';

export interface RenameJob {
  id?: string;
  sourceChannelId: string;
  sourceMessageId: number;
  originalFileName: string;
  fileSize: number;
  category: 'movies' | 'series' | 'anime' | string;
  isCancelled?: boolean;
  progressMsgId?: number;
  adminChatId?: string | number;
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

async function executeRenameJob(job: RenameJob) {
  currentActiveJob = job;
  const mtClient = await initMTProtoClient();
  if (!mtClient) {
    logger.warn(`Skipping MTProto rename for ${job.originalFileName} because API_ID/API_HASH are not configured.`);
    currentActiveJob = null;
    return;
  }

  const destinationChannel = RENAMED_CHANNELS[job.category];
  if (!destinationChannel) {
    logger.error(`No destination channel found for category: ${job.category}`);
    currentActiveJob = null;
    return;
  }

  const parsed = parseFilename(job.originalFileName);
  const targetFileName = formatRenamedFilename(parsed, job.originalFileName);

  logger.info(`⚡ Starting Download & Rename Pipeline:`);
  logger.info(`   Source: ${job.originalFileName}`);
  logger.info(`   Target: ${targetFileName}`);
  logger.info(`   Destination: ${destinationChannel}`);

  // Admin live progress notification
  const adminId = getAdminId();
  let progressMsgId: number | null = null;
  let lastProgressEditTime = 0;
  const PROGRESS_THROTTLE_MS = 2500;
  const sizeMB = (job.fileSize / (1024 * 1024)).toFixed(1);

  if (adminId) {
    try {
      const initialText =
        `⚡ <b>Downloading & Renaming Media</b>\n\n` +
        `📁 <b>File:</b> <code>${job.originalFileName}</code>\n` +
        `🏷 <b>Target:</b> <code>${targetFileName}</code>\n` +
        `📦 <b>Size:</b> ${sizeMB} MB | <b>Category:</b> ${job.category}\n` +
        `⏳ <b>Status:</b> Initializing download...`;

      const sent = await bot.telegram.sendMessage(adminId, initialText, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛑 Cancel Download & Rename', callback_data: `cancel_rename:${job.id}` }]
          ]
        }
      });
      progressMsgId = sent.message_id;
      job.progressMsgId = progressMsgId;
      job.adminChatId = adminId;
    } catch (notifyErr) {
      logger.debug({ notifyErr }, 'Could not send initial progress message to admin');
    }
  }

  const updateAdminProgress = async (statusText: string, force = false, showButton = true) => {
    if (!adminId || !progressMsgId) return;
    const now = Date.now();
    if (!force && now - lastProgressEditTime < PROGRESS_THROTTLE_MS) return;
    lastProgressEditTime = now;

    const text =
      `⚡ <b>Downloading & Renaming Media</b>\n\n` +
      `📁 <b>File:</b> <code>${job.originalFileName}</code>\n` +
      `🏷 <b>Target:</b> <code>${targetFileName}</code>\n` +
      `📦 <b>Size:</b> ${sizeMB} MB | <b>Category:</b> ${job.category}\n` +
      `⏳ <b>Status:</b> ${statusText}`;

    const extra: any = { parse_mode: 'HTML' };
    if (showButton) {
      extra.reply_markup = {
        inline_keyboard: [
          [{ text: '🛑 Cancel Download & Rename', callback_data: `cancel_rename:${job.id}` }]
        ]
      };
    }

    try {
      await bot.telegram.editMessageText(adminId, progressMsgId, undefined, text, extra);
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
        await handleUploadedRenamedMedia(forwardedMsg, job.category, targetFileName, destinationChannel);
        logger.info(`✅ Successfully forwarded & indexed oversized file: ${targetFileName}`);

        if (adminId && progressMsgId) {
          bot.telegram.editMessageText(
            adminId,
            progressMsgId,
            undefined,
            `✅ <b>Oversized File Forwarded & Indexed!</b>\n\n🏷 <b>File:</b> <code>${targetFileName}</code>\n📢 <b>Destination:</b> ${destinationChannel}`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    } catch (fwdErr: any) {
      if (fwdErr?.message === 'CANCELED_BY_ADMIN' || job.isCancelled) {
        logger.warn(`🛑 Oversized forward for "${job.originalFileName}" was cancelled.`);
        if (adminId && progressMsgId) {
          bot.telegram.editMessageText(
            adminId,
            progressMsgId,
            undefined,
            `🛑 <b>Download & Rename Cancelled</b>\n\n📁 File: <code>${job.originalFileName}</code>\n📋 Remaining queue: <b>${renameQueue.length}</b> job(s) intact.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      } else {
        logger.error({ fwdErr }, `Failed to forward oversized file: ${job.originalFileName}`);
      }
    } finally {
      currentActiveJob = null;
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
          updateAdminProgress(`📥 Downloading from storage: <b>${percent}%</b>`);
        }
      }) as any,
    });

    if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

    logger.info(`✅ Download complete. Preparing upload as "${targetFileName}"...`);
    await updateAdminProgress(`⚙️ Download complete. Uploading as <code>${targetFileName}</code>...`, true);

    // 3. Upload to target channel with the new filename and formatted caption
    const yearStr = parsed.year ? ` (${parsed.year})` : '';
    const episodeStr = (parsed.season && parsed.episode) ? ` S${parsed.season}E${parsed.episode}` : '';
    const caption = `🎬 <b>${parsed.title}${yearStr}${episodeStr}</b>\n🏷 <i>${targetFileName}</i>\n\n@VinehillMain`;

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
          updateAdminProgress(`📤 Uploading to ${destinationChannel}: <b>${percent}%</b>`);
        }
      },
    });

    if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');

    logger.info(`🎉 File successfully renamed and re-uploaded to ${destinationChannel} (Message ID: ${uploadedMessage.id})!`);

    // 4. Pass the newly uploaded media to the indexer so it announces and indexes from the renamed channel
    const { handleUploadedRenamedMedia } = await import('./handlers/indexer');
    await handleUploadedRenamedMedia(uploadedMessage, job.category, targetFileName, destinationChannel);

    if (adminId && progressMsgId) {
      bot.telegram.editMessageText(
        adminId,
        progressMsgId,
        undefined,
        `✅ <b>Download & Rename Complete!</b>\n\n` +
        `🏷 <b>File:</b> <code>${targetFileName}</code>\n` +
        `📢 <b>Destination:</b> ${destinationChannel}\n` +
        `🤡 Media indexed and queued for announcement.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

  } catch (err: any) {
    if (err?.message === 'CANCELED_BY_ADMIN' || job.isCancelled) {
      logger.warn(`🛑 Job ${job.id} for "${job.originalFileName}" was cancelled by admin.`);
      if (adminId && progressMsgId) {
        const remainingCount = renameQueue.length;
        const cancelText =
          `🛑 <b>Download & Rename Cancelled</b>\n\n` +
          `📁 <b>File:</b> <code>${job.originalFileName}</code>\n` +
          `🧹 Temporary cache cleared immediately.\n` +
          `📋 Remaining queue: <b>${remainingCount}</b> job(s) intact.`;
        bot.telegram.editMessageText(adminId, progressMsgId, undefined, cancelText, { parse_mode: 'HTML' }).catch(() => {});
      }
    } else {
      logger.error({ err }, `Pipeline failed for ${job.originalFileName}`);
      if (adminId && progressMsgId) {
        bot.telegram.editMessageText(
          adminId,
          progressMsgId,
          undefined,
          `❌ <b>Download & Rename Failed</b>\n\n📁 File: <code>${job.originalFileName}</code>\n⚠️ Error: <code>${err?.message || 'Unknown error'}</code>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }
  } finally {
    currentActiveJob = null;
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

