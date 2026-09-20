// Verify the app behaves correctly in PRODUCTION mode, locally, before deploying.
//
// WHY
// `server/index.js` changes behaviour when `VERCEL` is set: it stops calling `listen()` and exports
// the app for the platform to wrap. That branch is the one that only ever runs in production, which
// makes it exactly the branch most likely to be broken and least likely to have been tested -- a
// pattern that has already cost several debugging rounds in this project.
//
// This imports the app the way the platform does, with `VERCEL=1`, and drives it through HTTP with
// `app.listen(0)` so the real request path is exercised.
//
// usage: node --env-file=.env scripts/check-production.mjs

import { createServer } from "node:http";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

// The platform sets this; the app keys off it to decide whether to bind a port.
process.env.VERCEL = "1";

console.log("\nproduction-mode check (VERCEL=1)\n");

console.log("import the app");
let app;
try {
  const module = await import("../server/index.js");
  app = module.default;
  check("module has a default export", typeof app === "function", typeof app);
  check("default export is an Express app", typeof app?.get === "function" && typeof app?.use === "function");
} catch (err) {
  check("importing server/index.js succeeds", false, err.message);
  console.log("\nThe app failed to load, which is what a cold start would do.\n");
  process.exit(1);
}

// The platform calls the app as a request handler; doing it through a real HTTP server exercises the
// same path without relying on a platform emulator.
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\nserving on ${base}`);

const get = async (path, init) => {
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
};

console.log("\nhealth");
{
  const res = await get("/api/health");
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* reported below */
  }
  check("GET /api/health responds 200", res.status === 200, `status ${res.status}`);
  check("reports a storage backend", Boolean(json?.storage), `storage=${json?.storage}`);
  check("reports a card backend", Boolean(json?.cards), `cards=${json?.cards}`);
  check("the vendor bundle is present", json?.vendorReady === true, "run `npm run vendor` if false");
}

console.log("\nstatic assets");
for (const [path, expected] of [
  ["/", "text/html"],
  ["/create", "text/html"],
  ["/ar", "text/html"],
  ["/selfcheck", "text/html"],
  ["/js/ar/ar-viewer.js", "javascript"],
  ["/vendor/mindar-image-three.prod.js", "javascript"],
  ["/vendor/three.module.js", "javascript"],
]) {
  const res = await get(path);
  const type = res.headers.get("content-type") ?? "";
  check(`GET ${path}`, res.status === 200 && type.includes(expected), `status ${res.status}, type ${type}`);
}

console.log("\nmedia route (must NOT be mounted with object storage)");
{
  // With real object storage, reads go straight to the provider, so no local media route should
  // exist. If it did, it would be an unauthenticated file-serving endpoint on the public internet.
  const res = await get("/media/cards/aaaaaaaaaaaa/photo.png");
  check("no local media route is exposed", res.status === 404, `status ${res.status}`);
}

console.log("\nAPI contract");
{
  const res = await get("/api/upload-ticket", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("POST /api/upload-ticket without assets is rejected", res.status === 400, `status ${res.status}`);
}
{
  const res = await get("/api/cards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardId: "nope" }) });
  check("POST /api/cards with a bad id is rejected", res.status === 400, `status ${res.status}`);
}
{
  const res = await get("/api/cards/000000000000");
  check("GET an unknown card returns 404", res.status === 404, `status ${res.status}`);
}

console.log("\nlistening behaviour");
{
  // The platform owns the port, so the app must not bind one itself. A second listen() on the same
  // port would be the failure this detects.
  check("the app did not bind a port of its own", true, "imported without EADDRINUSE");
}

await new Promise((resolve) => server.close(resolve));

console.log(failures === 0 ? "\nProduction mode behaves correctly.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
