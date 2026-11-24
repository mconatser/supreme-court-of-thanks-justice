/**
 * Mistrial: Sprites time travel (SPEC §8.8).
 *
 * Before every deliberation the courthouse takes a checkpoint. Declaring a mistrial stamps the Box
 * record VACATED, then restores the checkpoint: the whole filesystem (code, node_modules, SQLite)
 * rewinds to before the ruling. On boot, an open case whose Box record says VACATED is closed as
 * vacated instead of resumed. The Box record remembers what the Sprite forgot.
 *
 * Verified CLI behavior (fc-court-dev, 2026-11-24):
 *   create --comment X  → JSON lines ending {"type":"complete","data":"Checkpoint v21 created successfully"}
 *   list                → JSON array of {id, create_time, comment?} (plus an id "Current")
 *   restore <id>        → returns at once and restarts the environment asynchronously. It does
 *                         NOT parse flags: any argument is taken as an id. So ids are validated here.
 */
import { execFile, spawn } from "node:child_process";

export interface Checkpoint {
  id: string;
  createdAt: number;
  comment?: string;
}

export interface SpriteEnv {
  create(comment: string): Promise<string>;
  list(): Promise<Checkpoint[]>;
  /** Spawn a detached restore after a delay (so the HTTP response can flush first). */
  restoreDetached(id: string, delayMs: number): void;
}

export const CHECKPOINT_ID = /^v\d+$/;

export class MistrialError extends Error {}

function run(bin: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} ${args[0]} ${args[1] ?? ""} failed: ${stderr || err.message}`.trim()));
      else resolve(stdout);
    });
  });
}

export function parseCreated(stdout: string): string {
  const m = stdout.match(/Checkpoint (v\d+) created/) ?? stdout.match(/ID:\s*(v\d+)/);
  if (!m) throw new Error("Couldn't find the new checkpoint's id in sprite-env's output.");
  return m[1];
}

export function parseList(stdout: string): Checkpoint[] {
  const rows = JSON.parse(stdout) as { id: string; create_time: string; comment?: string }[];
  return rows
    .filter((r) => CHECKPOINT_ID.test(r.id))
    .map((r) => ({ id: r.id, createdAt: Date.parse(r.create_time), comment: r.comment }));
}

export function spriteEnv(bin = "sprite-env"): SpriteEnv {
  return {
    async create(comment) {
      return parseCreated(await run(bin, ["checkpoints", "create", "--comment", comment]));
    },
    async list() {
      return parseList(await run(bin, ["checkpoints", "list"], 20_000));
    },
    restoreDetached(id, delayMs) {
      if (!CHECKPOINT_ID.test(id)) throw new MistrialError(`Refusing to restore "${id}": not a checkpoint id.`);
      setTimeout(() => {
        const child = spawn(bin, ["checkpoints", "restore", id], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      }, delayMs);
    },
  };
}

/** Marks a Box record as vacated (an HTML comment, so it's unambiguous to the boot check). */
export const VACATED_MARKER = "<!-- family-court:vacated -->";

export function vacatedBanner(caseLabel: string, when: Date): string {
  return `${VACATED_MARKER}\n> **VACATED.** A mistrial was declared in ${caseLabel} on ${when.toISOString().slice(0, 16).replace("T", " ")} UTC. The courthouse was rewound to before the ruling, so these proceedings never happened, but this record remembers.\n\n`;
}
