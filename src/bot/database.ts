import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { pino } from 'pino';
import { fsAddFile, fsGetFiles, syncSqliteToFirestore } from '../services/firebaseService';

const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

function cleanEnvPath(val?: string): string {
  if (!val) return '';
  return val.trim().replace(/^["']|["']$/g, '').trim();
}

const rawDbPath = cleanEnvPath(process.env.DB_PATH);
const rawDataDir = cleanEnvPath(process.env.DATA_DIR);

let finalDbPath: string;
if (rawDbPath) {
  finalDbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(process.cwd(), rawDbPath);
} else if (rawDataDir) {
  finalDbPath = path.isAbsolute(rawDataDir) ? path.join(rawDataDir, 'vinehill.db') : path.resolve(process.cwd(), rawDataDir, 'vinehill.db');
} else {
  finalDbPath = path.resolve(process.cwd(), 'data', 'vinehill.db');
}

const dbDir = path.dirname(finalDbPath);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    logger.info(`Created database directory at: ${dbDir}`);
  } catch (err) {
    logger.error({ err, dbDir }, 'Failed to create database directory');
  }
}

if (fs.existsSync(finalDbPath) && fs.statSync(finalDbPath).isDirectory()) {
  logger.warn(`Configured DB_PATH ${finalDbPath} is a directory! Using ${path.join(finalDbPath, 'vinehill.db')} instead.`);
  finalDbPath = path.join(finalDbPath, 'vinehill.db');
}

logger.info(`Connecting SQLite database at: ${finalDbPath}`);

// Ensure DB exists
export const db = new Database(finalDbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

export async function initDb() {
  logger.info('Initializing Database...');
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      year INTEGER,
      category TEXT NOT NULL,
      quality TEXT,
      season INTEGER,
      episode INTEGER,
      file_id TEXT NOT NULL UNIQUE,
      file_name TEXT,
      file_size INTEGER,
      tags TEXT,
      tmdb_id INTEGER,
      poster_url TEXT,
      overview TEXT,
      rating TEXT,
      genres TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_banned INTEGER DEFAULT 0,
      request_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      file_ids TEXT NOT NULL,
      msg_ids TEXT NOT NULL,
      delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delete_at DATETIME,
      deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      query TEXT,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, title, category)
    );

    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, title, category)
    );

    CREATE TABLE IF NOT EXISTS search_history (
      user_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      searched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      msg_id INTEGER NOT NULL,
      main_msg_id INTEGER,
      channel TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(title, category)
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS reports (
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      reported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, title, category)
    );

    CREATE INDEX IF NOT EXISTS idx_files_title ON files(title);
    CREATE INDEX IF NOT EXISTS idx_files_category ON files(category);
    CREATE INDEX IF NOT EXISTS idx_files_category_title ON files(category, title);
    CREATE INDEX IF NOT EXISTS idx_files_added_at ON files(added_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_lookup ON files(title, quality, season, episode);
    CREATE INDEX IF NOT EXISTS idx_deliveries_pending_delete ON deliveries(deleted, delete_at);
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
    CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);
    CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id);
  `);

  // Migration: Add main_msg_id if missing from announcements
  const tableInfo = db.prepare("PRAGMA table_info(announcements)").all() as any[];
  const hasMainMsgId = tableInfo.some(col => col.name === 'main_msg_id');
  if (!hasMainMsgId) {
    logger.info('Migrating announcements table: adding main_msg_id column...');
    db.exec('ALTER TABLE announcements ADD COLUMN main_msg_id INTEGER');
  }

  // Migration: Add channel_id and message_id to files table for robust copyMessage delivery
  const filesCols = db.prepare("PRAGMA table_info(files)").all() as any[];
  if (!filesCols.some(col => col.name === 'channel_id')) {
    logger.info('Migrating files table: adding channel_id column...');
    db.exec('ALTER TABLE files ADD COLUMN channel_id TEXT');
  }
  if (!filesCols.some(col => col.name === 'message_id')) {
    logger.info('Migrating files table: adding message_id column...');
    db.exec('ALTER TABLE files ADD COLUMN message_id INTEGER');
  }
  
  logger.info('Database Schema Verified.');

  // Check if local DB is empty, if so, restore from cloud
  const fileCount = (db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number }).count;
  if (fileCount === 0) {
    logger.info('Local database empty. Restoring from Cloud (Firestore)...');
    try {
      const cloudFiles = await fsGetFiles();
      if (cloudFiles.length > 0) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO files 
          (title, year, category, quality, season, episode, file_id, file_name, file_size, tags, tmdb_id, poster_url, overview, rating, genres, added_at)
          VALUES 
          (@title, @year, @category, @quality, @season, @episode, @file_id, @file_name, @file_size, @tags, @tmdb_id, @poster_url, @overview, @rating, @genres, @added_at)
        `);
        
        db.transaction(() => {
          for (const f of cloudFiles) {
            stmt.run(f);
          }
        })();
        logger.info(`Restored ${cloudFiles.length} files from cloud.`);
      }
    } catch (e) {
      logger.error({ err: e }, 'Failed to restore from cloud');
    }
  }
}

