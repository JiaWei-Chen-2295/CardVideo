// Verify that the entry points Vercel looks for actually resolve to a working Express app.
//
// WHY
// Vercel detects an Express backend by looking for a file matching `app|index|server.{js,mjs,cjs,...}`
// in the repository ROOT or under `src/`. Nothing verifies that by itself: a missing or broken entry
// point produces a deployment that builds cleanly and then 404s on every route, with no build error
// to explain it.
//
// This checks both the detection locations and the two entry points this project ships
// (`server.js` at the root for the platform, `server/index.js` for local runs), and confirms both
// export the SAME application rather than two independent constructions.
//
// usage: node --env-file=.env scripts/check-entrypoints.mjs

import { existsSync } from "node:fs";

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

console.log(failures === 0 ? "\nEntry points are correct.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
