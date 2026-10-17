# Implementation Plan: Smart Announcement Queueing, Instant Movie Announcements, & Minimal Channel Captions/Progress

## 1. Overview & Requirements
1. **Series & Anime Announcements**:
   - When an episode of a series or anime is placed in the renamed channel, if another episode of the same series or anime is in queue or currently being renamed, do **not** announce yet.
   - As soon as no related episodes remain in the queue or actively being renamed, immediately announce using the existing consolidated announcement logic.
2. **Movie Announcements**:
   - Movies must be announced immediately with zero delay when they appear in the renamed channel.
3. **Clean, Non-Bulky Captions in Renamed Channel**:
   - Since only admins are in the renamed channel, eliminate bulky captions (no redundant headers or channel tags). Set the caption to **just the file name** (`targetFileName`).
4. **Streamlined, Less Bulky Progress Messages**:
   - Simplify the progress status messages in the renamed channels so they don't clutter the chat.
   - Replace the large multi-line block with a clean, compact status (e.g., `⚡ <code>${targetFileName}</code> (${sizeMB} MB)\n⏳ ${statusText}`).

---

## 2. Technical Architecture & Proposed Changes

### A. Non-Bulky Caption & Compact Progress Messages (`src/bot/renamer.ts`)
1. **Caption Simplification**:
   - In `executeBotApiFallback`:
     - Change caption from multi-line formatted text to just `<code>${targetFileName}</code>` (or plain `targetFileName`).
   - In MTProto `sendFile`:
     - Change caption from multi-line formatted text to `<code>${targetFileName}</code>`.
2. **Compact Progress Message**:
   - Initial message:
     ```
     ⚡ <b>Renaming:</b> <code>${targetFileName}</code> (${sizeMB} MB)
     ⏳ Initializing...
     ```
     with `[🛑 Cancel]` button.
   - Ongoing progress updates:
     ```
     ⚡ <b>Renaming:</b> <code>${targetFileName}</code> (${sizeMB} MB)
     ⏳ ${statusText}
     ```
   - Completion message:
     ```
     ✅ <code>${targetFileName}</code> ready
     ```
     (auto-deletes after 10s to keep channel clean).

### B. Rename Queue State Inspection (`src/bot/renamer.ts`)
1. Export helper `hasRelatedRenameJob(category: string, title: string, tmdbId?: number): boolean`:
   - Inspects `currentActiveJob` and `renameQueue`.
   - Filters to matching category (`series` or `anime`).
   - Matches if:
     - `job.verifiedMeta?.tmdb_id && tmdbId && job.verifiedMeta.tmdb_id === tmdbId`, OR
     - `db.cleanTitle(job.customTitle || parseFilename(job.originalFileName).title) === db.cleanTitle(title)`.
   - Returns `true` if any episode of the same show is currently being renamed or waiting in queue.
2. Queue Drain / Completion Trigger:
   - When a job finishes renaming in `renamer.ts` (both MTProto upload and fallback) and advances the queue, notify `indexer.ts` via an exported callback `checkPendingAnnouncements()`.

### C. Announcement Dispatch Logic (`src/bot/handlers/indexer.ts`)
1. **Movies (Instant Announcement)**:
   - When `category === 'movies'`, bypass the batch debounce timer completely and call `sendForConfirmation(fileData)` immediately.
2. **Series & Anime (Queue-Aware Deferral & Immediate Flush)**:
   - When an episode is indexed in `queueBatchAnnouncement(data)`:
     - Check `hasRelatedRenameJob(data.category, data.title, data.tmdb_id)`.
     - If `true` (more episodes are still being renamed or waiting in queue):
       - Store/update the show's batch state (tracking episode counts, highest season/episode, and metadata).
       - Mark `waitingForQueue: true` and hold announcement.
     - If `false` (no other episodes in queue or active):
       - Immediately flush the announcement (`flushBatch(key)`) without any extra delay.
3. **Queue Completion Handler**:
   - When `checkPendingAnnouncements()` is called after an active job finishes or the queue drains:
     - Iterate through pending show batches in `_batchAnnounce`.
     - For each show, re-check `hasRelatedRenameJob(...)`.
     - If all related episodes have finished and are no longer in queue or active, immediately flush the consolidated announcement.

---

## 3. Verification Plan
1. **Build & Lint Checks**:
   - Run `compile_applet` and `lint_applet` to confirm clean compilation and zero type errors.
2. **Verification of Scenarios**:
   - **Single Movie**: Upload/rename a movie -> verify caption is just `targetFileName`, progress message is compact, and announcement is triggered immediately.
   - **Multiple Series Episodes**: Queue S01E01 and S01E02 of a series -> verify S01E01 uploads with simple caption, announcement is deferred while S01E02 is in queue/active, and upon S01E02 completing, the announcement fires immediately.