// User Helpers
export const upsertUser = (id: number, username: string | undefined, first_name: string) => {
  const stmt = db.prepare(`
    INSERT INTO users (id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name
  `);
  return stmt.run(id, username || null, first_name);
};

export const isBanned = (id: number) => {
  const row = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(id) as { is_banned: number } | undefined;
  return !!row?.is_banned;
};

// File Helpers
export const addFile = (data: any) => {
  const stmt = db.prepare(`
    INSERT INTO files 
    (title, year, category, quality, season, episode, file_id, file_name, file_size, tags, tmdb_id, poster_url, overview, rating, genres, channel_id, message_id)
    VALUES 
    (@title, @year, @category, @quality, @season, @episode, @file_id, @file_name, @file_size, @tags, @tmdb_id, @poster_url, @overview, @rating, @genres, @channel_id, @message_id)
  `);
  const result = stmt.run({
    ...data,
    channel_id: data.channel_id || null,
    message_id: data.message_id || null,
  });
  
  // Sync to Cloud
  fsAddFile(data).catch(err => {
    logger.warn({ err }, 'Failed to sync file to cloud');
  });
  
  return result;
};

export const updateFileLocation = (fileId: string, channelId: string, messageId: number) => {
  return db.prepare('UPDATE files SET channel_id = ?, message_id = ? WHERE file_id = ?').run(channelId, messageId, fileId);
};

export const fileExists = (title: string, quality: string, season: number | null, episode: number | null) => {
  const row = db.prepare(`
    SELECT id FROM files 
    WHERE title = ? AND quality = ? AND season IS ? AND episode IS ?
  `).get(title, quality, season, episode);
  return !!row;
};

// Title cleaner helper
export const cleanTitle = (title: string): string => {
  return title
    .replace(/@\w+/g, '') // Remove telegram tags like @RUFFGSERIES
    .replace(/\.[a-zA-Z0-9]{3,4}$/i, '') // Remove extensions like .mp4
    .replace(/\b(mp4|mkv|avi|h264|x265|webrip|bluray|aac|dd5\.1|dual-audio|multi|web-dl|hevc|10bit)\b/gi, '') // Remove typical rip info
    .replace(/[._]/g, ' ') // Replace dots and underscores with spaces
    .replace(/\s+/g, ' ') // Collapse spaces
    .trim();
};

export const getRecentlyAdded = (limit = 12) => {
  return db.prepare(`
    SELECT DISTINCT f.title, f.year, f.category, f.season, f.episode, f.rating, f.poster_url 
    FROM files f
    WHERE f.file_id IS NOT NULL AND f.file_id != ''
    AND (SELECT COUNT(*) FROM reports WHERE title = f.title AND category = f.category) < 3
    ORDER BY f.added_at DESC 
    LIMIT ?
  `).all(limit) as any[];
};

export const getAllMediaUnique = () => {
  return db.prepare(`
    SELECT * FROM (
      SELECT title, year, category, poster_url, overview, rating, genres, tmdb_id, season, episode, tags,
             ROW_NUMBER() OVER (PARTITION BY title, category ORDER BY season DESC, episode DESC) as rn
      FROM files
      WHERE file_id IS NOT NULL AND file_id != ''
    ) WHERE rn = 1
  `).all() as any[];
};

export const getSeriesSeasons = (title: string, category: string) => {
  const rows = db.prepare(`
    SELECT DISTINCT season FROM files 
    WHERE title = ? AND category = ? AND season IS NOT NULL AND file_id IS NOT NULL AND file_id != ''
    ORDER BY season ASC
  `).all(title, category) as { season: number }[];
  return rows.map(r => r.season);
};

export const getSeasonFiles = (title: string, season: number, category: string) => {
  return db.prepare(`
    SELECT * FROM files 
    WHERE title = ? AND season = ? AND category = ? AND file_id IS NOT NULL AND file_id != ''
    ORDER BY episode ASC
  `).all(title, season, category) as any[];
};

