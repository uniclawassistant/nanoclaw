import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // FED-21 / PR #61: resets a group's session via the host's shared
  // resetGroupSession() helper. Channels (e.g. Telegram /new) should call
  // this rather than reproducing the kill+JSONL-delete+sessions-clear logic
  // inline, so spawn-time and shutdown-time naming stay in lockstep.
  // mode='new' is a full reset; mode='restart' is container-kill-only.
  resetGroupSession?: (folder: string, mode: 'new' | 'restart') => void;
  // FED-22: looks up the bot's outbound message text and the prior inbound
  // user message text for a reaction wake. Returns null when message_id is
  // not a known bot outbound (filter "target.from.id == bot.id").
  getReactionWakeContext?: (
    chatJid: string,
    messageId: string,
  ) => {
    myText: string;
    priorUserMessageText: string | null;
  } | null;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
