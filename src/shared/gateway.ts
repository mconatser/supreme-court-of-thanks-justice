/**
 * Sprites connector gateway: discovery + fetch, in live and stub modes.
 *
 * Live: https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>. The gateway
 * identifies the calling Sprite and attaches the stored credential, so our own calls never
 * send an Authorization header. (The TypeSafe SDK sends a placeholder key, which its
 * usage_snippet says is fine.)
 *
 * Stub: GATEWAY_MODE=stub serves canned answers from fixtures/ (see stub.ts).
 */
import { stubFetch } from "./stub.ts";

/**
 * elevenlabs_tts is the Custom API connector for https://api.elevenlabs.io (ELEVENLABS_BASE): the
 * official ElevenLabs connector doesn't forward text-to-speech, so TTS never uses discovery.
 */
export type Provider = "typesafe" | "ollama" | "box" | "agentmail" | "elevenlabs" | "elevenlabs_tts";
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Connector {
  slug: string;
  base: string;
  snippet?: string;
}

export class GatewayError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function friendlyGatewayMessage(provider: string, status: number): string {
  switch (status) {
    case 401:
      return `${provider}: the gateway said 401. Connector calls only work from inside a Sprite (use GATEWAY_MODE=stub elsewhere).`;
    case 403:
      return `${provider}: the gateway said 403. This Sprite isn't allowed by the connector's access policy, or the path is blocked.`;
    case 404:
      return `${provider}: the gateway said 404. The connector may not forward this path; compare it with the usage snippet.`;
    default:
      return `${provider}: the gateway answered HTTP ${status}.`;
  }
}

function slugOf(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const i = parts.indexOf("gateway");
    return i >= 0 && parts[i + 1] ? parts[i + 1].toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * The /gateway/list shape isn't documented, so walk the whole response and collect every
 * object that carries a gateway_base_url, keyed by the slug in that URL.
 */
export function parseGatewayList(data: unknown): Map<string, Connector> {
  const out = new Map<string, Connector>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    if (typeof rec.gateway_base_url === "string") {
      const slug = slugOf(rec.gateway_base_url) || String(rec.provider ?? "").toLowerCase();
      if (slug && !out.has(slug)) {
        out.set(slug, {
          slug,
          base: rec.gateway_base_url.replace(/\/+$/, ""),
          snippet: typeof rec.usage_snippet === "string" ? rec.usage_snippet : undefined,
        });
      }
    }
    Object.values(rec).forEach(walk);
  };
  walk(data);
  return out;
}

export interface GatewayOptions {
  mode: "live" | "stub";
  listUrl: string;
  overrides?: Partial<Record<Provider, string | undefined>>;
  /** Transport for live calls (tests inject a fake). */
  fetchImpl?: Fetch;
  log?: (msg: string) => void;
}

export class Gateway {
  private discovered?: Promise<Map<string, Connector>>;
  private snippetLogged = new Set<string>();
  private readonly fetchImpl: Fetch;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: GatewayOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? ((m) => console.log(m));
  }

  get mode() {
    return this.opts.mode;
  }

  private discover(): Promise<Map<string, Connector>> {
    this.discovered ??= (async () => {
      const res = await this.fetchImpl(this.opts.listUrl);
      if (!res.ok) throw new GatewayError("gateway", res.status, friendlyGatewayMessage("gateway list", res.status));
      return parseGatewayList(await res.json());
    })().catch((err) => {
      this.discovered = undefined; // try again next time
      throw err;
    });
    return this.discovered;
  }

  /** Base URL for a provider: env override, then discovery. Stub mode uses stub://<provider>. */
  async base(provider: Provider): Promise<string> {
    if (this.opts.mode === "stub") return `stub://${provider}`;
    const override = this.opts.overrides?.[provider];
    if (override) return override.replace(/\/+$/, "");
    if (provider === "elevenlabs_tts") {
      throw new GatewayError(provider, 0, "Text to speech needs ELEVENLABS_BASE (the Custom API connector for api.elevenlabs.io).");
    }
    const found = (await this.discover()).get(provider);
    if (!found) {
      throw new GatewayError(provider, 0, `${provider}: no connector found. Add it in the Fly dashboard, or set ${provider.toUpperCase()}_BASE.`);
    }
    if (found.snippet && !this.snippetLogged.has(provider)) {
      this.snippetLogged.add(provider);
      this.log(`[gateway] ${provider} usage snippet:\n${found.snippet.replace(/\/gateway\/([a-z_]+)\/[A-Za-z0-9_-]+/g, "/gateway/$1/<id>")}`);
    }
    return found.base;
  }

  /** A fetch bound to one provider: stubbed in stub mode, never adds credentials in live mode. */
  fetcher(provider: Provider): Fetch {
    if (this.opts.mode === "stub") return (input, init) => stubFetch(provider, input, init);
    return (input, init) => this.fetchImpl(input, init);
  }

  /** gw(provider, path, init): fetch(base + path) and map 401/403 to friendly errors. */
  async gw(provider: Provider, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("authorization"); // the gateway holds the credential
    const res = await this.fetcher(provider)(`${await this.base(provider)}${path}`, { ...init, headers });
    if (res.status === 401 || res.status === 403) {
      throw new GatewayError(provider, res.status, friendlyGatewayMessage(provider, res.status));
    }
    return res;
  }
}
