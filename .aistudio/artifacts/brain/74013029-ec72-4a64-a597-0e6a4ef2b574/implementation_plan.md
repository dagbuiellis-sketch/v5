# Implementation Plan: Playful Big Animated Clown Reactions

## 1. Overview
When users manually react to messages in Telegram, long-pressing or tapping the reaction triggers Telegram's playful animated reaction effect (the emoji bursts and animates across the screen with sound and haptics).
In the Telegram Bot API (version 7.0+), this effect is controlled by the `is_big` parameter in the `setMessageReaction` method.
Currently, `setMessageReaction` in `src/bot/client.ts` omits `is_big`, resulting in the standard subtle static reaction badge.
We will enable `is_big: true` by default so that both file deliveries and channel announcements receive the lively, playful big animated clown reaction.

---

## 2. Proposed Changes

### `src/bot/client.ts`
1. **Update `setMessageReaction`**:
   - Update parameter signature to include `isBig = true`.
   - In `callApi('setMessageReaction', ...)` and `telegram.setMessageReaction(...)`, explicitly pass `is_big: isBig`.
   - Ensure fallback handling supports both direct Telegraf method call and `callApi` payload structure:
     ```typescript
     export async function setMessageReaction(
       telegram: any,
       chatId: string | number,
       messageId: number,
       emoji = '🤡',
       isBig = true
     ) {
       try {
         if (typeof telegram.callApi === 'function') {
           await (telegram as any).callApi('setMessageReaction', {
             chat_id: chatId,
             message_id: messageId,
             reaction: [{ type: 'emoji', emoji }],
             is_big: isBig,
           });
         } else if (typeof telegram.setMessageReaction === 'function') {
           await telegram.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }], { is_big: isBig });
         }
       } catch (err: any) {
         logger.debug({ err: err?.message, chatId, messageId }, 'Reaction call skipped or failed');
       }
     }
     ```

### `src/bot/handlers/announcer.ts` & `src/bot/handlers/download.ts`
1. Verify all callers of `setMessageReaction` and `scheduleClownReaction` inherit `isBig: true`.
2. Ensure channel announcement posts and final media file deliveries both trigger the big animated reaction 1 second after arrival.

---

## 3. Verification Plan
1. **Lint & Compilation**: Run `lint_applet` and `compile_applet` to confirm zero TypeScript compilation errors.
2. **Behavioral Verification**: Verify that calls to `setMessageReaction` transmit `{ chat_id, message_id, reaction: [{ type: 'emoji', emoji: '🤡' }], is_big: true }` to Telegram Bot API.
