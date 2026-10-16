# Implementation Plan: Title & Cover Art Verification Gate with Interactive Suggestions

## 1. Overview & User Additions
This plan expands the verification gate based on user requirements:
1. **Verification on Staging & Announcer**:
   - Apply TMDB existence and cover art (`poster_url`) verification when raw files enter staging channels **and** before messages are published by the Announcer.
   - If either the title does not exist or cover art is missing, the file/announcement is **strictly paused**.
2. **Interactive Suggestions While Typing**:
   - When the admin provides a keyword or partial title, the bot queries TMDB `/search/multi` (or `/search/movie` / `/search/tv`) and immediately presents the **top matching candidates** as interactive 1-tap buttons (displaying Title, Release Year, and Cover Art status).
   - In addition, an inline search button (`switch_inline_query_current_chat`) allows the admin to view live suggestions directly above their keyboard as they type.

---

## 2. Architecture & File Changes

### A. TMDB Multi-Candidate Search Helper (`src/bot/tmdb.ts`)
1. Add `searchTMDBCandidates(query: string, category: string, limit = 5)`:
   - Queries TMDB API for all potential matches.
   - Maps results to candidate objects:
     ```typescript
     export interface TMDBCandidate {
       tmdb_id: number;
       title: string;
       year?: number;
       poster_url?: string;
       hasCover: boolean;
       overview?: string;
       rating?: string;
       category: string;
     }
     ```
   - Filters and flags whether each candidate has valid poster art.

### B. Pre-Processing Verification in Staging (`src/bot/handlers/indexer.ts`)
1. When raw media arrives in `STORAGE_CHANNELS`:
   - Parse detected filename with `parseFilename(detectedName)`.
   - Query TMDB for the primary match.
   - **Check**: Does the match exist AND is `poster_url` present?
   - **If YES**: Queue the rename job with verified metadata.
   - **If NO (Missing Title or Missing Poster)**:
     - Hold job in `pending_staging_corrections`.
     - Alert Admin with failure details and interactive buttons:
       - `[🔍 Search & Pick Title]` (inline live search)
       - `[✏️ Type Title / Keywords]` (direct message prompt)
       - `[🗑️ Discard Staged File]`

### C. Verification in Announcer Pipeline (`src/bot/handlers/announcer.ts`)
1. Before publishing an announcement in `_doAnnounce()`:
   - Verify that `f.poster_url` is present and valid.
   - If missing:
     - Hold the announcement in `pending_announcement_corrections`.
     - Alert the admin:
       ```html
       📢 <b>Announcement Held: Missing Cover Art or Title</b>
       🎬 <b>Title:</b> <code>${f.title}</code>
       ❌ Cover art is required before public announcement.
       ```
     - Provide the same interactive correction buttons: `[🔍 Search & Pick Title]` and `[✏️ Type Title]`.
     - Once the admin selects a valid candidate with cover art, update the database record and proceed with the announcement card in `@VinehillMain` and target channels.

### D. Interactive Suggestion UI & Selection Flow (`src/bot/handlers/admin.ts`)
1. **Interactive Search & Suggestions**:
   - When the admin taps `[✏️ Type Title / Keywords]`:
     - The bot prompts: `✏️ <b>Enter Title or Search Keywords</b>\n\nType any part of the title (e.g. <i>Hacksaw</i> or <i>Stranger Things</i>):`
   - When the admin sends a text message:
     - The bot queries `searchTMDBCandidates(query, category, 5)`.
     - If candidates are found, the bot displays an interactive suggestion menu:
       ```html
       🔍 <b>Select Matching Title from TMDB:</b>

       1️⃣ <b>Hacksaw Ridge</b> (2016) • [Cover Art: ✅]
       2️⃣ <b>Hacksaw</b> (2020) • [Cover Art: ✅]
       3️⃣ <b>Hacksaw: Retrospective</b> (2018) • [Cover Art: ❌]
       ```
       Inline buttons:
       - `[1️⃣ Hacksaw Ridge (2016)]`
       - `[2️⃣ Hacksaw (2020)]`
       - `[🔄 Search Different Keyword]`
   - When the admin taps a candidate:
     - If `candidate.hasCover === false`: Alert admin: `"⚠️ This entry has no cover art on TMDB. Please select one with cover art."`
     - If `candidate.hasCover === true`:
       - Bind metadata (`title`, `year`, `poster_url`, etc.).
       - Resume staging processing (download/rename) or publish announcement.
       - Send confirmation card with verified poster preview.

---

## 3. Verification Plan
1. **Lint & Build**:
   - Run `lint_applet` (`tsc --noEmit`) to verify clean TypeScript compilation.
   - Run `compile_applet` to confirm successful build.
2. **Interactive Search Verification**:
   - Test typing a partial keyword (e.g., `"Hacksaw"`) and confirm selectable candidate buttons appear with cover art badges.
   - Test selecting a candidate: verify that full title and poster are bound and pipeline commences.
   - Test Announcer verification: verify announcements without cover art are paused until verified.
