/**
 * Caching: after a deploy, every open browser must get the new pages, scripts and styles. Without a
 * Cache-Control header, browsers cache static files by heuristic and can keep running an old
 * case.js across reloads and navigations. So every response that doesn't set its own policy (the
 * verdict audio and the SSE streams do) is "no-cache": the browser asks each time. Static files get
 * an ETag, so an unchanged file costs a 304, not a download.
 */
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono, MiddlewareHandler } from "hono";
import { etag } from "hono/etag";

export const noStaleCache: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has("cache-control")) c.res.headers.set("Cache-Control", "no-cache");
};

/** /css, /js and /sfx from the public folder, revalidated on every load. */
export function serveAssets(app: Hono, root: string) {
  for (const dir of ["css", "js", "sfx"]) app.use(`/${dir}/*`, noStaleCache, etag(), serveStatic({ root }));
}