export const checkSeriesGaps = (title: string, category: string) => {
  const seasons = getSeriesSeasons(title, category);
  const gaps: { season: number, missing: number[] }[] = [];

  for (const s of seasons) {
    const episodes = db.prepare(`
      SELECT DISTINCT episode FROM files 
      WHERE title = ? AND category = ? AND season = ? AND episode IS NOT NULL AND file_id IS NOT NULL AND file_id != ''
      ORDER BY episode ASC
    `).all(title, category, s) as { episode: number }[];

    if (episodes.length === 0) continue;

    const maxEp = episodes[episodes.length - 1].episode;
    const presentEps = new Set(episodes.map(e => e.episode));
    const missing: number[] = [];

    for (let i = 1; i < maxEp; i++) {
      if (!presentEps.has(i)) {
        missing.push(i);
      }
    }

    if (missing.length > 0) {
      gaps.push({ season: s, missing });
    }
  }

  return gaps;
};

export const getAvailableQualities = (title: string, category: string): string[] => {
  const rows = db.prepare(`
    SELECT DISTINCT quality FROM files 
    WHERE title = ? AND category = ? AND quality IS NOT NULL AND file_id IS NOT NULL AND file_id != ''
    ORDER BY CASE 
      WHEN quality = '2160P' THEN 1
      WHEN quality = '4K' THEN 1
      WHEN quality = '1080P' THEN 2
      WHEN quality = '720P' THEN 3
      WHEN quality = '480P' THEN 4
      ELSE 5 
    END ASC
  `).all(title, category) as { quality: string }[];
  return rows.map(r => r.quality);
};

export const getMoviesByTitle = (title: string) => {
  return db.prepare(`
    SELECT * FROM files 
    WHERE title = ? AND category = 'movies' AND file_id IS NOT NULL AND file_id != ''
    ORDER BY quality DESC
  `).all(title) as any[];
};

export const getGameFiles = (title: string) => {
  return db.prepare(`
    SELECT * FROM files 
    WHERE title = ? AND category = 'games' AND file_id IS NOT NULL AND file_id != ''
    ORDER BY file_name ASC
  `).all(title) as any[];
};

// Announcement Helpers
export const getAnnouncementInfo = (title: string, category: string) => {
  return db.prepare('SELECT msg_id, main_msg_id, channel FROM announcements WHERE title = ? AND category = ?').get(title, category) as { msg_id: number, main_msg_id: number | null, channel: string } | undefined;
};

export const getAllAnnouncements = () => {
  return db.prepare('SELECT * FROM announcements').all() as any[];
};

export const clearAnnouncementsTable = () => {
  return db.prepare('DELETE FROM announcements').run();
};

export const saveAnnouncementInfo = (title: string, category: string, msg_id: number, main_msg_id: number | null, channel: string) => {
  const stmt = db.prepare(`
    INSERT INTO announcements (title, category, msg_id, main_msg_id, channel)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(title, category) DO UPDATE SET 
      msg_id = excluded.msg_id,
      main_msg_id = excluded.main_msg_id,
      channel = excluded.channel
  `);
  return stmt.run(title, category, msg_id, main_msg_id, channel);
};

// Reports
export const reportMedia = (user_id: number, title: string, category: string) => {
  const stmt = db.prepare('INSERT OR IGNORE INTO reports (user_id, title, category) VALUES (?, ?, ?)');
  return stmt.run(user_id, title, category);
};

export const getReportCount = (title: string, category: string) => {
  const row = db.prepare('SELECT COUNT(*) as count FROM reports WHERE title = ? AND category = ?').get(title, category) as { count: number };
  return row.count;
};

// Deletion Trackers & Helpers
export const deleteMediaByTitle = (title: string, category: string) => {
  const transaction = db.transaction(() => {
    // Delete from files
    db.prepare('DELETE FROM files WHERE title = ? AND category = ?').run(title, category);
    // Delete favorites and likes
    db.prepare('DELETE FROM favorites WHERE title = ? AND category = ?').run(title, category);
    db.prepare('DELETE FROM likes WHERE title = ? AND category = ?').run(title, category);
    // Delete reports
    db.prepare('DELETE FROM reports WHERE title = ? AND category = ?').run(title, category);
    // Delete from announcements tracking
    db.prepare('DELETE FROM announcements WHERE title = ? AND category = ?').run(title, category);
  });
  return transaction();
};

export const purgeEmptyFiles = () => {
  return db.prepare("DELETE FROM files WHERE file_id IS NULL OR file_id = ''").run();
};

