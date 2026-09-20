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
 * WHY PATHS ARE NORMALISED
 * `vercel.json` sends both `/api/:path*` and `/c/:path*` here, and a wildcard rewrite may
 * hand over either the full path or only the matched remainder. The two families are
 * normalised differently on purpose:
 *
 *   /api/...  already the shape `server/index.js` routes on -- left alone.
 *   /c/...    the share link, served by the app's own `/c/:id` route -- left alone.
 *   /...      bare remainder of a wildcard rewrite; treated as an /api path.
 *
 * The app registers the card page on BOTH `/c/:id` and `/api/c/:id` so that the share
 * link survives either forwarding behaviour, rather than depending on a platform routing
 * detail that cannot be reproduced locally.
 *
 * WHAT WAS TRIED FIRST, AND WHY IT FAILED
 * The share link was initially rewritten straight to the static `card.html`:
 *
 *     { "source": "/c/:path*", "destination": "/card.html" }
 *
 * That silently did nothing. This deployment sets `cleanUrls: true`, and under that
 * setting `/card.html` is a redirected path -- asking for it directly returns
 * `308 -> /card`. As a rewrite destination it was not honoured at all, so `/c/<id>` kept
 * falling through to `public/index.html` and answered `200 text/html` with the homepage.
 * The share link never errored; it just showed the wrong page. Routing through the
 * function avoids `cleanUrls` entirely, because the destination is not an HTML path.
 */

import app from "../server/index.js";

/** Map whatever the rewrite handed over onto a path the app actually routes on. */
export function normalizePath(url) {
  if (url.startsWith("/api/") || url === "/api") return url;
  if (url.startsWith("/c/") || url === "/c") return url;
  return `/api${url.startsWith("/") ? "" : "/"}${url}`;
}

export default function handler(req, res) {
  const original = req.url;
  req.url = normalizePath(original);

  // Put the URL back once the response is done, so nothing downstream that inspects the
  // request afterwards sees a value this function invented.
  res.on("finish", () => {
    req.url = original;
    req.originalUrl = original;
  });

  return app(req, res);
}
