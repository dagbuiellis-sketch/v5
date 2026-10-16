# Implementation Plan: TMDB Title Correction, Live Suggestions & Key Diagnostics

## 1. Problem Diagnosis
1. **"Anything I enter says not found"**:
   - In `src/bot/tmdb.ts`, `TMDB_API_KEY` was read only once from `process.env.TMDB_API_KEY` at module load time. If `.env` had quotes, spaces, or if the user used a TMDB v4 Read Access Token (starts with `ey...` instead of a 32-char v3 key), TMDB returns HTTP 401. Axios threw an error, was caught, and silently returned an empty array `[]`.
   - In addition, `server.ts` lacked `import 'dotenv/config'`, which can cause environment variables from `.env` to be missing when run directly.
   - The search strictly queried `/search/movie` or `/search/tv` without query sanitization (dots, `.mkv`, `720p`, release tags).
2. **"Not giving any suggestions while typing"**:
   - In standard Telegram text messages (`bot.on('text')`), Telegram does not send events until the user presses Enter/Send.
   - Telegram supports **Inline Mode** (`switch_inline_query_current_chat`), which sends queries to the bot on every keystroke as the user types, displaying live popover cards with movie/series posters and titles.

## 2. Proposed Changes

### A. Environment & TMDB Key Robustness (`server.ts`, `src/bot/tmdb.ts`, `src/bot/database.ts`)
- Add `import 'dotenv/config'` to `server.ts`.
- In `src/bot/tmdb.ts`, implement `getTmdbApiKey()` that checks:
  1. `process.env.TMDB_API_KEY`
  2. `process.env.TMDB_KEY`
  3. `process.env.TMDB_TOKEN`
  4. `db.getConfig('TMDB_API_KEY')`
  5. Strips surrounding quotes (`"`, `'`) and whitespace.
- Support both **v3 API Key** (`api_key` param) and **v4 Bearer Token** (`Authorization: Bearer <token>`).
- Add `/settmdb <key>` and `/testtmdb` commands for the admin to configure and verify TMDB API connectivity with real-time feedback in Telegram.

### B. Intelligent Candidate Search Pipeline (`src/bot/tmdb.ts`)
- Create `searchTMDBCandidates(query, category)` with:
  1. Raw query attempt.
  2. Cleaned query attempt (stripping `.mkv`, `720p`, `1080p`, `x265`, `BRRip`, tags, release groups, and converting dots to spaces).
  3. Multi-search fallback (`/search/multi`) if the category-specific search (`/search/movie` or `/search/tv`) yields zero results.
  4. Explicit error categorization: if TMDB responds with 401 (Invalid Key) or 404, capture the exact error message so the admin is informed rather than seeing a generic "not found".

### C. Live Typing Suggestions (Inline Mode) & Chat Search (`src/bot/handlers/inline.ts`, `src/bot/handlers/admin.ts`)
- In `fix_stg` and `fix_ann` prompts, offer two convenient ways to search:
  1. **Inline Search (`🔎 Search as you type`)**: Opens `switch_inline_query_current_chat` with `@bot_username tmdb:<session_id> <title>`. Shows live results with posters and release year as the admin types.
  2. **Direct Chat Message**: Admin can also reply with any title or keyword in chat.
- Display clear status badges on search results:
  - `✅ Cover Available` (can be selected to resume)
  - `❌ Cover Missing` (alerts user to choose a title with cover art)

### D. Verification & Resumption
- When a candidate is chosen:
  - Verify poster cover art.
  - Resume the staging job (`queueRenameJob`) or release the held announcement.

## 3. Verification Plan
- Run `lint_applet` and `compile_applet`.
- Verify query cleaning and candidate parsing logic.
- Verify that both v3 keys and v4 Bearer tokens format requests properly.
- Restart dev server.
