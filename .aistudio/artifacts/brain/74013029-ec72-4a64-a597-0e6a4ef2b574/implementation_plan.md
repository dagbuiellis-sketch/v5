# Implementation Plan: Download & Rename Cancellation Mechanism

## 1. Overview
When raw media files are uploaded to storage channels, the MTProto pipeline (`src/bot/renamer.ts`) downloads the files to a temporary disk cache (`os.tmpdir()/vinehill_cache`), parses and formats the clean filename, and uploads them to the destination renamed channel.

This plan introduces an immediate cancellation mechanism:
- When a download & rename job begins, the bot sends an active progress message to the admin chat with an inline **🛑 Cancel Download & Rename** button.
- As the file downloads and uploads, progress is reported and updated on the message.
- If the admin clicks **Cancel**, the transfer is aborted immediately, the temporary cached file is deleted from disk, the admin is notified, and the remaining queue continues unaffected.

---

## 2. Proposed Changes & Architecture

### `src/bot/renamer.ts`
1. **Job Tracking & Abort State**:
   - Enhance `RenameJob` interface to include:
     - `id: string`: Unique job identifier.
     - `abortController?: AbortController`: Cancellation signal.
     - `isCancelled?: boolean`: Boolean cancellation flag.
     - `progressMsgId?: number`: ID of the admin notification message.
     - `adminChatId?: string | number`: Admin chat target.
   - Maintain a module-level reference `currentActiveJob: RenameJob | null` and export `cancelActiveRenameJob(jobId: string): boolean`.
   - Export `cancelAllRenameJobs()` and queue inspect helpers for flexibility.

2. **Admin Live Progress Notification**:
   - At the start of `executeRenameJob(job)`, if `ADMIN_ID` is configured, send a message to the admin:
     ```
     ⚡ <b>Downloading & Renaming:</b> {originalFileName}
     📦 <b>Size:</b> {sizeMB} MB | <b>Category:</b> {category}
     ⏳ <b>Status:</b> Downloading to temporary cache (0%)...
     ```
     With inline keyboard:
     `[[{ text: '🛑 Cancel Download & Rename', callback_data: 'cancel_rename:<jobId>' }]]`
   - Store the message ID on the job.
   - Throttle progress updates (minimum 2.5 seconds between Telegram message edits to avoid API rate limits) during both `downloadMedia` and `sendFile`.

3. **Immediate Transfer Interruption & Cleanup**:
   - In both `downloadMedia` and `sendFile` progress callbacks, check `if (job.isCancelled) throw new Error('CANCELED_BY_ADMIN');`.
   - Handle `CANCELED_BY_ADMIN` gracefully in `executeRenameJob`:
     - Log cancellation.
     - Edit admin message to:
       ```
       🛑 <b>Download & Rename Cancelled</b>
       📁 File: <code>{originalFileName}</code>
       🧹 Temporary cache cleared. Remaining queue intact.
       ```
     - Remove inline keyboard buttons from the message.
     - Clean up the temporary file in `finally` block: ensure `fs.unlinkSync(tempFilePath)` executes immediately.
   - Because the queue remains intact, `processRenameQueue()` will automatically proceed with the next queued job (if any).

---

### `src/bot/handlers/admin.ts`
1. **Callback Action `cancel_rename:<jobId>`**:
   - Listen for callback queries matching `/^cancel_rename:(.+)$/`.
   - Verify caller is admin (`ctx.from.id.toString() === getAdminId()`).
   - Trigger `cancelActiveRenameJob(jobId)`.
   - Provide immediate callback query acknowledgment: `ctx.answerCbQuery('🛑 Cancelling download & rename...', { show_alert: true })`.

2. **Admin Command `/cancelrename` / `/abort`**:
   - Provide an admin command fallback in case the inline button message was cleared or inaccessible:
     - Checks if an active rename job is running.
     - If running, cancels it and confirms to admin.
     - If no job is active, reports `No active download or rename process running.`

---

## 3. Verification & Testing
1. **Compilation & Syntax**:
   - Run `compile_applet` and `lint_applet` to ensure type-safe integration with Telegram MTProto and Telegraf.
2. **Cancellation Flow**:
   - Verify that clicking the Cancel button triggers the cancellation error without crashing the server.
   - Verify temporary disk files in `os.tmpdir()/vinehill_cache` are immediately unlinked upon cancellation.
   - Verify the remaining queue continues to process subsequent items.
   - Verify the admin status message reflects the cancelled state and removes the action button.