export const saveDelivery = (user_id: number, file_ids: string[], msg_ids: number[], delete_at: Date) => {
  const stmt = db.prepare(`
    INSERT INTO deliveries (user_id, file_ids, msg_ids, delete_at)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(user_id, JSON.stringify(file_ids), JSON.stringify(msg_ids), delete_at.toISOString());
};

export const getPendingDeletions = () => {
  return db.prepare(`
    SELECT * FROM deliveries 
    WHERE deleted = 0 AND delete_at <= DATETIME('now')
  `).all();
};

export const markDeleted = (id: number) => {
  return db.prepare('UPDATE deliveries SET deleted = 1 WHERE id = ?').run(id);
};

// Admin Stats
export const getStats = () => {
  try {
    const totalFiles = db.prepare("SELECT COUNT(*) as count FROM files WHERE file_id IS NOT NULL AND file_id != ''").get() as { count: number } | undefined;
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number } | undefined;
    
    let todayRequests = { count: 0 };
    try {
      todayRequests = db.prepare("SELECT COUNT(*) as count FROM requests WHERE DATE(requested_at) = DATE('now')").get() as { count: number } || { count: 0 };
    } catch (e) {
      logger.warn(`Failed to fetch todayRequests, table might be old: ${e}`);
    }
    
    const totalLikes = db.prepare('SELECT COUNT(*) as count FROM likes').get() as { count: number } | undefined;
    const totalReports = db.prepare('SELECT COUNT(*) as count FROM reports').get() as { count: number } | undefined;
    
    const byCategory = db.prepare("SELECT category, COUNT(DISTINCT title) as count FROM files WHERE file_id IS NOT NULL AND file_id != '' GROUP BY category").all() as { category: string, count: number }[];
    
    const categories: Record<string, number> = {
      movies: 0,
      series: 0,
      anime: 0,
      games: 0
    };
    
    byCategory.forEach(c => {
      if (c && c.category in categories) {
        categories[c.category] = c.count;
      }
    });

    return {
      totalFiles: totalFiles?.count || 0,
      totalUsers: totalUsers?.count || 0,
      todayRequests: todayRequests?.count || 0,
      totalLikes: totalLikes?.count || 0,
      totalReports: totalReports?.count || 0,
      movies: categories.movies,
      series: categories.series,
      anime: categories.anime,
      games: categories.games
    };
  } catch (err) {
    logger.error({ err }, 'getStats global error');
    return {
      totalFiles: 0,
      totalUsers: 0,
      todayRequests: 0,
      totalLikes: 0,
      totalReports: 0,
      movies: 0,
      series: 0,
      anime: 0,
      games: 0
    };
  }
};

export const getRecentReports = (limit = 10) => {
  return db.prepare(`
    SELECT title, category, COUNT(*) as report_count, MAX(reported_at) as last_report
    FROM reports
    GROUP BY title, category
    ORDER BY report_count DESC, last_report DESC
    LIMIT ?
  `).all(limit) as any[];
};

export const getAllUserIds = () => {
  const rows = db.prepare('SELECT id FROM users').all() as { id: number }[];
  return rows.map(r => r.id);
};

// Favorites
export const toggleFavorite = (user_id: number, title: string, category: string) => {
  const existing = db.prepare('SELECT * FROM favorites WHERE user_id = ? AND title = ? AND category = ?').get(user_id, title, category);
  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND title = ? AND category = ?').run(user_id, title, category);
    return false;
  } else {
    db.prepare('INSERT INTO favorites (user_id, title, category) VALUES (?, ?, ?)').run(user_id, title, category);
    return true;
  }
};

export const getFavorites = (user_id: number) => {
  return db.prepare(`
    SELECT f.title, f.category, m.poster_url, m.rating, m.year 
    FROM favorites f
    LEFT JOIN files m ON f.title = m.title AND f.category = m.category
    WHERE f.user_id = ? AND m.file_id IS NOT NULL
    GROUP BY f.title, f.category
  `).all(user_id) as any[];
};

// Likes
export const toggleLike = (user_id: number, title: string, category: string) => {
  const existing = db.prepare('SELECT * FROM likes WHERE user_id = ? AND title = ? AND category = ?').get(user_id, title, category);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND title = ? AND category = ?').run(user_id, title, category);
    return false;
  } else {
    db.prepare('INSERT INTO likes (user_id, title, category) VALUES (?, ?, ?)').run(user_id, title, category);
    return true;
  }
};

export const getLikeCount = (title: string, category: string) => {
  const row = db.prepare('SELECT COUNT(*) as count FROM likes WHERE title = ? AND category = ?').get(title, category) as { count: number };
  return row.count;
};

// Search History
export const addSearchHistory = (user_id: number, query: string) => {
  if (!query.trim()) return;
  db.prepare('INSERT INTO search_history (user_id, query) VALUES (?, ?)').run(user_id, query.trim().toLowerCase());
  // Keep only last 10
  db.prepare(`
    DELETE FROM search_history 
    WHERE user_id = ? AND rowid NOT IN (
      SELECT rowid FROM search_history WHERE user_id = ? ORDER BY searched_at DESC LIMIT 10
    )
  `).run(user_id, user_id);
};

export const getSearchHistory = (user_id: number) => {
  return db.prepare('SELECT DISTINCT query FROM search_history WHERE user_id = ? ORDER BY searched_at DESC LIMIT 5').all(user_id) as { query: string }[];
};

// Recommendations
export const getSimilarMedia = (title: string, category: string, limit = 5) => {
  // Get genres of target
  const target = db.prepare('SELECT genres FROM files WHERE title = ? AND category = ? LIMIT 1').get(title, category) as { genres: string } | undefined;
  
  if (!target || !target.genres) {
    return db.prepare(`
      SELECT DISTINCT title, category, poster_url 
      FROM files 
      WHERE category = ? AND title != ? AND file_id IS NOT NULL
      ORDER BY rating DESC LIMIT ?
    `).all(category, title, limit) as any[];
  } else {
    const firstGenre = target.genres.split(',')[0].trim();
    return db.prepare(`
      SELECT DISTINCT title, category, poster_url, rating 
      FROM files 
      WHERE category = ? AND title != ? AND genres LIKE ? AND file_id IS NOT NULL
      ORDER BY rating DESC LIMIT ?
    `).all(category, title, `%${firstGenre}%`, limit) as any[];
  }
};

// Requests
export const saveRequest = (user_id: number, query: string) => {
  return db.prepare('INSERT INTO requests (user_id, query) VALUES (?, ?)').run(user_id, query);
};

// Config Helpers
export const getConfig = (key: string): string | null => {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
};

export const setConfig = (key: string, value: string) => {
  const stmt = db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return stmt.run(key, value);
};

export const flashWipeDatabase = () => {
  const tables = ['files', 'announcements', 'reports', 'requests', 'users', 'likes'];
  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();
  return true;
};

export const repairTitles = async () => {
  const { parseFilename } = await import('./file_parser');
  const { searchTMDB } = await import('./tmdb');
  const files = db.prepare("SELECT * FROM files").all() as any[];
  
  const updateStmt = db.prepare(`
    UPDATE files SET 
      title = ?, year = ?, quality = ?, season = ?, episode = ?, tags = ?,
      tmdb_id = ?, poster_url = ?, overview = ?, rating = ?, genres = ?
    WHERE id = ?
  `);

  logger.info(`Starting repair for ${files.length} files...`);

  // First pass: Normal parsing
  const parsedFiles = files.map(f => ({
    id: f.id,
    parsed: parseFilename(f.file_name),
    tmdb_id: f.tmdb_id,
    category: f.category
  }));

  // Group by title to minimize TMDB searches
  const uniqueTitles = Array.from(new Set(parsedFiles.map(p => `${p.parsed.title}:${p.category}:${p.parsed.year}`)));
  const titleMeta: Record<string, any> = {};

  for (const tKey of uniqueTitles) {
    const [title, category, yearStr] = tKey.split(':');
    const year = yearStr === 'null' ? null : parseInt(yearStr);
    titleMeta[tKey] = await searchTMDB(title, year, category);
  }

  db.transaction(() => {
    for (const item of parsedFiles) {
      const tKey = `${item.parsed.title}:${item.category}:${item.parsed.year}`;
      const meta = titleMeta[tKey] || {};
      
      const title = meta.title || item.parsed.title;
      const year = meta.year || item.parsed.year;

      updateStmt.run(
        title, year, item.parsed.quality, item.parsed.season, item.parsed.episode, item.parsed.tags,
        meta.tmdb_id || item.tmdb_id,
        meta.poster_url, meta.overview, meta.rating, meta.genres,
        item.id
      );
    }
  })();

  // Second pass: Unify Titles by TMDB ID
  // If multiple titles have the same tmdb_id, pick one (most frequent or first)
  const allFiles = db.prepare("SELECT id, title, tmdb_id FROM files WHERE tmdb_id IS NOT NULL").all() as any[];
  const tmdbUnification: Record<number, string> = {};
  for (const f of allFiles) {
    if (!tmdbUnification[f.tmdb_id]) {
      tmdbUnification[f.tmdb_id] = f.title;
    }
  }

  db.transaction(() => {
    const unifyStmt = db.prepare("UPDATE files SET title = ? WHERE tmdb_id = ?");
    for (const [id, title] of Object.entries(tmdbUnification)) {
      unifyStmt.run(title, id);
    }
  })();

  return files.length;
};

export default db;
