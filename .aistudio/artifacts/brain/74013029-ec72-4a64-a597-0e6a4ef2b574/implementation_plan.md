# Implementation Plan: Fix Playful Animated Clown Reaction

## 1. Root Cause Analysis
1. **Telegram Client Animation vs. Bot API Limitations**:
   - When a human user manually reacts to a message in the Telegram app, the local client renders an animated Lottie burst on the screen.
   - In standard Bot API (`setMessageReaction`), Telegram receives the reaction and attaches the badge, but many Telegram clients (iOS, Android, Desktop) do not trigger full-screen burst animations for bot-applied reactions or in channels unless MTProto `big: true` flags are sent through the client protocol.
2. **Telegraf vs. Telegram Bot API Parameter Formatting**:
   - Telegraf's `setMessageReaction(chat_id, message_id, reaction, is_big)` takes a raw boolean `true` as its 4th argument. If passed an object `{ is_big: true }`, Telegraf serializes it as an object rather than a boolean, causing the Bot API to ignore the animation flag.
3. **Missing MTProto Native Reaction Route**:
   - The bot has an active GramJS MTProto client (`initMTProtoClient()`). MTProto supports `Api.messages.SendReaction({ peer, msgId, reaction: [new Api.ReactionEmoji({ emoticon: '🤡' })], big: true, addToRecent: true })`, which is the exact call Telegram client apps use when humans react.

---

## 2. Proposed Changes

### `src/bot/client.ts`
1. **Implement Dual-Route MTProto & Bot API Reaction Pipeline**:
   - First attempt native MTProto reaction using GramJS `Api.messages.SendReaction`:
     ```typescript
     import { Api } from 'telegram';
     import { initMTProtoClient } from './renamer';

     const mtClient = await initMTProtoClient();
     if (mtClient) {
       await mtClient.invoke(new Api.messages.SendReaction({
         peer: chatId,
         msgId: messageId,
         reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
         big: true,
         addToRecent: true
       }));
     }
     ```
   - Fall back to Telegraf Bot API with strict boolean types:
     ```typescript
     await (telegram as any).callApi('setMessageReaction', {
       chat_id: chatId,
       message_id: messageId,
       reaction: [{ type: 'emoji', emoji }],
       is_big: true,
     });
     ```
2. **Enhanced Diagnostics**:
   - Promote error logging from hidden `logger.debug` to `logger.warn` with descriptive diagnostic details if Telegram returns a code (e.g., `REACTION_INVALID`, `CHAT_NOT_MODIFIED`).

---

## 3. Verification Plan
1. **Type & Syntax Checking**: Run `lint_applet` (`tsc --noEmit`) to verify zero TypeScript errors.
2. **Compilation Verification**: Run `compile_applet` to confirm clean build.
3. **Execution Verification**: Verify that reactions call MTProto `SendReaction` with `big: true` and fall back cleanly to Bot API `is_big: true`.
