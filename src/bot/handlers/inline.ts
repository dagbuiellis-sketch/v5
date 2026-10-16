import { Telegraf } from 'telegraf';
import * as db from '../database';
import { searchTMDBCandidatesWithDiagnostics } from '../tmdb';

export function registerInlineHandlers(bot: Telegraf<any>) {
  bot.on('inline_query', async (ctx) => {
    const rawQuery = ctx.inlineQuery.query?.trim() || '';
    if (!rawQuery) return ctx.answerInlineQuery([]);

    // Check if this is a TMDB live title correction search: "tmdb:<correction_id>:<category> <query>"
    if (rawQuery.startsWith('tmdb:')) {
      const match = rawQuery.match(/^tmdb:([^:]+):([^:\s]+)\s*(.*)$/);
      if (match) {
        const correctionId = match[1];
        const category = match[2];
        const searchQuery = match[3]?.trim();

        if (!searchQuery) {
          return ctx.answerInlineQuery(
            [
              {
                type: 'article',
                id: 'tmdb_prompt',
                title: '🔍 Type the movie/series name...',
                description: 'Start typing to see live TMDB suggestions with cover art.',
                input_message_content: {
                  message_text: '🔍 Please type a title to search TMDB.',
                },
              },
            ],
            { cache_time: 0 }
          );
        }

        const { candidates, error } =
          await searchTMDBCandidatesWithDiagnostics(searchQuery, category, 10);

        if (candidates.length === 0) {
          const desc = error
            ? `⚠️ TMDB: ${error}`
            : 'No matching titles found on TMDB.';
          return ctx.answerInlineQuery(
            [
              {
                type: 'article',
                id: 'tmdb_none',
                title: '❌ No Matches Found',
                description: desc,
                input_message_content: {
                  message_text: `❌ Could not find "${searchQuery}" on TMDB. Please try another keyword.`,
                },
              },
            ],
            { cache_time: 0 }
          );
        }

        const inlineResults = candidates.map((c, index) => {
          const yearStr = c.year ? ` (${c.year})` : '';
          const coverStatus = c.hasCover
            ? '✅ Cover Art Available'
            : '❌ No Cover Art';
          const typeStr = c.category === 'movies' ? 'Movie' : 'TV Series';

          return {
            type: 'article',
            id: `tmdb_${c.tmdb_id}_${index}`,
            title: `${c.hasCover ? '🖼' : '⚠️'} ${c.title}${yearStr}`,
            description: `[${typeStr}] ${coverStatus} • Rating: ${c.rating || 'N/A'}`,
            thumb_url:
              c.poster_url ||
              'https://placehold.co/150x225/111827/ffffff.png?text=No+Cover',
            input_message_content: {
              message_text: `/picktmdb ${correctionId} ${c.tmdb_id} ${c.category}`,
              parse_mode: 'HTML',
            },
          };
        });

        return ctx.answerInlineQuery(inlineResults as any, { cache_time: 5 });
      }
    }

    // Default library media search
    const stmt = db.db.prepare(`
      SELECT DISTINCT title, category, year, rating, poster_url, overview 
      FROM files 
      WHERE title LIKE ? AND file_id IS NOT NULL
      LIMIT 10
    `);
    const results = stmt.all(`%${rawQuery}%`) as any[];

    const inlineResults = results.map((r, index) => {
      const cleaned = db.cleanTitle(r.title);
      const payloadString = `${r.category}:${r.title}`;
      const payload = Buffer.from(payloadString)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const yearPart = r.year ? ` (${r.year})` : '';
      const categoryEmoji = '🤡';

      return {
        type: 'article',
        id: `search_${index}_${r.title}`,
        title: `${categoryEmoji} ${cleaned.toUpperCase()}${yearPart}`,
        description: r.overview
          ? r.overview.substring(0, 100) + '...'
          : `Find ${cleaned} on Vinehill 🤡`,
        thumb_url: r.poster_url || 'https://via.placeholder.com/150',
        input_message_content: {
          message_text: `🤡 <b>${cleaned.toUpperCase()}${yearPart}</b>\n\nClick below to get this media!`,
          parse_mode: 'HTML',
        },
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🤡 Open in Bot',
                url: `https://t.me/${ctx.botInfo.username}?start=${payload}`,
              },
            ],
          ],
        },
      };
    });

    return ctx.answerInlineQuery(inlineResults as any);
  });
}
