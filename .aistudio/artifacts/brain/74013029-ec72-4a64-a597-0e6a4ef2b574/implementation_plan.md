# Implementation Plan: Auto-Detection & Recovery for Failed Downloads

## 1. Overview
When a user clicks the **"📥 DOWNLOAD NOW"** button in a channel announcement post and the bot fails to deliver the requested file (due to missing media records, dead file IDs, MTProto copy failures, or Telegram API errors), the system will:
1. **Auto-Detect** the failure condition (missing database records or delivery exceptions).
2. **Execute Automatic Recovery**: Attempt an alternative lookup across stored media (clean title variants, alternative qualities, or MTProto channel search).
3. **Notify the Admin**: If recovery fails, immediately dispatch a high-priority Telegram alert to the bot admin with user details, media name, category, and error reason.
4. **Deliver User Instant Recovery**: Send the user a friendly prompt with a one-click `[🔄 Retry Download]` button, a `[🔍 Search Library]` shortcut, and an issue ticket reference.
5. **Track Failures in SQLite**: Maintain a persistent `failed_deliveries` log and add an admin summary view (`/failed` or in `/admin` dashboard).

---

## 2. Technical Architecture & Changes

### A. Database Schema (`src/bot/database.ts`)
- **New Table `failed_deliveries`**:
  ```sql
  CREATE TABLE IF NOT EXISTS failed_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    error_reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'recovered', 'admin_resolved'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_failed_deliveries_user ON failed_deliveries(user_id);
  CREATE INDEX IF NOT EXISTS idx_failed_deliveries_status ON failed_deliveries(status);
  ```
- **Helper Functions**:
  - `recordFailedDelivery(userId, title, category, reason)`: Log failure attempt.
  - `resolveFailedDelivery(id, status)`: Mark as recovered or resolved.
  - `getRecentFailedDeliveries(limit)`: Retrieve unresolved failures for admin review.
  - `findAlternativeMedia(title, category)`: Query fallback files using sanitized/fuzzy title matching or alternative qualities.

### B. Auto-Recovery & Detection Engine (`src/bot/handlers/download.ts`)
- **Detection Checkpoints**:
  1. **Zero files found**: When `db.getMoviesByTitle`, `getGameFiles`, or `getSeasonFiles` yields 0 matching files for an announced title.
  2. **Delivery pipeline exhaustion**: When `copyMessage`, `replyWithDocument`, and MTProto message resolution all fail to produce a delivered message.
  3. **Telegram API failures**: Non-429 fatal exceptions (e.g., deleted message, file expired, file size cap).
- **Auto-Recovery Sequence**:
  - Before declaring failure, call `findAlternativeMedia(title, category)` or query MTProto storage channel with cleaned title.
  - If an alternative is found, attempt delivery immediately and mark auto-recovery as successful.
- **Admin Alert & User Recovery**:
  - If auto-recovery fails, trigger `notifyAdminOfFailedDownload(ctx, title, category, reason)`:
    - Sends structured alert to `getAdminId()`:
      ```
      ⚠️ FAILED DOWNLOAD DETECTED
      👤 User: Ellis Dagbui (@username, ID: 12345678)
      🎬 Media: Interstellar (movies)
      ❌ Reason: Media identifier could not be resolved
      🕒 Time: Oct 15, 2026, 18:25 UTC
      ```
  - Send the user an informative recovery message with inline keyboard:
    - `[🔄 Retry Download]` (triggers deep-link payload re-execution)
    - `[🔍 Search in Library]` (navigates to `/search <title>`)
    - `[💬 Contact Support]` (direct contact or report submission)

### C. Admin Dashboard & Commands (`src/bot/handlers/admin.ts`)
- Add `/failed` command to view the latest unresolved download failures.
- Add one-click **"⚠️ Failed Downloads"** button in `/admin` dashboard showing pending failure count.
- Add quick action callback `adm_res:<id>` to mark failures as resolved or re-index the file.

---

## 3. Verification & Testing
1. **Zero Files Simulation**: Test requesting an invalid or unindexed announcement link to verify auto-recovery trigger, admin alert dispatch, and user retry card.
2. **Delivery Failure Simulation**: Verify error trapping in `sendMediaBatch` when `copyMessage` fails and fallback resolution occurs.
3. **User Retry Action**: Click `[🔄 Retry Download]` to ensure payload re-decodes and re-executes cleanly.
4. **Admin Notification**: Verify Telegram message received by admin with full user and media context.
5. **Applet Compilation**: Run `compile_applet` and `lint_applet` to ensure strict TypeScript and runtime integrity.
