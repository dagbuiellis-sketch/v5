import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { bot, setupBot } from './src/bot/client';
import { initDb, getStats } from './src/bot/database';
import { registerIndexer } from './src/bot/handlers/indexer';
import { registerDownload } from './src/bot/handlers/download';
import { registerSearch } from './src/bot/handlers/search';
import { registerAdmin } from './src/bot/handlers/admin';
import { registerAnnouncer } from './src/bot/handlers/announcer';
import { registerUserHandlers } from './src/bot/handlers/user';
import { registerInlineHandlers } from './src/bot/handlers/inline';
import { setupBackup } from './src/bot/backup';
import { initMTProtoClient } from './src/bot/renamer';
import { pino } from 'pino';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

async function setBotCommands(app: any) {
  try {
    await app.telegram.setMyCommands([
      { command: 'start', description: '🏠 Main menu & Help' },
      { command: 'search', description: '🔍 Search library' },
      { command: 'trending', description: '🔥 Trending media' },
      { command: 'help', description: '🔰 How to use' },
      { command: 'request', description: '💡 Request missing media' },
      { command: 'stats', description: '📊 [ADMIN] View bot statistics' },
      { command: 'scan', description: '🔍 [ADMIN] Deep scan storage channel' },
      { command: 'cloudsync', description: '🚀 [ADMIN] Sync database to Cloud (Persistent)' },
      { command: 'broadcast', description: '📢 [ADMIN] Broadcast to all users' },
      { command: 'checkgaps', description: '⚠️ [ADMIN] Check for missing episodes' },
      { command: 'reannounce', description: '📢 [ADMIN] Force re-announce all media' },
      { command: 'delete', description: '🗑️ [ADMIN] Delete media from library' },
      { command: 'purge', description: '🧹 [ADMIN] Purge orphaned entries' },
      { command: 'backup', description: '📦 [ADMIN] Trigger manual database backup' },
      { command: 'settmdb', description: '🔑 [ADMIN] Set TMDB API Key / Token' },
      { command: 'testtmdb', description: '🧪 [ADMIN] Test TMDB API Connection' }
    ]);
    logger.info('Bot commands registered with Telegram.');
  } catch (e) {
    logger.error(`Failed to set commands: ${e}`);
  }
}

async function startServer() {
  // 1. Initialize DB & Bot
  await initDb();
  
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  setupBot();
  registerIndexer();
  registerDownload();
  registerSearch();
  registerAdmin();
  registerAnnouncer();
  registerUserHandlers(bot);
  registerInlineHandlers(bot);
  setupBackup();

  // Register commands and launch bot only if a real token is provided
  if (process.env.BOT_TOKEN) {
    await setBotCommands(bot);
    bot.launch().then(() => {
      logger.info('Telegram Bot is live!');
    }).catch(err => {
      logger.error({ err }, 'Bot launch failed:');
    });
  } else {
    logger.info('Telegram Bot polling skipped: BOT_TOKEN is not configured.');
  }

  // 1b. Initialize GramJS MTProto client for 2GB File Renaming
  if (process.env.API_ID && process.env.API_HASH) {
    initMTProtoClient().catch(err => {
      logger.error({ err }, 'GramJS MTProto initialization encountered an issue:');
    });
  }

  // 2. API Routes
  app.get('/api/stats', (req, res) => {
    try {
      const stats = getStats();
      if (!stats) throw new Error('getStats returned undefined');
      res.json(stats);
    } catch (e) {
      logger.error({ err: e }, 'Failed to fetch stats');
      res.status(500).json({ error: 'Failed to fetch stats', details: (e as any).message });
    }
  });

  app.post('/api/reannounce', async (req, res) => {
    try {
      const { reannounceAll } = await import('./src/bot/handlers/announcer');
      // Run it in the background, don't await the whole thing
      reannounceAll({
        reply: (txt: string) => logger.info(`UI Reannounce: ${txt}`)
      }).catch(err => {
        logger.error({ err }, 'Background re-announcement failed');
      });
      
      res.json({ success: true, message: 'Re-announcement started in background' });
    } catch (e) {
      logger.error({ err: e }, 'Failed to start re-announcement');
      res.status(500).json({ error: 'Mass re-announcement start failed' });
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', bot: !!bot.botInfo });
  });

  // 3. Vite Middleware for Frontend
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });
}

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

startServer().catch(err => {
  logger.error({ err }, 'GLOBAL SERVER CRASH:');
  process.exit(1);
});
