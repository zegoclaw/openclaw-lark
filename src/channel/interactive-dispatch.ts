/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Feishu interactive dispatch wrapper.
 *
 * This module adapts Feishu `card.action.trigger` events into OpenClaw's
 * standard interactive dispatch pipeline:
 * - Plugins register via `api.registerInteractiveHandler({ channel, namespace, handler })`
 * - Channel forwards via `dispatchPluginInteractiveHandler()`
 *
 * We intentionally do NOT maintain any channel-local global registry here.
 */

import type { ClawdbotConfig } from 'openclaw/plugin-sdk';
// NOTE: This is the SDK-standard interactive pipeline.
// eslint-disable-next-line import-x/no-unresolved
import { dispatchPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';
import { larkLogger } from '../core/lark-logger';
import { sendCardFeishu, sendMessageFeishu, updateCardFeishu } from '../messaging/outbound/send';

const log = larkLogger('channel/interactive-dispatch');

interface FeishuCardActionTriggerEvent {
  operator?: { open_id?: string };
  open_chat_id?: string;
  open_message_id?: string;
  context?: { open_chat_id?: string; open_message_id?: string };
  action?: { value?: { action?: string } };
}

function parseRouteKey(action: string): { namespace: string; payload: string } {
  const raw = String(action || '').trim();
  const idx = raw.indexOf(':');
  if (idx <= 0) return { namespace: raw, payload: '' };
  return { namespace: raw.slice(0, idx), payload: raw.slice(idx + 1) };
}

function extractBasics(data: unknown): {
  action: string;
  senderOpenId?: string;
  openChatId?: string;
  openMessageId?: string;
} | null {
  try {
    const ev = data as FeishuCardActionTriggerEvent;
    const action = ev.action?.value?.action;
    if (!action || typeof action !== 'string') return null;
    const openChatId = ev.open_chat_id ?? ev.context?.open_chat_id;
    const openMessageId = ev.open_message_id ?? ev.context?.open_message_id;
    return {
      action: action.trim(),
      senderOpenId: ev.operator?.open_id,
      openChatId,
      openMessageId,
    };
  } catch {
    return null;
  }
}

function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

/**
 * Dispatch a Feishu interactive card action to business plugins through
 * the OpenClaw SDK's standard interactive dispatch pipeline.
 *
 * Returns `undefined` when:
 * - the event does not look like an interactive action we can route, or
 * - no plugin handler is registered for the derived namespace.
 *
 * @param params.cfg - OpenClaw config snapshot.
 * @param params.accountId - Current Feishu account id.
 * @param params.data - Raw `card.action.trigger` event payload.
 */
export async function dispatchFeishuPluginInteractiveHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  data: unknown;
}): Promise<unknown | undefined> {
  const basics = extractBasics(params.data);
  if (!basics) return undefined;
  if (!basics.action) return undefined;

  const { namespace, payload } = parseRouteKey(basics.action);
  if (!namespace) return undefined;

  const ctx: any = {
    channel: 'slack',
    accountId: params.accountId,
    conversationId: basics.openChatId || '',
    senderId: basics.senderOpenId,
    auth: {
      isAuthorizedSender: true,
    },
    interaction: {
      kind: 'button',
      data: basics.action,
      namespace,
      payload,
      actionId: namespace,
      messageTs: basics.openMessageId,
    },
    parentConversationId: undefined,
    threadId: undefined,
    rawEvent: params.data,
  };

  const respond = {
    acknowledge: async () => {},
    reply: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    followUp: async (args: { text: string }) => {
      if (!basics.openChatId || !String(args?.text || '').trim()) return;
      await sendMessageFeishu({
        cfg: params.cfg,
        to: basics.openChatId,
        text: String(args?.text || ''),
        replyToMessageId: basics.openMessageId,
        accountId: params.accountId,
        replyInThread: false,
      });
    },
    editMessage: async (args: { text?: string; blocks?: unknown[] }) => {
      if (!basics.openMessageId) {
        if (Array.isArray(args?.blocks) && args.blocks.length && basics.openChatId) {
          await sendCardFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
          return;
        }
        if (typeof args?.text === 'string' && args.text.trim() && basics.openChatId) {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: basics.openChatId,
            text: args.text,
            replyToMessageId: basics.openMessageId,
            accountId: params.accountId,
            replyInThread: false,
          });
        }
        return;
      }
      if (Array.isArray(args?.blocks) && args.blocks.length) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: { schema: '2.0', body: { elements: args.blocks as Record<string, unknown>[] } },
          accountId: params.accountId,
        });
        return;
      }
      if (typeof args?.text === 'string' && args.text.trim()) {
        await updateCardFeishu({
          cfg: params.cfg,
          messageId: basics.openMessageId,
          card: buildMarkdownCard(args.text),
          accountId: params.accountId,
        });
        return;
      }
      await updateCardFeishu({
        cfg: params.cfg,
        messageId: basics.openMessageId,
        card: { schema: '2.0', body: { elements: [] } },
        accountId: params.accountId,
      });
    },
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (dispatchPluginInteractiveHandler as any)({
      channel: 'slack',
      data: basics.action,
      ctx,
      respond,
    });
    return result ?? undefined;
  } catch (err) {
    log.warn(`interactive dispatch failed (namespace=${namespace}): ${String(err)}`);
    return {
      toast: {
        type: 'error',
        content: '交互处理失败，请稍后重试',
      },
    };
  }
}
