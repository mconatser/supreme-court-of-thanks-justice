import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Budget } from "../shared/budget.ts";
import { loadCast, type Cast } from "../shared/cast.ts";
import type { Config } from "../shared/config.ts";
import { Gateway, type Fetch } from "../shared/gateway.ts";
import { createJev, type Jev } from "../shared/jev.ts";
import { createOllama, type Ollama } from "../shared/ollama.ts";
import type { Person } from "../shared/people.ts";
import { linkParties, openDb, type DB, type EventRow } from "./db.ts";
import { FamilyCodeSource } from "./familyCode.ts";
import { LandmarkSource } from "./landmarks.ts";
import { Hearings } from "./hearing.ts";

export interface CourtContext {
  cfg: Config;
  db: DB;
  people: Person[];
  cast: Cast;
  gateway: Gateway;
  jev: Jev;
  ollama: Ollama;
  budget: Budget;
  /** Emits "event" with each new EventRow. */
  bus: EventEmitter<{ event: [EventRow] }>;
  familyCode: FamilyCodeSource;
  landmarks: LandmarkSource;
  persona: () => string;
  hearings: Hearings;
  bootedAt: number;
  deployId: string | null;
  log: (msg: string) => void;
}

export interface ContextOverrides {
  dbPath?: string;
  fetchImpl?: Fetch;
  jev?: Jev;
  ollama?: Ollama;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Defaults to <CONTENT_DIR>/landmark-cases.md. */
  landmarksPath?: string;
}

export function createCourtContext(cfg: Config, people: Person[], o: ContextOverrides = {}): CourtContext {
  const log = o.log ?? ((m: string) => console.log(m));
  const db = openDb(o.dbPath ?? join(cfg.DATA_DIR, "court.db"));
  linkParties(db, people);
  const budget = new Budget(
    db,
    { jev: cfg.JEV_DAILY, ollama: cfg.OLLAMA_DAILY, tts_chars: cfg.TTS_CHARS_DAILY, email: cfg.EMAIL_DAILY },
    cfg.COURT_TZ,
    o.now,
  );
  const gateway = new Gateway({
    mode: cfg.GATEWAY_MODE,
    listUrl: cfg.GATEWAY_LIST_URL,
    overrides: {
      typesafe: cfg.TYPESAFE_BASE,
      ollama: cfg.OLLAMA_BASE,
      box: cfg.BOX_BASE,
      agentmail: cfg.AGENTMAIL_BASE,
      elevenlabs: cfg.ELEVENLABS_BASE,
    },
    fetchImpl: o.fetchImpl,
    log,
  });
  const bus = new EventEmitter<{ event: [EventRow] }>();
  bus.setMaxListeners(200);

  let deployId: string | null = null;
  try {
    deployId = readFileSync(join(cfg.DATA_DIR, "DEPLOY_ID"), "utf8").trim() || null;
  } catch {}

  const personaPath = join(cfg.CONTENT_DIR, "judge-persona.md");
  const ctx = {
    cfg,
    db,
    people,
    cast: loadCast(cfg.CONTENT_DIR),
    gateway,
    jev: o.jev ?? createJev({ gateway, budget, model: cfg.JEV_MODEL, log }),
    ollama: o.ollama ?? createOllama({ gateway, budget, model: cfg.OLLAMA_MODEL }),
    budget,
    bus,
    familyCode: new FamilyCodeSource(join(cfg.CONTENT_DIR, "family-code.md")),
    landmarks: new LandmarkSource(o.landmarksPath ?? join(cfg.CONTENT_DIR, "landmark-cases.md")),
    persona: () => {
      try {
        return readFileSync(personaPath, "utf8");
      } catch {
        return "You are a kind, funny family-court judge.";
      }
    },
    bootedAt: Date.now(),
    deployId,
    log,
  } as Omit<CourtContext, "hearings"> as CourtContext;
  ctx.hearings = new Hearings(ctx);
  return ctx;
}
