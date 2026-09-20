import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('defaults Telegram backfill chats to direct messages', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('adds continuation guard columns to populated open work', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE open_work (
          id TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          remaining TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          continuation_count INTEGER NOT NULL DEFAULT 0,
          pending_task_id TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          halted_reason TEXT,
          claimed_task_id TEXT,
          PRIMARY KEY (group_folder, id)
        );
        INSERT INTO open_work (
          id, group_folder, chat_jid, remaining, opened_at,
          continuation_count, status
        ) VALUES (
          'audit', 'main', 'tg:owner', 'finish it',
          '2026-09-14T20:00:00.000Z', 3, 'open'
        );
      `);
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getOpenWork, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      expect(getOpenWork('main', 'audit')).toMatchObject({
        continuation_count: 3,
        last_continuation_at: '2026-09-14T20:00:00.000Z',
        empty_continuation_count: 0,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('reopens legacy and unrecognized halt kinds after the silence window', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-db-test-'));

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE open_work (
          id TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          remaining TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          continuation_count INTEGER NOT NULL DEFAULT 0,
          last_continuation_at TEXT,
          empty_continuation_count INTEGER NOT NULL DEFAULT 0,
          pending_task_id TEXT,
          claimed_task_id TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          halted_kind TEXT,
          halted_reason TEXT,
          PRIMARY KEY (group_folder, id)
        );
        INSERT INTO open_work (
          id, group_folder, chat_jid, remaining, opened_at,
          continuation_count, last_continuation_at, status, halted_reason
        ) VALUES
          (
            'old-count', 'main', 'tg:owner', 'finish it',
            '2026-09-20T00:00:00.000Z', 8, '2026-09-20T01:00:00.000Z',
            'halted', 'MAX_CONTINUATIONS (8) reached'
          ),
          (
            'missing-reason', 'main', 'tg:owner', 'finish it',
            '2026-09-20T00:00:00.000Z', 0, NULL,
            'halted', NULL
          );
        INSERT INTO open_work (
          id, group_folder, chat_jid, remaining, opened_at,
          continuation_count, last_continuation_at, status,
          halted_kind, halted_reason
        ) VALUES (
          'future-kind', 'main', 'tg:owner', 'finish it',
          '2026-09-20T00:00:00.000Z', 0, NULL, 'halted',
          'future-policy', 'a future halt policy stopped this work'
        );
      `);
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getOpenWork, _closeDatabase } =
        await import('./db.js');
      const { openWork } = await import('./work-continuation.js');

      initDatabase();

      expect(getOpenWork('main', 'old-count')).toMatchObject({
        halted_kind: 'unknown',
        halted_reason: 'MAX_CONTINUATIONS (8) reached',
      });
      expect(
        openWork(
          'main',
          'tg:owner',
          'old-count',
          'too soon',
          new Date('2026-09-20T06:00:00.000Z'),
        ),
      ).toEqual({
        accepted: false,
        reason:
          'MAX_CONTINUATIONS (8) reached; 1 hour of continuation silence remaining before this name can reopen',
      });
      expect(
        openWork(
          'main',
          'tg:owner',
          'missing-reason',
          'too soon',
          new Date('2026-09-20T05:00:00.000Z'),
        ),
      ).toEqual({
        accepted: false,
        reason:
          'work continuation is halted; 1 hour of continuation silence remaining before this name can reopen',
      });
      expect(
        openWork(
          'main',
          'tg:owner',
          'future-kind',
          'too soon',
          new Date('2026-09-20T05:00:00.000Z'),
        ),
      ).toEqual({
        accepted: false,
        reason:
          'a future halt policy stopped this work; 1 hour of continuation silence remaining before this name can reopen',
      });
      expect(
        openWork(
          'main',
          'tg:owner',
          'old-count',
          'new cycle',
          new Date('2026-09-20T07:01:00.000Z'),
        ),
      ).toMatchObject({ accepted: true });
      expect(
        openWork(
          'main',
          'tg:owner',
          'future-kind',
          'new cycle',
          new Date('2026-09-20T07:01:00.000Z'),
        ),
      ).toMatchObject({ accepted: true });
      expect(
        openWork(
          'main',
          'tg:owner',
          'missing-reason',
          'new cycle',
          new Date('2026-09-20T07:01:00.000Z'),
        ),
      ).toMatchObject({ accepted: true });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
