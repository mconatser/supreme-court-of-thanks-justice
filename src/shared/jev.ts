/**
 * TypeSafe Jev client: the official SDK pointed at the Sprites gateway with a placeholder key
 * (per the connector's usage_snippet). Confirmed live on 2026-11-23 against jev-1.14.0.
 *
 * The connector forwards only POST /v1/systemone and GET /v1/models.
 */
import {
  APIError,
  APIConnectionError,
  TypeSafeClient,
  type EntryType,
  type Questions,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import type { Budget } from "./budget.ts";
import { friendlyGatewayMessage, GatewayError, type Gateway } from "./gateway.ts";

export type { Questions, SystemOneResult };
export { choice, noul, score } from "@typesafe-ai/sdk";

export interface Jev {
  ask<Q extends Questions>(state: object | string, questions: Q): Promise<SystemOneResult<Q>>;
}

export function createJev(opts: { gateway: Gateway; budget: Budget; model: string; log?: (m: string) => void }): Jev {
  const log = opts.log ?? ((m) => console.log(m));
  let client: TypeSafeClient | undefined;
  let loggedModel = false;

  const getClient = async () => {
    client ??= new TypeSafeClient({
      baseURL: await opts.gateway.base("typesafe"),
      apiKey: "sprites", // placeholder; the gateway attaches the real key
      defaultModel: opts.model,
      fetch: opts.gateway.fetcher("typesafe"),
      // Retries would silently multiply spend; one retry for blips, counted as one logical call.
      retry: { maxRetries: 1 },
      timeout: 45_000,
      compression: false,
      logLevel: "off",
    });
    return client;
  };

  return {
    async ask(state, questions) {
      opts.budget.spend("jev", 1);
      const c = await getClient();
      try {
        const res = await c.systemOne({ state: state as NonNullable<EntryType>, questions });
        if (!loggedModel) {
          loggedModel = true;
          log(`[jev] model in use: ${res.model}${opts.model === "jev-latest" ? " (pin JEV_MODEL to this once thresholds feel right)" : ""}`);
        }
        return res;
      } catch (err) {
        if (err instanceof APIError && typeof err.status === "number") {
          throw new GatewayError("typesafe", err.status, friendlyGatewayMessage("TypeSafe", err.status));
        }
        if (err instanceof APIConnectionError) {
          throw new GatewayError("typesafe", 0, "TypeSafe: couldn't reach the gateway.");
        }
        throw err;
      }
    },
  };
}
