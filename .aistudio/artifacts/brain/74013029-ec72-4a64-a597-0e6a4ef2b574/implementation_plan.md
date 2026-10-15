# Implementation Plan: Channel Progress Relay & 'Download All Seasons' Feature

## 1. Overview
This plan implements two requested features:
1. **Channel Progress Message & Collaborative Cancellation**:
   - Move the active download/rename progress message from the private admin DM into the destination renamed channel (e.g., `@renamed_movies`, `@renamed_series`, `@renamed_anime`).
   - Allow channel administrators and the bot owner to click the inline **🛑 Cancel Download & Rename** button.
   - Upon completion or cancellation, update the channel progress message and auto-delete it after 10 seconds to keep channel feeds clean.
2. **'Download All Seasons' Button in Series Interactions**:
   - Add a prominent **📦 Download All Seasons** button to the series season picker and episode picker.
   - Deliver all episodes across all seasons sequentially with clear progress notifications and rate-limited batch delivery.

---

## 2. Architecture & File Changes

### A. Rename Progress & Channel Permissions (`src/bot/renamer.ts` & `src/bot/handlers/admin.ts`)
1. **Targeting the Renamed Channel**:
   - In `executeRenameJob()`, send the initial progress notification with the inline **🛑 Cancel Download & Rename** button directly to `destinationChannel` (`RENAMED_CHANNELS[job.category]`).
   - Store `job.targetChannelId = destinationChannel` and `job.progressMsgId = sent.message_id`.
   - Update throttle ticks (download and upload progress) to edit the channel message.
2. **10-Second Auto-Deletion**:
   - When a job completes successfully, update the message to:
     ```html
     ✅ <b>Download & Rename Complete!</b>

     🏷 <b>File:</b> <code>${targetFileName}</code>
     📢 <b>Destination:</b> ${destinationChannel}
     🤡 Media indexed and ready.

     <i>⏱ Status message will auto-delete in 10s...</i>
     ```
   - Strip the inline button and schedule `setTimeout(() => bot.telegram.deleteMessage(targetChannelId, progressMsgId).catch(() => {}), 10000)`.
   - If cancelled, update the channel message with cancellation details and similarly auto-delete after 10 seconds.
3. **Admin & Channel Administrator Authorization (`src/bot/handlers/admin.ts`)**:
   - In `bot.action(/^cancel_rename:(.+)$/)`:
     - Allow cancellation if `ctx.from.id.toString() === getAdminId()`.
     - Also verify if the user is a channel administrator or creator in the destination channel via `ctx.telegram.getChatMember(channelId, ctx.from.id)`.
     - If verified, call `cancelActiveRenameJob(jobId)` and send confirmation feedback.
     - If unauthorized, show an alert: `"⚠️ Only channel administrators can cancel this task."`

### B. Series Database Helper (`src/bot/database.ts`)
1. Add `getAllSeriesFiles(title: string, category: string)`:
   - Query all available files for a given series across all seasons and episodes:
     `SELECT * FROM files WHERE title = ? AND category = ? AND file_id IS NOT NULL AND file_id != '' ORDER BY season ASC, episode ASC`
   - Include alternative search fallback if standard match is empty.

### C. Series Interactions & Delivery (`src/bot/handlers/download.ts`)
1. **UI Updates**:
   - In `showSeasonPicker()`:
     - Add a full-width button `[{ text: '📦 Download All Seasons', callback_data: `ep:all_seasons:${category}:0,0:${encodedPayload}` }]`.
   - In `showEpisodePicker()`:
     - Keep `🚀 Download Full Season` and add `📦 Download All Seasons`.
2. **Batch Delivery Handler**:
   - Handle `action === 'all_seasons'` in the `bot.action(/^ep:([^:]+)...)` handler:
     - Notify user: `"🚀 Preparing all seasons for <Title>..."`.
     - Retrieve all episodes sorted by season and episode.
     - Send a summary progress card: `"📦 Delivering All Seasons (X episodes)..."`.
     - Stream files sequentially using `sendMediaBatch` with a friendly delay between seasons to respect Telegram rate limits.

---

## 3. Verification Plan
1. **Compilation & Linting**: Run `compile_applet` and `lint_applet` to ensure type safety.
2. **Channel Progress & Cancellation Verification**:
   - Verify progress message sends to the target channel with inline cancel button.
   - Verify non-admins cannot cancel, while channel admins and bot owner can cancel.
   - Verify 10-second timer removes progress messages on both completion and cancellation.
3. **Series Download Verification**:
   - Test `showSeasonPicker` UI displays the "Download All Seasons" option.
   - Verify clicking downloads all episodes sequentially across seasons.
