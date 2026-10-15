# Implementation Plan: Target Clown Reaction to Final Series File

## 1. Overview
Currently, in `sendMediaBatch` within `src/bot/handlers/download.ts`, every delivered episode in a multi-file batch (e.g., full seasons or all seasons) triggers an individual clown emoji (`🤡`) reaction 1 second after delivery.
As requested, for series (both TV Series and Anime), the clown reaction should be applied **only to the last file received by the user**. If a single episode is downloaded, that episode is the last (and only) file and will still receive the reaction.

---

## 2. Proposed Changes

### `src/bot/handlers/download.ts`
1. **Differentiate Reaction Logic in `sendMediaBatch`**:
   - Detect if the current batch is episodic (`series` or `anime` category).
   - In the file delivery loop:
     - Record all successfully sent messages into `sentMsgIds`.
     - For non-series media (such as movies), continue applying the reaction or let the batch defer to the last file.
     - For `series` and `anime`, suppress per-file intermediate reactions during the loop.
   - After the delivery loop completes:
     - Identify the last successfully delivered message (`sentMsgIds[sentMsgIds.length - 1]`).
     - Schedule the `🤡` reaction via `setMessageReaction(ctx.telegram, ctx.from.id, lastSentMsgId, '🤡')` with the 1-second delay (`setTimeout(..., 1000)`).
   - Ensure that in single-episode downloads (where `sentMsgIds.length === 1`), that single episode receives the reaction exactly as intended.
   - In 429 retry edge-cases, maintain the same rule: intermediate files are not reacted, and only the final delivered file in the sequence gets the clown reaction.

---

## 3. Verification Plan
1. **Static Analysis & Compilation**:
   - Run `lint_applet` (`tsc --noEmit`) to verify clean TypeScript compilation.
   - Run `compile_applet` to verify build integrity.
2. **Behavioral Verification**:
   - Test full season / all seasons batch delivery: verify only the last episode message receives `🤡` after 1 second.
   - Test single episode delivery: verify that the single episode receives `🤡` after 1 second.
   - Test movie file delivery: verify movies continue to receive the `🤡` reaction.
