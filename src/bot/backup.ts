import fs from 'fs';
import path from 'path';
import { bot, getAdminId } from './client';
import { pino } from 'pino';
import cron from 'node-cron';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

const DB_PATH = path.join(process.cwd(), 'vinehill.db');
const BACKUP_CHANNEL = process.env.BACKUP_CHANNEL;

export function setupBackup() {
  if (!BACKUP_CHANNEL) {
    logger.warn('BACKUP_CHANNEL is not set. Database backups are disabled.');
    return;
  }

  // Schedule every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    await performBackup();
  });

  logger.info('Backup system scheduled (every 6 hours).');

  // Handle restore command
  bot.command('restore', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;

    await ctx.reply('Please forward the <code>vinehill.db</code> file from the backup channel to me.', { parse_mode: 'HTML' });
  });

  bot.on('document', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    const doc = ctx.message.document;
    
    if (doc.file_name === 'vinehill.db') {
      await ctx.reply('⏳ Restoring database...');
      
      try {
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const response = await fetch(link.href);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        fs.writeFileSync(DB_PATH, buffer);
        await ctx.reply('✅ Database restored successfully! Restarting bot recommended.');
        process.exit(0); // Exit so server-manager restarts with fresh DB
      } catch (e) {
        logger.error(`Restore failed: ${e}`);
        await ctx.reply('❌ Restore failed.');
      }
    }
  });

  // Manual backup command
  bot.command('backup', async (ctx) => {
    if (ctx.from.id.toString() !== getAdminId()) return;
    await performBackup(ctx.from.id.toString());
    await ctx.reply('✅ Backup triggered.');
  });
}

export async function performBackup(targetOverride?: string) {
  const target = targetOverride || BACKUP_CHANNEL;
  if (!target) return;

  logger.info(`Performing database backup to ${target}...`);

  try {
    if (!fs.existsSync(DB_PATH)) {
      logger.warn('DB file not found, nothing to backup.');
      return;
    }

    await bot.telegram.sendDocument(target, { source: DB_PATH }, {
      caption: `📦 #DATABASE_BACKUP\nDate: ${new Date().toLocaleString()}\nFiles: ${await getFilesCount()}`
    });
    
    logger.info('Backup sent successfully.');
  } catch (e) {
    logger.error(`Backup failed: ${e}`);
  }
}

async function getFilesCount(): Promise<number> {
    try {
        // Dynamic import to avoid circular dependency
        const { db } = await import('./database');
        const row = db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
        return row.count;
    } catch {
        return 0;
    }
}
