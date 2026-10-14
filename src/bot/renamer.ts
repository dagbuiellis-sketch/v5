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

export interface RenameJob {
  sourceChannelId: string;
  sourceMessageId: number;
  originalFileName: string;
  fileSize: number;
  category: 'movies' | 'series' | 'anime' | string;
}

const renameQueue: RenameJob[] = [];
let isProcessingRename = false;

export function queueRenameJob(job: RenameJob) {
  renameQueue.push(job);
  logger.info(`Queued rename job for ${job.originalFileName} (${(job.fileSize / (1024 * 1024)).toFixed(1)} MB)`);
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
  const mtClient = await initMTProtoClient();
  if (!mtClient) {
    logger.warn(`Skipping MTProto rename for ${job.originalFileName} because API_ID/API_HASH are not configured.`);
    return;
  }

  const destinationChannel = RENAMED_CHANNELS[job.category];
  if (!destinationChannel) {
    logger.error(`No destination channel found for category: ${job.category}`);
    return;
  }

  const parsed = parseFilename(job.originalFileName);
  const targetFileName = formatRenamedFilename(parsed, job.originalFileName);

  logger.info(`⚡ Starting Download & Rename Pipeline:`);
  logger.info(`   Source: ${job.originalFileName}`);
  logger.info(`   Target: ${targetFileName}`);
  logger.info(`   Destination: ${destinationChannel}`);

  // Telegram Bot MTProto upload limit is 2,000 MB (upload.SaveBigFilePart limit)
  const MAX_BOT_UPLOAD_BYTES = 2000 * 1024 * 1024;
  if (job.fileSize > MAX_BOT_UPLOAD_BYTES) {
    const sizeMB = (job.fileSize / (1024 * 1024)).toFixed(1);
    logger.warn(`⚠️ File "${job.originalFileName}" (${sizeMB} MB) exceeds Telegram's 2,000 MB bot re-upload limit.`);
    logger.info(`⏩ Forwarding message directly to ${destinationChannel} to preserve file without upload limit...`);

    try {
      const forwardedMsgs = await mtClient.forwardMessages(destinationChannel, {
        messages: [job.sourceMessageId],
        fromPeer: job.sourceChannelId,
      });

      const forwardedMsg = forwardedMsgs?.[0];
      if (forwardedMsg) {
        const { handleUploadedRenamedMedia } = await import('./handlers/indexer');
        await handleUploadedRenamedMedia(forwardedMsg, job.category, targetFileName, destinationChannel);
        logger.info(`✅ Successfully forwarded & indexed oversized file: ${targetFileName}`);
      }
    } catch (fwdErr) {
      logger.error({ fwdErr }, `Failed to forward oversized file: ${job.originalFileName}`);
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
    // 1. Fetch source message
    const messages = await mtClient.getMessages(job.sourceChannelId, {
      ids: [job.sourceMessageId],
    });

    const msg = messages?.[0];
    if (!msg || !msg.media) {
      throw new Error(`Source message or media not found: id ${job.sourceMessageId}`);
    }

    // 2. Download to disk with progress tracking
    logger.info(`📥 Downloading file to NVMe temporary cache...`);
    let lastLoggedPercent = 0;
    await mtClient.downloadMedia(msg.media, {
      outputFile: tempFilePath,
      progressCallback: ((downloaded: any, total: any) => {
        const percent = total ? Math.floor((Number(downloaded) / Number(total)) * 100) : 0;
        if (percent >= lastLoggedPercent + 25) {
          lastLoggedPercent = percent;
          logger.info(`   Download progress: ${percent}%`);
        }
      }) as any,
    });

    logger.info(`✅ Download complete. Preparing upload as "${targetFileName}"...`);

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
        const percent = Math.floor(progress * 100);
        if (percent >= lastUploadPercent + 25) {
          lastUploadPercent = percent;
          logger.info(`   Upload progress: ${percent}%`);
        }
      },
    });

    logger.info(`🎉 File successfully renamed and re-uploaded to ${destinationChannel} (Message ID: ${uploadedMessage.id})!`);

    // 4. Pass the newly uploaded media to the indexer so it announces and indexes from the renamed channel
    const { handleUploadedRenamedMedia } = await import('./handlers/indexer');
    await handleUploadedRenamedMedia(uploadedMessage, job.category, targetFileName, destinationChannel);

  } catch (err) {
    logger.error({ err }, `Pipeline failed for ${job.originalFileName}`);
  } finally {
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
