import { Telegraf } from 'telegraf';
import * as db from '../database';

export function registerInlineHandlers(bot: Telegraf<any>) {
  bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query) return ctx.answerInlineQuery([]);

    const stmt = db.db.prepare(`
      SELECT DISTINCT title, category, year, rating, poster_url, overview 
      FROM files 
      WHERE title LIKE ? AND file_id IS NOT NULL
      LIMIT 10
    `);
    const results = stmt.all(`%${query}%`) as any[];

    const inlineResults = results.map((r, index) => {
      const cleaned = db.cleanTitle(r.title);
      const payloadString = `${r.category}:${r.title}`;
      const payload = Buffer.from(payloadString).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const yearPart = r.year ? ` (${r.year})` : '';
      const categoryEmoji = '🤡';
      
      return {
        type: 'article',
        id: `search_${index}_${r.title}`,
        title: `${categoryEmoji} ${cleaned.toUpperCase()}${yearPart}`,
        description: r.overview ? r.overview.substring(0, 100) + '...' : `Find ${cleaned} on Vinehill 🤡`,
        thumb_url: r.poster_url || 'https://via.placeholder.com/150',
        input_message_content: {
          message_text: `🤡 <b>${cleaned.toUpperCase()}${yearPart}</b>\n\nClick below to get this media!`,
          parse_mode: 'HTML'
        },
        reply_markup: {
          inline_keyboard: [[{
            text: '🤡 Open in Bot',
            url: `https://t.me/${ctx.botInfo.username}?start=${payload}`
          }]]
        }
      };
    });

    return ctx.answerInlineQuery(inlineResults as any);
  });
}
