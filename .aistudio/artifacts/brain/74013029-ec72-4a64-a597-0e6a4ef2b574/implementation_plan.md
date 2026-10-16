# Implementation Plan: Fix GramJS MTProto FloodWait & Enable Seamless Bot API Fallback

## 1. Problem Diagnosis
In the provided logs:
```
FloodWaitError: A wait of 3125 seconds is required (caused by auth.ImportBotAuthorization)
```
- **Root Cause**: `initMTProtoClient()` initialized a new `StringSession('')` on startup without saving the session string to persistent storage. Every time the bot restarted or initialized, it called `client.start({ botAuthToken })`, invoking Telegram's `auth.importBotAuthorization`. Telegram enforces a rate-limit on new authorization handshakes from the same IP/token; once exceeded, it blocks new authorizations for ~52 minutes (3,125 seconds).
- **Secondary Problem**: When `initMTProtoClient()` failed or returned `null`, `executeRenameJob()` logged a warning and skipped the file entirely. The file sat in the staging channel and was never copied, renamed, or indexed.

---

## 2. Solution Architecture

### A. Session Persistence (`src/bot/renamer.ts`)
1. **Load Existing Session**:
   - Check `process.env.TELEGRAM_SESSION` first.
   - If not set, retrieve the saved session string from the SQLite `config` table (`db.getConfig('TELEGRAM_SESSION')`).
2. **Persist Active Session**:
   - Once `client.start()` succeeds, call `client.session.save()` and store the session key in SQLite (`db.setConfig('TELEGRAM_SESSION', sessionStr)`).
   - Future bot restarts will reuse this authenticated session key, bypassing `auth.importBotAuthorization` and completely preventing future flood waits.

### B. FloodWait Cooldown Handling & Admin Awareness (`src/bot/renamer.ts`)
1. Detect `FloodWaitError` or `error.seconds` when starting GramJS:
   - Calculate `floodWaitUntil = Date.now() + (seconds * 1000)`.
   - Prevent redundant connection attempts until the cooldown has passed.
2. Alert the bot administrator once with a clear status notice:
   - Explain that Telegram MTProto is temporarily cooling down.
   - Reassure that the automatic Bot API fallback is actively processing and indexing all files.

### C. Automatic Zero-Loss Bot API Fallback (`src/bot/renamer.ts`)
1. If GramJS MTProto is unavailable (due to FloodWait cooldown, unconfigured keys, or network limits):
   - **Do not drop or skip files**.
   - Use Telegram's Bot API (`bot.telegram.copyMessage`) to transfer the file from the staging channel directly to the target channel (`@renamed_movies`, `@renamed_series`, `@renamed_anime`).
   - Format and attach the proper caption:
     ```html
     🎬 <b>{Title} ({Year})</b>
     🏷 <i>{TargetFileName}</i>

     @VinehillMain
     ```
   - Automatically pass the copied message to `handleUploadedRenamedMedia` in the indexer.
   - The media is indexed into SQLite and announced to `@VinehillMain` as normal!

---

## 3. Verification Plan
1. **Lint & Build**:
   - Run `lint_applet` (`tsc --noEmit`) to verify zero type errors.
   - Run `compile_applet` to confirm a clean build.
2. **Session Persistence**:
   - Verify `db.getConfig('TELEGRAM_SESSION')` saves and reloads across restarts.
3. **Fallback Verification**:
   - When MTProto is under FloodWait, simulate or verify that staging channel files are smoothly copied, captioned, and indexed via Bot API rather than skipped.
