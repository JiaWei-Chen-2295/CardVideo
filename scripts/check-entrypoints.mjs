// Verify that the entry points Vercel looks for actually resolve to a working Express app.
//
// WHY
// Vercel detects an Express backend by looking for a file matching `app|index|server.{js,mjs,cjs,...}`
// in the repository ROOT or under `src/`. Nothing verifies that by itself: a missing or broken entry
// point produces a deployment that builds cleanly and then 404s on every route, with no build error
// to explain it.
//
// WHY THERE IS ALSO AN api/ ENTRY POINT
// The root `server.js` above turned out NOT to be enough. Measured on the live deployment, the app
// was never invoked at all: `GET /api/health` answered `200 text/html` with the homepage document
// instead of JSON, every unknown path answered the homepage, and `POST` to any `/api/*` path was
// rejected `405` by the static layer. The deployment had gone out as a pure static bundle with the
// whole API unreachable and no build error to say so.
//
// `api/` is the one directory Vercel treats as serverless functions without having to infer a
// framework. So the handler lives there, and `vercel.json` rewrites `/api/:path*` onto it. Because
// it is not documented whether that rewrite preserves or strips the `/api` prefix, `api/index.js`
// normalises both, and this script proves both shapes reach the API.
//
// This checks the detection locations, all three entry points, that they resolve to the SAME
// application rather than independent constructions, and that the rewrite contract holds.
//
// usage: node --env-file=.env scripts/check-entrypoints.mjs

import { existsSync, readFileSync } from "node:fs";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// The platform owns the port; importing must not bind one.
process.env.VERCEL = "1";

console.log("\nentry point check\n");

console.log("locations Vercel detects an Express app in");
const EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"];
const PREFIXES = ["app", "index", "server"];
const DIRECTORIES = [".", "src"];

const found = [];
for (const dir of DIRECTORIES) {
  for (const prefix of PREFIXES) {
    for (const ext of EXTENSIONS) {
      const candidate = dir === "." ? `${prefix}.${ext}` : `${dir}/${prefix}.${ext}`;
      if (existsSync(candidate)) found.push(candidate);
    }
  }
}

if (found.length === 0) {
  check(
    "an entry point exists where Vercel looks",
    false,
    "no app|index|server file in the repository root or src/ -- the deployment would 404 on every route"
  );
} else {
  for (const file of found) check(`found ${file}`, true);
}

console.log("\nthe detected entry point exports a usable app");
let rootApp = null;
if (existsSync("server.js")) {
  try {
    const module = await import("../server.js");
    rootApp = module.default;
    check("server.js imports", true);
    check("server.js exports a function as default", typeof rootApp === "function", typeof rootApp);
    check(
      "the exported app is an Express application",
      typeof rootApp?.use === "function" && typeof rootApp?.get === "function"
    );
  } catch (err) {
    check("server.js imports", false, err.message);
  }
} else {
  check("server.js exists", false, "the root entry point is missing");
}

console.log("\nthe local entry point still works");
let localApp = null;
try {
  const module = await import("../server/index.js");
  localApp = module.default;
  check("server/index.js imports", true);
  check("server/index.js exports the same app instance", localApp === rootApp);
} catch (err) {
  check("server/index.js imports", false, err.message);
}

console.log("\nthe api/ handler Vercel actually runs");
let apiHandler = null;
if (existsSync("api/index.js")) {
  try {
    const module = await import("../api/index.js");
    apiHandler = module.default;
    check("api/index.js imports", true);
    check("api/index.js default-exports a handler function", typeof apiHandler === "function", typeof apiHandler);
  } catch (err) {
    check("api/index.js imports", false, err.message);
  }
} else {
  check(
    "api/index.js exists",
    false,
    "without it the deployment serves the api/ paths as static files and the whole API is unreachable"
  );
}

