import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const db = new Database(path.join(__dirname, 'learnpal.db'))

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL')

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id       TEXT    NOT NULL,
    video_title    TEXT    NOT NULL,
    participant_id TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT    NOT NULL,
    provider    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS snaps (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    image_data         TEXT,
    timestamp_seconds  REAL,
    timestamp_str      TEXT,
    region             TEXT,
    user_prompt        TEXT,
    ai_response        TEXT,
    provider           TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question       TEXT    NOT NULL,
    options        TEXT    NOT NULL,
    correct_index  INTEGER NOT NULL,
    selected_index INTEGER,
    is_correct     INTEGER,
    difficulty     INTEGER NOT NULL DEFAULT 1,
    provider       TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    event_type       TEXT    NOT NULL,
    playback_seconds REAL,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`)

export default db
