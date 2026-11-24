/**
 * The lawyer's only way to reach the court: HTTP to COURT_URL with the COURT_TOKEN header.
 * (No court imports. In Phase 4 the court is on another Sprite.)
 */
import type { Precedent } from "../shared/panel.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LawLibrary {
  text: string;
  articles: { number: number; title: string; body: string }[];
  sentencing: string[];
  warnings: string[];
}

export interface CourtEvent {
  id: number;
  ts: number;
  actor: string;
  kind: string;
  message: string;
  data: unknown;
}

export class CourtError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CourtClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = (i, init) => fetch(i, init),
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-court-token", this.token);
    headers.set("accept", "application/json");
    const res = await this.fetchImpl(`${this.base.replace(/\/+$/, "")}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new CourtError(res.status, body.error ?? `The court answered HTTP ${res.status}.`);
    return body;
  }

  lawLibrary() {
    return this.call<LawLibrary>("/law-library");
  }

  async precedent(q: string): Promise<Precedent[]> {
    return (await this.call<{ precedent: Precedent[] }>(`/api/precedent?q=${encodeURIComponent(q)}`)).precedent;
  }

  async parties(): Promise<{ alias: string; role: string }[]> {
    return (await this.call<{ parties: { alias: string; role: string }[] }>("/api/parties")).parties;
  }

  fileCase(body: { plaintiff: string; defendant: string; title?: string; claim: string; relief: string; argument?: string }) {
    return this.call<{ number: number; url: string }>("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  remark(n: number, text: string) {
    return this.call<{ ok: true }>(`/api/cases/${n}/remarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  getCase(n: number) {
    return this.call<any>(`/api/cases/${n}`);
  }

  /**
   * Follow a hearing's SSE stream until the case closes, reconnecting with Last-Event-ID when the
   * connection drops (Sprites drop open connections when they nap).
   */
  async watch(
    n: number,
    onEvent: (e: CourtEvent) => void,
    opts: { maxMs?: number; signal?: AbortSignal; stopOn?: (e: CourtEvent) => boolean } = {},
  ): Promise<"closed" | "timeout" | "stopped"> {
    const deadline = Date.now() + (opts.maxMs ?? 15 * 60_000);
    let last = 0;
    while (Date.now() < deadline && !opts.signal?.aborted) {
      let ended: "closed" | "timeout" | "stopped" | null = null;
      try {
        const res = await this.fetchImpl(`${this.base.replace(/\/+$/, "")}/cases/${n}/stream`, {
          headers: { "x-court-token": this.token, accept: "text/event-stream", ...(last ? { "last-event-id": String(last) } : {}) },
          signal: opts.signal,
        });
        if (!res.ok || !res.body) throw new CourtError(res.status, `The court's stream answered HTTP ${res.status}.`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const field = (k: string) => block.split("\n").find((l) => l.startsWith(`${k}:`))?.slice(k.length + 1).trim();
            const event = field("event");
            if (event === "court") {
              const e = JSON.parse(field("data") ?? "{}") as CourtEvent;
              if (e.id > last) {
                last = e.id;
                onEvent(e);
                if (opts.stopOn?.(e)) ended = "stopped";
              }
            } else if (event === "end") ended = "closed";
            else if (event === "timeout") ended = "timeout";
          }
          if (ended) break;
        }
        await reader.cancel().catch(() => {});
      } catch (err) {
        if (opts.signal?.aborted) break;
        if (err instanceof CourtError && err.status === 404) throw err;
      }
      if (ended === "closed" || ended === "stopped") return ended;
      await new Promise((r) => setTimeout(r, 1000)); // reconnect (dropped connection or the court's 10-minute limit)
    }
    return "timeout";
  }
}