// The rewrites are what attach paths to the handler and to the share-link document.
// Without them the files are present but nothing routes to them -- and because the
// static layer falls back to public/index.html, the failure looks like "every page
// silently returns the homepage" rather than an error.
try {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const rewrites = config.rewrites ?? [];

  const api = rewrites.find((r) => /^\/api\//.test(r.source));
  check(
    "vercel.json rewrites /api/* onto the handler",
    Boolean(api),
    api ? `${api.source} -> ${api.destination}` : "no rewrite matches /api/"
  );

  // The share link goes through the FUNCTION, not to the static card.html. Rewriting to
  // `/card.html` was tried and silently did nothing: with `cleanUrls: true` that path is a
  // redirect (`308 -> /card`), so the rewrite was not honoured and /c/<id> kept falling
  // back to public/index.html -- answering 200 text/html with the wrong page.
  const share = rewrites.find((r) => /^\/c\//.test(r.source));
  check(
    "vercel.json rewrites /c/* onto the handler",
    Boolean(share),
    share ? `${share.source} -> ${share.destination}` : "no rewrite matches /c/"
  );
  if (share) {
    check(
      "the share-link rewrite avoids .html destinations",
      !share.destination.endsWith(".html"),
      "cleanUrls turns .html destinations into redirects, which makes the rewrite a no-op"
    );
  }
} catch (err) {
  check("vercel.json is readable JSON", false, err.message);
}

// The share link must be served whether the platform forwards the original path or the
// rewrite destination, so the app registers it on both. Assert the routes exist rather
// than trusting that they stay in step.
try {
  const serverJs = readFileSync("server/index.js", "utf8");
  for (const route of ["/c/:id", "/api/c/:id"]) {
    check(
      `server/index.js serves the card page on ${route}`,
      serverJs.includes(`app.get("${route}"`),
      "the share link would 404 for whichever path shape the rewrite forwards"
    );
  }
} catch (err) {
  check("server/index.js is readable", false, err.message);
}

// The client reads the card id straight out of the path, so the rewrite must preserve a
// /c/<id> shaped URL rather than rewriting it to /card.html in the address bar. If that
// ever changes to a redirect, every share link breaks. Assert the parser's contract.
try {
  const cardJs = readFileSync("public/js/card.js", "utf8");
  check(
    "card.js derives the card id from the URL path",
    /location\.pathname/.test(cardJs),
    "if this changes, the /c/ rewrite destination must be revisited"
  );
} catch (err) {
  check("public/js/card.js is readable", false, err.message);
}

// The re-export must not be a second construction: two Express instances would mean two copies of
// every route, and any state they hold (config, adapters) would diverge.
if (rootApp && localApp) {
  check(
    "there is exactly one app instance, not two",
    rootApp === localApp,
    rootApp === localApp ? "" : "server.js and server/index.js produced different objects"
  );
}

console.log("\nrouting works through the detected entry point");
if (rootApp) {
  const { createServer } = await import("node:http");
  const server = createServer(rootApp);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [path, expected] of [
    ["/api/health", 200],
    ["/", 200],
    ["/create", 200],
    ["/ar", 200],
    ["/js/ar/ar-viewer.js", 200],
    ["/vendor/mindar-image-three.prod.js", 200],
    ["/api/cards/000000000000", 404],
  ]) {
    const res = await fetch(base + path);
    check(`GET ${path}`, res.status === expected, `expected ${expected}, got ${res.status}`);
  }

  await new Promise((resolve) => server.close(resolve));
}

// The regression that took the live site down: the handler existed but the API was
// unreachable. Since the rewrite may hand over either URL shape, both are asserted, and
// every one of them must answer JSON -- `text/html` is precisely how the failure looked.
console.log("\nthe api/ handler reaches the API for both rewrite shapes");
if (apiHandler) {
  const { createServer } = await import("node:http");
  const server = createServer(apiHandler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [method, path] of [
    ["GET", "/api/health"],
    ["GET", "/health"],
    ["GET", "/api/cards/000000000000"],
    ["GET", "/cards/000000000000"],
    ["POST", "/api/upload-ticket"],
    ["POST", "/upload-ticket"],
    ["POST", "/api/cards"],
    ["POST", "/cards"],
  ]) {
    const res = await fetch(base + path, {
      method,
      ...(method === "POST"
        ? { headers: { "content-type": "application/json" }, body: "{}" }
        : {}),
    });
    const type = res.headers.get("content-type") ?? "";
    check(
      `${method} ${path} reaches the API`,
      type.includes("application/json"),
      `ct=${type || "(none)"} status=${res.status}`
    );
  }

  // The share link must serve the card document on BOTH path shapes, because whether the
  // rewrite forwards the original path or the destination is not something this project
  // can rely on. Every wrong answer here is still a 200, so compare the document.
  for (const path of ["/c/Pw51V7yKPyyZ", "/api/c/Pw51V7yKPyyZ"]) {
    const res = await fetch(base + path);
    const html = await res.text();
    const type = res.headers.get("content-type") ?? "";
    const isCard = type.includes("text/html") && html.includes("/js/card.js");
    const isHomepage = /<title>\s*CardVideo\s*·/.test(html);
    check(
      `GET ${path} serves the card page`,
      isCard && !isHomepage,
      isHomepage
        ? "this is the homepage -- the share link fell through to public/index.html"
        : `ct=${type || "(none)"} status=${res.status}`
    );
  }

  await new Promise((resolve) => server.close(resolve));
}

console.log(failures === 0 ? "\nEntry points are correct.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
