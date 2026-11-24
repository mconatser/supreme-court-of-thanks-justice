import { z } from "zod";

/** Empty strings in .env mean "not set". */
const opt = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());
const str = (def: string) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().default(def));
const int = (def: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.coerce.number().int().min(0).default(def));
const secret = (name: string) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string({ error: `${name} is missing` }).min(1, `${name} is missing`),
  );

export const ConfigSchema = z.object({
  MODE: z.enum(["all", "court", "lawyer"]).default("all"),
  PORT: int(8080),
  PUBLIC_BASE_URL: str(""),

  GATEWAY_MODE: z.enum(["live", "stub"]).default("stub"),
  GATEWAY_LIST_URL: str("https://api.sprites.dev/v1/gateway/list"),
  TYPESAFE_BASE: opt,
  OLLAMA_BASE: opt,
  BOX_BASE: opt,
  AGENTMAIL_BASE: opt,
  ELEVENLABS_BASE: opt,

  JEV_MODEL: str("jev-latest"),
  OLLAMA_MODEL: str("glm-5.3-flash"),

  COURT_URL: str("http://localhost:8080"),
  COURT_TOKEN: secret("COURT_TOKEN").pipe(z.string().min(16, "COURT_TOKEN should be at least 16 characters (try: openssl rand -hex 32)")),
  SESSION_SECRET: secret("SESSION_SECRET").pipe(z.string().min(16, "SESSION_SECRET should be at least 16 characters (try: openssl rand -hex 32)")),
  COURT_PASSCODE: secret("COURT_PASSCODE"),
  PARENT_PASSCODE: secret("PARENT_PASSCODE"),
  LAWYER_PASSCODE: secret("LAWYER_PASSCODE"),

  BOX_FAMILY_CODE_FILE_ID: opt,
  BOX_RECORDS_FOLDER_ID: opt,
  AGENTMAIL_INBOX_ID: opt,
  ELEVENLABS_VOICE_ID: opt,
  ELEVENLABS_MODEL_ID: opt,

  SUMMONS_TIMEOUT_MIN: int(15),
  MISTRIAL_ENABLED: z.preprocess((v) => v === true || v === "true", z.boolean()).default(false),

  JEV_DAILY: int(300),
  OLLAMA_DAILY: int(150),
  TTS_CHARS_DAILY: int(3000),
  EMAIL_DAILY: int(40),
  /** Budgets reset at midnight in this time zone. */
  COURT_TZ: str("America/New_York"),

  DATA_DIR: str("data"),
  PEOPLE_FILE: str("people.json"),
  CONTENT_DIR: str("content"),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "config"}: ${i.message}`);
    throw new ConfigError(`The court can't open yet. Please fix .env:\n${lines.join("\n")}`);
  }
  if (parsed.data.PARENT_PASSCODE === parsed.data.COURT_PASSCODE) {
    throw new ConfigError("The court can't open yet. PARENT_PASSCODE must be different from COURT_PASSCODE.");
  }
  return parsed.data;
}
