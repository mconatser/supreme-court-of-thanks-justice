/**
 * The Family Code: Max's laws. Box is the source of truth (cached by file version), with
 * content/family-code.md as the fallback and the only source when Box isn't configured.
 *
 * Articles are `## Article N. Title` headings. Sentencing guidelines are a numbered list (0–4)
 * under `## Sentencing Guidelines`. If parsing fails, fall back to default tiers with a warning.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Article {
  number: number;
  title: string;
  body: string;
}

export interface FamilyCode {
  /** Text sent to Jev and shown in the law library (HTML comments stripped). */
  text: string;
  articles: Article[];
  sentencing: string[];
  usingDefaultSentencing: boolean;
  /** Polite notes for the docket. */
  warnings: string[];
}

export const DEFAULT_SENTENCING = [
  "Case closed with a friendly warning",
  "A sincere apology to the other party",
  "One extra chore for the other party",
  "Lose first pick (front seat, dessert choice or the remote) for a day",
  "Lose a privilege for a weekend, as approved by a parent",
];

const isPlaceholder = (s: string) => /^\s*\(.*\)\s*$/.test(s) || s.trim() === "" || s.includes("(…)") || s.includes("(...)");

export function parseFamilyCode(md: string): FamilyCode {
  const text = md.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const warnings: string[] = [];

  // Split into level-2 sections.
  const sections: { heading: string; body: string }[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
      current = { heading: m[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });

  const articles: Article[] = [];
  const templateArticles: number[] = [];
  for (const s of sections) {
    const m = s.heading.match(/^Article\s+(\d+)\.?\s*(.*)$/i);
    if (!m) continue;
    const number = Number(m[1]);
    const title = m[2].trim();
    if (isPlaceholder(title) || isPlaceholder(s.body) || /delete me/i.test(title)) templateArticles.push(number);
    articles.push({ number, title, body: s.body });
  }
  if (!articles.length) warnings.push("The court couldn't find any articles in the Family Code yet.");
  if (templateArticles.length) {
    warnings.push(`Some articles are still examples or blanks (Article ${templateArticles.join(", ")}). The lawmaker has homework!`);
  }

  let sentencing: string[] = [];
  const sg = sections.find((s) => /^sentencing guidelines/i.test(s.heading));
  if (sg) {
    for (const line of sg.body.split("\n")) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      if (m) sentencing[Number(m[1])] = m[2].trim();
    }
  }
  sentencing = Array.from({ length: 5 }, (_, i) => sentencing[i] ?? "");
  const usingDefaultSentencing = sentencing.some(isPlaceholder);
  if (usingDefaultSentencing) {
    sentencing = [...DEFAULT_SENTENCING];
    warnings.push("The Sentencing Guidelines aren't finished, so the court is using its built-in punishments for now.");
  }

  return { text, articles, sentencing, usingDefaultSentencing, warnings };
}

export interface CodeOrigin {
  /** box: fresh from Box · box-cache: last copy saved from Box · file: content/family-code.md */
  source: "box" | "box-cache" | "file";
  version: string | null;
}

export interface FamilyCodeOptions {
  /** content/family-code.md: the fallback (and the only source when Box isn't configured). */
  filePath: string;
  /** Where the last good copy from Box is saved, so a cold start works without Box. */
  cachePath?: string;
  box?: { fileInfo(id: string): Promise<{ versionId: string }>; downloadText(id: string): Promise<string> };
  fileId?: string;
  /** Don't ask Box for the version more often than this (one cheap call per hearing at most). */
  minCheckMs?: number;
  log?: (m: string) => void;
  now?: () => number;
}

/**
 * The Family Code. With Box configured, Box is the source of truth, cached by file version and
 * re-downloaded only when the version changes. If Box can't be reached the court keeps going on
 * its last saved copy (or the local file) and says so politely on the docket.
 */
export class FamilyCodeSource {
  private text = "";
  private origin: CodeOrigin = { source: "file", version: null };
  private fileMtime = -1;
  private parsed?: { text: string; code: FamilyCode };
  private lastCheck = 0;
  private boxTrouble = false;

  constructor(private readonly opts: FamilyCodeOptions) {
    if (this.usesBox && opts.cachePath) {
      try {
        const meta = JSON.parse(readFileSync(`${opts.cachePath}.json`, "utf8")) as { version: string; fileId: string };
        if (meta.fileId === opts.fileId) {
          this.text = readFileSync(opts.cachePath, "utf8");
          this.origin = { source: "box-cache", version: meta.version };
        }
      } catch {}
    }
  }

  get usesBox() {
    return !!(this.opts.box && this.opts.fileId);
  }

  get where(): CodeOrigin {
    return { ...this.origin };
  }

  private readFile() {
    try {
      const m = statSync(this.opts.filePath).mtimeMs;
      if (m !== this.fileMtime) {
        this.fileMtime = m;
        this.text = readFileSync(this.opts.filePath, "utf8");
      }
      return true;
    } catch {
      return false;
    }
  }

  load(): FamilyCode {
    let missing = false;
    if (this.origin.source === "file") missing = !this.readFile();
    if (this.parsed?.text !== this.text) this.parsed = { text: this.text, code: parseFamilyCode(this.text) };
    const code = this.parsed.code;
    const extra: string[] = [];
    if (missing) extra.push("The court couldn't find the Family Code file.");
    if (this.usesBox && this.boxTrouble) {
      extra.push(
        this.origin.source === "file"
          ? "The court couldn't reach the Family Code in Box, so it's using the local copy for now."
          : "The court couldn't reach Box just now, so it's using its last saved copy of the Family Code.",
      );
    }
    return extra.length ? { ...code, warnings: [...code.warnings, ...extra] } : code;
  }

  /** Check Box for a new version (throttled unless forced). Never throws. */
  async refresh(force = false): Promise<FamilyCode> {
    const { box, fileId } = this.opts;
    if (!box || !fileId) return this.load();
    const now = (this.opts.now ?? Date.now)();
    if (!force && now - this.lastCheck < (this.opts.minCheckMs ?? 30_000) && this.origin.source === "box") return this.load();
    this.lastCheck = now;
    try {
      const info = await box.fileInfo(fileId);
      if (force || info.versionId !== this.origin.version || this.origin.source !== "box") {
        if (info.versionId !== this.origin.version || force) {
          this.text = await box.downloadText(fileId);
          if (this.opts.cachePath) {
            mkdirSync(dirname(this.opts.cachePath), { recursive: true });
            writeFileSync(this.opts.cachePath, this.text);
            writeFileSync(`${this.opts.cachePath}.json`, JSON.stringify({ fileId, version: info.versionId }));
          }
          this.opts.log?.(`[family-code] loaded version ${info.versionId} from Box`);
        }
        this.origin = { source: "box", version: info.versionId };
      }
      this.boxTrouble = false;
    } catch (err) {
      this.boxTrouble = true;
      this.opts.log?.(`[family-code] Box unavailable, using ${this.origin.source}: ${(err as Error).message}`);
      if (this.origin.source === "file") this.readFile();
    }
    return this.load();
  }
}
