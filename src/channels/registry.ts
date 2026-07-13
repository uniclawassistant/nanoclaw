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
  // FED-38: interrupt a group's in-flight run (`/stop`) without touching the
  // session. Returns 'interrupted' when a busy run was signalled, 'idle' when a
  // container is up but between turns, 'none' when nothing is running.
  stopGroupRun?: (folder: string) => 'interrupted' | 'idle' | 'none';
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
