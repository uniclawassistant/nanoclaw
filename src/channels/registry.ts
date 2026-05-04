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
  // FED-21 Bug 3: clears the host-side in-memory `sessions[folder]` map so
  // /new actually resets the SDK conversation. Without this the next user
  // message after /new still carries the old sessionId as `resume` until the
  // SDK errors out and we drop it via the staleSession path — meanwhile the
  // ctx counter shows the pre-/new value.
  clearInMemorySession?: (folder: string) => void;
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
