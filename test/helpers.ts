import { createCourtApp, type CourtAppOptions } from "../src/court/app.ts";
import { createCourtContext, type ContextOverrides, type CourtContext } from "../src/court/context.ts";
import { loadConfig } from "../src/shared/config.ts";
import { parsePeople } from "../src/shared/people.ts";

export const TEST_ENV: Record<string, string> = {
  GATEWAY_MODE: "stub",
  COURT_TOKEN: "test-court-token-0123456789abcdef",
  SESSION_SECRET: "test-session-secret-0123456789abcdef",
  COURT_PASSCODE: "court-pass",
  PARENT_PASSCODE: "parent-pass",
  LAWYER_PASSCODE: "lawyer-pass",
  CONTENT_DIR: "content",
  DATA_DIR: "data-test-unused",
  JEV_MODEL: "jev-1.14.0",
  OLLAMA_MODEL: "glm-5.3-flash",
};

/** Made-up court aliases only. Covers every party used in test/cases. */
export const TEST_PEOPLE = parsePeople([
  { id: "p1", alias: "The Big Cheese", role: "parent" },
  { id: "p2", alias: "Pip", role: "kid" },
  { id: "p3", alias: "Sky Sister", role: "kid" },
  { id: "p4", alias: "Comet", role: "kid" },
]);

export function makeCtx(env: Record<string, string> = {}, o: ContextOverrides = {}): CourtContext {
  const cfg = loadConfig({ ...TEST_ENV, ...env });
  // No landmarks unless a test asks for them, so precedent tests stay about what they test.
  return createCourtContext(cfg, TEST_PEOPLE, { dbPath: ":memory:", log: () => {}, landmarksPath: "test/no-landmarks.md", ...o });
}

export function makeApp(env: Record<string, string> = {}, opts: CourtAppOptions = {}, o: ContextOverrides = {}) {
  const ctx = makeCtx(env, o);
  return { ctx, app: createCourtApp(ctx, opts) };
}

/** Log in and return the cookie header to send with later requests. */
export async function login(app: ReturnType<typeof makeApp>["app"], passcode = TEST_ENV.COURT_PASSCODE): Promise<string> {
  const res = await app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Read an SSE response until `stopAt` returns true or the stream ends. */
export async function readSSE(res: Response, stopAt: (text: string) => boolean = () => false, timeoutMs = 5000): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) => setTimeout(() => resolve({ done: true }), deadline - Date.now())),
    ]);
    if (r.done) break;
    text += dec.decode(r.value, { stream: true });
    if (stopAt(text)) break;
  }
  await reader.cancel().catch(() => {});
  return text;
}

export function sseEvents(text: string) {
  return text
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const get = (k: string) => lines.find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();
      return { event: get("event"), id: get("id"), data: get("data") };
    })
    .filter((e) => e.event);
}
