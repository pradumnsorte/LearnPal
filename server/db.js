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
    paradigm       TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT    NOT NULL,
    provider    TEXT,
    source      TEXT,
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
    meta             TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`)

// Migrate existing event tables that pre-date the meta column.
const eventCols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name)
if (!eventCols.includes('meta')) {
  db.exec('ALTER TABLE events ADD COLUMN meta TEXT')
}

// Migrate quiz_attempts to add time_to_answer_seconds (seconds the user spent
// on the question between it landing in the modal and clicking Submit).
const quizCols = db.prepare("PRAGMA table_info(quiz_attempts)").all().map((c) => c.name)
if (!quizCols.includes('time_to_answer_seconds')) {
  db.exec('ALTER TABLE quiz_attempts ADD COLUMN time_to_answer_seconds REAL')
}

// Migrate sessions to add paradigm column.
const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name)
if (!sessionCols.includes('paradigm')) {
  db.exec('ALTER TABLE sessions ADD COLUMN paradigm TEXT')
}

// Migrate messages to add source column (where the message originated:
// 'chat' | 'snap_ask' | 'quiz_explain' | 'highlight_detail' | 'keyword_detail' | 'visual_detail' | 'chat_suggestion').
const messageCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name)
if (!messageCols.includes('source')) {
  db.exec('ALTER TABLE messages ADD COLUMN source TEXT')
}

export default db
