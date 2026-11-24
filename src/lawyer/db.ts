/** data/lawyer.db: the lawyer's memory, on its own Sprite's disk (SPEC §7). */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LawyerDB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  case_ref TEXT NOT NULL,
  role TEXT NOT NULL,              -- client | lawyer
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_ref ON conversations(case_ref, id);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  case_ref TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  note TEXT NOT NULL,              -- plain words for "counsel's notes"
  input_json TEXT,
  output_json TEXT
);
CREATE INDEX IF NOT EXISTS steps_ref ON steps(case_ref, id);

CREATE TABLE IF NOT EXISTS cases (
  case_ref TEXT PRIMARY KEY,
  title TEXT,
  court_case_number INTEGER,
  predicted REAL,                  -- 0..1, the filed draft's mock-trial win probability
  outcome TEXT,                    -- won | lost | compromise | contempt
  vote TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The agent loop's working state for each matter, so a Sprite nap never loses a conversation.
CREATE TABLE IF NOT EXISTS matters (
  case_ref TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL,     -- the Ollama transcript (system prompt excluded)
  pending_json TEXT,               -- an open ask_client question
  confirmed_json TEXT,             -- the exact filing the client said Yes to
  mock_calls INTEGER NOT NULL DEFAULT 0,
  mock_json TEXT,                  -- the latest mock-trial results
  running INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
`;

export function openLawyerDb(path: string): LawyerDB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}
