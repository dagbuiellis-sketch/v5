# Implementation Plan: Restoring Simplified File Delivery Captions (Revised)

## 1. Overview
This updated plan incorporates user-specified refinements:
1. **Quality Resolution Handling**: If the media's quality is unknown, do **not** mention it or output any placeholder (no `[Unknown]` or empty brackets). Only show resolution (e.g. `[1080p]`, `[720p]`, `[4K]`) when a valid quality is known.
2. **Reaction Timing**: The clown emoji (`🤡`) reaction must be applied **1 second after** the post is announced in channels or received by the user in private chat.
3. **Simplified Caption Format**:
   - Movies / Standalone:
     `🤡 <b>{Title} ({Year})</b> [{Quality}]\n<i>{Channel}</i>` (or without `[{Quality}]` if unknown)
   - Series / Anime:
     `🤡 <b>{Title} • S{SS}E{EE}</b> [{Quality}]\n<i>{Channel}</i>` (or without `[{Quality}]` if unknown)
4. **Preserved Features**:
   - Action buttons (Like, Favorite, Report, Admin Delete) remain attached **only for movies**.
   - Download failure auto-detection, auto-recovery, admin alert, and user retry card remain fully intact.

---

## 2. Proposed Changes

### `src/bot/handlers/download.ts`
- Implement `formatSimpleCaption(file: any)`:
  - Formats title and year or season/episode.
  - Normalizes quality (checks `file.quality` or regex matches on `file.file_name` like `1080p|720p|480p|2160p|4k`). If unknown or empty, quality is completely omitted.
  - Adds channel mention and clown emoji: `🤡 <b>...</b>\n<i>@VinehillMain</i>`.
- Apply caption to `copyExtra` and `docExtra` with `parse_mode: 'HTML'`.
- Delay the clown emoji reaction by 1 second (1000ms) after file delivery (`setTimeout(() => setMessageReaction(ctx.telegram, ctx.from.id, sent.message_id, '🤡'), 1000)`).

### `src/bot/handlers/announcer.ts`
- Update channel announcements (`_announceMovie`, `_announceSeries`, `_announceGame`) to apply the clown emoji reaction with a 1-second delay after the announcement message is sent or copied to the main channel.

---

## 3. Verification Plan

### Automated Checks
- Run `compile_applet` to confirm zero TypeScript compilation errors.
- Run `lint_applet` to ensure formatting and code style compliance.

### Scenario Validation
- **Known Quality File**: Produces `🤡 <b>Movie Name (2024)</b> [1080p]\n<i>@VinehillMain</i>`.
- **Unknown Quality File**: Produces `🤡 <b>Movie Name (2024)</b>\n<i>@VinehillMain</i>` with no bracketed placeholder.
- **Reaction Delay**: Confirms `setTimeout` or asynchronous delay of 1,000ms triggers reactions for both channel posts and user deliveries.
