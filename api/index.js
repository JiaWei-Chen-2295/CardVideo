/**
 * Vercel serverless entry point.
 *
 * WHY THIS FILE EXISTS AT ALL, given `server.js` in the repository root re-exports the
 * same app: on this deployment Vercel did NOT package the root entry point, and the site
 * went live as a pure static bundle. The evidence was unambiguous -- `GET /api/health`
 * returned `200 text/html` with the homepage document instead of JSON, every unknown path
 * returned the homepage, and `POST` to any `/api/*` path was answered `405` by the static
 * layer. The Express app never ran. `api/` is the one directory Vercel treats as
 * serverless functions without having to guess a framework, so the handler lives here.
 *
 * `vercel.json` rewrites `/api/(.*)` to `/api`, which means this function may be invoked
 * with either the full path (`/api/health`) or the prefix already stripped (`/health`),
 * depending on how the rewrite is applied. Normalising here means `server/index.js` only
 * ever has to know about the `/api`-prefixed form it already uses locally.
 */

import app from "../server/index.js";

export default function handler(req, res) {
  const original = req.url;
  if (!original.startsWith("/api")) {
    req.url = `/api${original.startsWith("/") ? "" : "/"}${original}`;
  }

  // Put the URL back once the response is done, so nothing downstream that inspects the
  // request afterwards sees a value this function invented.
  res.on("finish", () => {
    req.url = original;
    req.originalUrl = original;
  });

  return app(req, res);
}
