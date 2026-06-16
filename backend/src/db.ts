import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type ServerRow = {
  id: string
  name: string
  access_password_hash: string
  created_at: string
}

export type RoomRow = {
  id: string
  server_id: string
  name: string
  kind: "voice" | "text"
  options: string
  created_at: string
}

export type MemberStateRow = {
  server_id: string
  room_id: string | null
  client_id: string
  display_name: string
  muted: number
  deafened: number
  speaking: number
  screen_sharing: number
  watching_screen: number
  last_seen: string
}

export function initDb(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")

  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      access_password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      options TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(server_id) REFERENCES servers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_rooms_server_id ON rooms(server_id);

    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(server_id, client_id),
      FOREIGN KEY(server_id) REFERENCES servers(id)
    );

    CREATE TABLE IF NOT EXISTS server_roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      role_key TEXT NOT NULL,
      name TEXT NOT NULL,
      permissions_json TEXT NOT NULL DEFAULT '{}',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_id, role_key),
      FOREIGN KEY(server_id) REFERENCES servers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_server_roles_server_id ON server_roles(server_id);

    CREATE TABLE IF NOT EXISTS member_roles (
      server_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(server_id, client_id, role_id),
      FOREIGN KEY(server_id) REFERENCES servers(id),
      FOREIGN KEY(role_id) REFERENCES server_roles(id)
    );

    CREATE INDEX IF NOT EXISTS idx_member_roles_server_client ON member_roles(server_id, client_id);

    CREATE TABLE IF NOT EXISTS member_state (
      server_id TEXT NOT NULL,
      room_id TEXT NULL,
      client_id TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      deafened INTEGER NOT NULL DEFAULT 0,
      speaking INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(server_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at TEXT NULL,
      FOREIGN KEY(server_id) REFERENCES servers(id),
      FOREIGN KEY(channel_id) REFERENCES rooms(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_server_created ON messages(server_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NULL,
      server_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      uploader_client_id TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER NULL,
      height INTEGER NULL,
      duration_ms INTEGER NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(message_id) REFERENCES messages(id),
      FOREIGN KEY(server_id) REFERENCES servers(id),
      FOREIGN KEY(channel_id) REFERENCES rooms(id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_server_channel ON message_attachments(server_id, channel_id, created_at DESC);

    -- Backward compatibility for older DB file: ensure display_name exists in member_state.
    -- If it exists, keep it unused by new code.
  `)

  const memberStateColumns = db.prepare("PRAGMA table_info(member_state)").all() as Array<{ name: string }>
  const hasColumn = (name: string) => memberStateColumns.some((c) => c.name === name)
  if (!hasColumn("display_name")) {
    db.exec("ALTER TABLE member_state ADD COLUMN display_name TEXT DEFAULT ''")
  }
  if (!hasColumn("screen_sharing")) {
    db.exec("ALTER TABLE member_state ADD COLUMN screen_sharing INTEGER NOT NULL DEFAULT 0")
  }
  if (!hasColumn("watching_screen")) {
    db.exec("ALTER TABLE member_state ADD COLUMN watching_screen INTEGER NOT NULL DEFAULT 0")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_member_state_server_room ON member_state(server_id, room_id)")

  return db
}
