import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock image-gen — keep extractImageDirective/resolvePresets real (they are
// pure), replace the network-hitting generateImage/editImage with spies.
vi.mock('./image-gen.js', async () => {
  const actual =
    await vi.importActual<typeof import('./image-gen.js')>('./image-gen.js');
  return {
    ...actual,
    generateImage: vi.fn(),
    editImage: vi.fn(),
  };
});

// TTS never needs to hit an API in these tests — no `[[tts:]]` directives in
// the fixtures, but stub synthesize so accidental execution doesn't make
// outbound requests.
vi.mock('./tts.js', async () => {
  const actual = await vi.importActual<typeof import('./tts.js')>('./tts.js');
  return {
    ...actual,
    synthesize: vi.fn().mockResolvedValue(null),
  };
});

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { sendWithTts } from './index.js';
import { editImage, generateImage } from './image-gen.js';
import type { Channel } from './types.js';

interface MockedChannel extends Channel {
  __calls: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendPhoto: ReturnType<typeof vi.fn>;
    sendDocument: ReturnType<typeof vi.fn>;
    sendVoice: ReturnType<typeof vi.fn>;
  };
}

function makeMockChannel(): MockedChannel {
  const sendMessage = vi.fn().mockResolvedValue('m-100');
  const sendPhoto = vi.fn().mockResolvedValue('m-101');
  const sendDocument = vi.fn().mockResolvedValue('m-102');
  const sendVoice = vi.fn().mockResolvedValue('m-103');
  const channel: MockedChannel = {
    name: 'test',
    connect: vi.fn(),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: vi.fn(),
    sendMessage,
    sendPhoto,
    sendDocument,
    sendVoice,
    __calls: { sendMessage, sendPhoto, sendDocument, sendVoice },
  };
  return channel;
}

// Temp files stand in for preview (JPEG) and original (PNG). Small ones so
// the 9MB document-fallback path is NOT triggered by default.
let tmpPreview: string;
let tmpOriginal: string;

beforeEach(() => {
  _initTestDatabase();
  // Satisfy FK on messages.chat_jid → chats.jid when storeOutgoingMessage fires
  storeChatMetadata('tg:123', '2026-04-23T00:00:00.000Z');
  storeChatMetadata('tg:1', '2026-04-23T00:00:00.000Z');
  vi.clearAllMocks();
  const base = path.join(
    os.tmpdir(),
    `nanoclaw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  tmpPreview = `${base}.jpg`;
  tmpOriginal = `${base}.png`;
  fs.writeFileSync(tmpPreview, Buffer.alloc(1024));
  fs.writeFileSync(tmpOriginal, Buffer.alloc(2048));
});

afterEach(() => {
  try {
    fs.unlinkSync(tmpPreview);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(tmpOriginal);
  } catch {
    /* ignore */
  }
});

describe('sendWithTts — image tag dispatch (fix for IPC/scheduler silent-drop)', () => {
  it('with groupFolder + [[image:]] → generateImage fires, sendPhoto called, sendMessage NOT called', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    const channel = makeMockChannel();

    await sendWithTts(channel, 'tg:123', '[[image: a cat]]', undefined, 'main');

    await vi.waitFor(() => {
      expect(generateImage).toHaveBeenCalledWith(
        'a cat',
        expect.stringContaining('attachments'),
        [],
      );
      expect(channel.__calls.sendPhoto).toHaveBeenCalled();
    });
    // Tag-only message → cleanText is empty → no literal text leaked.
    expect(channel.__calls.sendMessage).not.toHaveBeenCalled();
  });

  it('REGRESSION: without groupFolder + [[image:]] → generateImage NOT called, tag leaks as literal text (demonstrates the bug the fix targets)', async () => {
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image: a cat]]',
      undefined,
      undefined,
    );

    expect(generateImage).not.toHaveBeenCalled();
    expect(channel.__calls.sendPhoto).not.toHaveBeenCalled();
    // The pre-fix behavior: tag flows through as plain text.
    expect(channel.__calls.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      '[[image: a cat]]',
      undefined,
    );
  });

  it('with groupFolder: presets parsed and forwarded to generateImage', async () => {
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image:portrait,hd: a cat]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(generateImage).toHaveBeenCalledWith('a cat', expect.any(String), [
        'portrait',
        'hd',
      ]);
    });
  });

  it('with groupFolder + [[image-edit:...]] → editImage fires, sendPhoto called', async () => {
    (editImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });
    const channel = makeMockChannel();

    await sendWithTts(
      channel,
      'tg:123',
      '[[image-edit: attachments/foo.jpg | bluer]]',
      undefined,
      'main',
    );

    await vi.waitFor(() => {
      expect(editImage).toHaveBeenCalled();
      expect(channel.__calls.sendPhoto).toHaveBeenCalled();
    });
    expect(channel.__calls.sendMessage).not.toHaveBeenCalled();
  });

  it('IPC-path wrapper contract: when folder is resolved and passed, tag is handled; when omitted, literal leaks', async () => {
    // Simulate the two sides of the pre-fix vs post-fix IPC sendMessage:
    // The wrapper is essentially `sendWithTts(ch, jid, text, undefined, folder?)`.
    (generateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      previewPath: tmpPreview,
      originalPath: tmpOriginal,
    });

    const postFixChannel = makeMockChannel();
    const postFixSendMessage = (
      jid: string,
      text: string,
      folder: string | undefined,
    ) => sendWithTts(postFixChannel, jid, text, undefined, folder);

    const preFixChannel = makeMockChannel();
    const preFixSendMessage = (jid: string, text: string) =>
      sendWithTts(preFixChannel, jid, text);

    await postFixSendMessage('tg:1', '[[image: cat]]', 'main');
    await preFixSendMessage('tg:1', '[[image: cat]]');

    await vi.waitFor(() => {
      // Post-fix: image pipeline engaged.
      expect(postFixChannel.__calls.sendPhoto).toHaveBeenCalled();
    });
    // Pre-fix simulation: tag was forwarded as text (demonstrates the hole).
    expect(preFixChannel.__calls.sendMessage).toHaveBeenCalledWith(
      'tg:1',
      '[[image: cat]]',
      undefined,
    );
    // And post-fix does NOT leak as text:
    expect(postFixChannel.__calls.sendMessage).not.toHaveBeenCalled();
  });

  it('non-tag text with groupFolder goes through sendMessage as normal', async () => {
    const channel = makeMockChannel();
    await sendWithTts(channel, 'tg:123', 'hello there', undefined, 'main');
    expect(generateImage).not.toHaveBeenCalled();
    expect(channel.__calls.sendMessage).toHaveBeenCalledWith(
      'tg:123',
      'hello there',
      undefined,
    );
  });
});
