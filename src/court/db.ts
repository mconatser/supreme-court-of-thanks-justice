import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  number INTEGER UNIQUE NOT NULL,
  title TEXT NOT NULL,
  plaintiff TEXT NOT NULL,
  defendant TEXT NOT NULL,
  type TEXT,                       -- complaint | petition | declaration (set at screening)
  filed_by TEXT NOT NULL,          -- lawyer | pro_se
  claim TEXT NOT NULL,
  relief TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ruled_at INTEGER
);

CREATE TABLE IF NOT EXISTS filings (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  author TEXT NOT NULL,
  kind TEXT NOT NULL,              -- complaint | argument | response | testimony | evidence | appeal
  body TEXT NOT NULL,
  contempt_noul REAL,
  struck INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS filings_case ON filings(case_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,             -- clerk | bailiff | judge | court
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_case ON events(case_id, id);

CREATE TABLE IF NOT EXISTS rulings (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  round INTEGER NOT NULL DEFAULT 0,
  panel_json TEXT,
  outcome TEXT,                    -- plaintiff | defendant | compromise | contempt
  vote TEXT,
  case_confidence REAL,
  sentence_level INTEGER,
  sentence_text TEXT,
  opinion_md TEXT,
  bench_verdict TEXT,
  cited_articles_json TEXT,
  box_file_id TEXT,
  audio_path TEXT,
  checkpoint_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(case_id, round)
);

CREATE TABLE IF NOT EXISTS summons (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  person_id TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  sent_via TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);

-- Read-only links to one case (in ruling emails), for people who don't have the court passcode.
CREATE TABLE IF NOT EXISTS case_links (
  token TEXT PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  person_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(case_id, person_id)
);

CREATE TABLE IF NOT EXISTS budget (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db: DB) {
  const addColumn = (table: string, column: string, type: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  // Person ids (from people.json), so the UI can show each party's *current* alias.
  addColumn("cases", "plaintiff_id", "TEXT");
  addColumn("cases", "defendant_id", "TEXT");
  addColumn("filings", "author_id", "TEXT");
  // Granted petitions need a parent's OK: NULL (not needed) | pending | approved | denied
  addColumn("cases", "approval", "TEXT");
}

/**
 * Fill in missing person ids by matching the alias snapshot stored at filing time against
 * people.json (alias first, then id). Only fills NULLs, so it's safe to run on every boot.
 */
export function linkParties(db: DB, people: { id: string; alias: string }[]) {
  const tx = db.transaction(() => {
    for (const p of people) {
      for (const key of [p.alias, p.id]) {
        db.prepare("UPDATE cases SET plaintiff_id = ? WHERE plaintiff_id IS NULL AND lower(plaintiff) = lower(?)").run(p.id, key);
        db.prepare("UPDATE cases SET defendant_id = ? WHERE defendant_id IS NULL AND lower(defendant) = lower(?)").run(p.id, key);
        db.prepare("UPDATE filings SET author_id = ? WHERE author_id IS NULL AND lower(author) = lower(?)").run(p.id, key);
      }
    }
  });
  tx();
}

// ---------- row types ----------

export type CaseStatus =
  | "filed"
  | "screening"
  | "contempt"
  | "gathering"
  | "awaiting_testimony"
  | "deliberating"
  | "ruled"
  | "too_close"
  | "appealed"
  | "vacated";

export const FINAL_STATUSES: ReadonlySet<string> = new Set(["contempt", "ruled", "too_close", "vacated"]);
export const OPEN_STATUSES: ReadonlySet<string> = new Set(["filed", "screening", "gathering", "awaiting_testimony", "deliberating", "appealed"]);

export interface CaseRow {
  id: number;
  number: number;
  title: string;
  plaintiff: string;
  defendant: string;
  type: string | null;
  filed_by: string;
  claim: string;
  relief: string;
  status: CaseStatus;
  created_at: number;
  ruled_at: number | null;
  plaintiff_id: string | null;
  defendant_id: string | null;
  approval: "pending" | "approved" | "denied" | null;
}

export interface FilingRow {
  id: number;
  case_id: number;
  author: string;
  kind: string;
  body: string;
  contempt_noul: number | null;
  struck: number;
  created_at: number;
  author_id: string | null;
}

export interface EventRow {
  id: number;
  case_id: number;
  ts: number;
  actor: string;
  kind: string;
  message: string;
  data_json: string | null;
}

export interface RulingRow {
  id: number;
  case_id: number;
  round: number;
  panel_json: string | null;
  outcome: string | null;
  vote: string | null;
  case_confidence: number | null;
  sentence_level: number | null;
  sentence_text: string | null;
  opinion_md: string | null;
  bench_verdict: string | null;
  cited_articles_json: string | null;
  created_at: number;
}
