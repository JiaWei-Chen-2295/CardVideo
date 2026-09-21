// Static verification of the frontend module graph.
//
// Why this exists: the browser-side code cannot be exercised end to end here (that needs a
// phone and a camera), and the majority of real breakages in a no-build frontend are
// mechanical. Every one of these has actually happened in this repo:
//
//   1. a module that does not PARSE -- blanks the page with no server-side error at all;
//   2. an import specifier that does not RESOLVE -- a bare specifier missing from the import
//      map, or a relative path pointing at a file nobody created. Vendored third-party files
//      are the worst offenders: mind-ar's `extract.js` ships `../utils/cumsum.js`, which in a
//      flattened vendor layout points at nothing, and the browser refuses the whole module;
//   3. a relative specifier that ESCAPES public/ entirely -- always a broken vendor rewrite;
//   4. an asset that 404s or is served with the wrong Content-Type (browsers refuse to
//      execute a module served as text/html);
//   5. an import map that the pages disagree about.
//
// The traversal is RECURSIVE and rooted at each page, because a file being present proves
// nothing about whether its own imports can be fetched. An earlier version of this script
// resolved relative imports against the importer's directory for every file it scanned,
// which silently missed exactly the kind of bug in (2).

import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");

/**
 * Base URL of the server under test.
 *
 * The explicit argument wins; otherwise the two documented ways of running the dev server are
 * tried in order. Hard-coding `http://localhost:3000` meant `npm run check` reported every asset
 * as unreachable whenever the server was started with `npm run dev:https` -- which is the normal
 * way to run it for phone testing, so the mismatch was hit constantly.
 */
async function resolveBase() {
  if (process.argv[2]) return process.argv[2].replace(/\/+$/, "");

  // HTTPS FIRST, then HTTP.
  //
  // Probing HTTP first against a TLS server reported success here (the connection closes without
  // a body, and Node's fetch does not always treat that as an error), so the check proceeded with
  // a plaintext base URL and every single asset "failed to fetch" against a perfectly healthy
  // server. Starting with HTTPS avoids depending on how a protocol mismatch happens to surface.
  for (const candidate of ["https://localhost:3000", "http://localhost:3000"]) {
    const isTls = candidate.startsWith("https://");
    if (isTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    try {
      const res = await fetch(`${candidate}/api/health`);
      // A real answer must also be the right shape; a TLS server on a plaintext port does not
      // return parseable health JSON.
      if (res.ok && (await res.json())?.ok === true) return candidate;
    } catch {
      /* try the next candidate */
    }

    if (isTls) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  return "http://localhost:3000";
}

const base = await resolveBase();
console.log(`[check-frontend] target ${base}`);

// The HTTPS dev server uses a self-signed certificate, which Node's fetch rejects by default.
// Verification is disabled ONLY for a loopback or private-network target in a development check --
// never for a remote host.
if (base.startsWith("https://") && /^https:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(base)) {
  console.warn(`[warn] ${base} uses a self-signed certificate; disabling TLS verification for this run only`);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

if (typeof vm.SourceTextModule !== "function") {
  console.error(
    "\nThis check needs Node's ESM parser, which requires an experimental flag.\n" +
      "Run it through npm so the flag is applied:\n\n" +
      "  npm run check:frontend\n\n" +
      "or directly:\n\n" +
      "  node --experimental-vm-modules scripts/check-frontend.mjs\n"
  );
  process.exit(2);
}

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const toPosix = (p) => p.split("\\").join("/");

// ------------------------------------------------------------------ import maps

function parseImportMap(html) {
  const match = /<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  return JSON.parse(match[1]).imports ?? {};
}

/**
 * Resolve an import specifier the way a browser would, given an import map and the URL of
 * the module doing the importing.
 *
 * @returns {{kind: "root", url: string} | {kind: "unresolved"} | {kind: "external"}}
 */
function resolveSpecifier(specifier, importerUrl, importMap) {
  if (/^[a-z]+:/i.test(specifier)) return { kind: "external" };

  if (specifier.startsWith("/")) return { kind: "root", url: specifier };

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return { kind: "root", url: new URL(specifier, `http://x${importerUrl}`).pathname };
  }

  if (Object.hasOwn(importMap, specifier)) {
    const target = importMap[specifier];
    return target.startsWith("/") ? { kind: "root", url: target } : { kind: "unresolved" };
  }

  // Prefix mappings ("three/addons/") match by longest prefix.
  const prefixes = Object.entries(importMap)
    .filter(([key]) => key.endsWith("/") && specifier.startsWith(key))
    .sort((a, b) => b[0].length - a[0].length);
  if (prefixes.length) {
    return { kind: "root", url: prefixes[0][1] + specifier.slice(prefixes[0][0].length) };
  }

  return { kind: "unresolved" };
}

/** All static, dynamic and importScripts() specifiers in a source file. */
function collectSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = new Set();
  for (const m of code.matchAll(/\bimport\s*(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)) {
    specifiers.add(m[1]);
  }
  for (const m of code.matchAll(/\bexport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)) {
    specifiers.add(m[1]);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(m[1]);
  }
  // Template-literal form, e.g. import(`/js/ar/ar-viewer.js?v=${Date.now()}`). Missing these
  // silently dropped whole subtrees out of the graph, so the cache-busting imports this project
  // relies on were never validated.
  for (const m of code.matchAll(/\bimport\s*\(\s*`([^`$]*)`\s*\)/g)) {
    if (m[1]) specifiers.add(m[1]);
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*`([^`$]*)\$\{/g)) {
    specifiers.add(m[1]);
  }
  for (const m of code.matchAll(/\bimportScripts\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(m[1]);
  }
  return [...specifiers];
}

/**
 * Remove comments before scanning for imports.
 *
 * Without this, prose mentions of an import inside a comment are read as real imports --
 * which is exactly how a doc comment about `import("mindar-image-compile")` produced a
 * bogus failure about workers and import maps.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Import specifiers mentioned in the code, ignoring comments. Used to decide whether a page
 * actually needs an import map: a page whose scripts use no bare specifiers legitimately
 * does not need one.
 */
const bareSpecifiersIn = (source) =>
  collectSpecifiers(source).filter(
    (s) => !s.startsWith("/") && !s.startsWith("./") && !s.startsWith("../") && !/^[a-z]+:/i.test(s)
  );

/** root-relative URL -> disk path under public/, rejecting anything that escapes it. */
function toDiskPath(urlPath) {
  const cleaned = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const full = resolve(publicDir, "." + cleaned);
  const rel = relative(publicDir, full);
  if (rel.startsWith("..") || resolve(publicDir, rel) !== full) return null;
  return full;
}

// ============================================================ 1. parse every module

console.log("\n1. every frontend module parses");

const allFiles = [];
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.(js|mjs)$/.test(entry.name)) allFiles.push(full);
  }
};
await walk(join(publicDir, "js"));
// vendor/ is third-party, but a syntax error there kills the page just the same, so it is
// parsed too (link-checked separately in check-three-compat.mjs).
await walk(join(publicDir, "vendor"));

for (const file of allFiles) {
  const source = await readFile(file, "utf8");
  const label = toPosix(relative(root, file));
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(source, { identifier: label });
    check(label, true);
  } catch (err) {
    check(label, false, err.message);
  }
}

// Inline module scripts live in HTML, not in .js files, so walking public/js and public/vendor
// never touches them. debug.html is almost entirely inline, which would otherwise leave the
// most diagnostic-heavy page in the project completely unverified.
for (const page of (await readdir(publicDir)).filter((n) => n.endsWith(".html"))) {
  const html = await readFile(join(publicDir, page), "utf8");
  const inline = [...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/gi)];
  for (let i = 0; i < inline.length; i++) {
    const label = `${page} inline module #${i + 1}`;
    try {
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(inline[i][1], { identifier: label });
      check(label, true);
    } catch (err) {
      check(label, false, err.message);
    }
  }
}

// ================================================ 2. resolve the graph from each page

console.log("\n2. the module graph resolves from every page");

const pages = (await readdir(publicDir)).filter((n) => n.endsWith(".html"));
let referenceMap = null;

for (const page of pages) {
  const pagePath = join(publicDir, page);
  const html = await readFile(pagePath, "utf8");
  const importMap = parseImportMap(html);

  // A page needs an import map only if its scripts use bare specifiers. Requiring one
  // everywhere would be noise; silently allowing a missing one on a page that DOES use bare
  // specifiers is a real bug, because that page would die with an unresolved specifier.
  const scriptSources = [
    ...[...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]),
  ];
  const needsImportMap = scriptSources.some((s) => bareSpecifiersIn(s).length > 0) ||
    // Any module reachable from this page may import a bare specifier, and pages share
    // modules, so treat the known shared entry points as requiring one too.
    /\/js\/(viewer|create|selfcheck)\.js/.test(html);

  if (!importMap) {
    check(
      `${page} ${needsImportMap ? "declares an import map" : "needs no import map"}`,
      !needsImportMap,
      needsImportMap ? "no <script type=importmap>" : "no bare specifiers used"
    );
    if (needsImportMap) continue;
  } else {
    for (const required of ["three", "three/addons/", "mindar-image-three", "mindar-image-compile"]) {
      check(`${page} maps "${required}"`, typeof importMap[required] === "string", importMap[required]);
    }

    // All pages that declare one must agree, or a shared module behaves differently per page.
    const canonical = JSON.stringify(importMap);
    if (referenceMap === null) referenceMap = canonical;
    check(`${page} import map matches the others`, canonical === referenceMap);
  }

  const effectiveMap = importMap ?? {};

  const pageUrl = `/${page}`;
  const visited = new Set();
  // Missing modules are reported per (importer, specifier) so the message names the culprit
  // rather than the page.
  const broken = [];

  const visit = async (url, importerLabel) => {
    if (visited.has(url)) return;
    visited.add(url);

    const disk = toDiskPath(url);
    if (!disk) {
      broken.push(`${importerLabel} -> "${url}" escapes public/`);
      return;
    }
    if (!(await exists(disk))) {
      broken.push(`${importerLabel} -> "${url}" does not exist`);
      return;
    }
    if (!/\.(js|mjs)$/.test(disk)) return;

    const source = await readFile(disk, "utf8");
    for (const specifier of collectSpecifiers(source)) {
      const resolved = resolveSpecifier(specifier, url, effectiveMap);
      if (resolved.kind === "unresolved") {
        broken.push(`${toPosix(relative(root, disk))} -> "${specifier}" is not in the import map`);
        continue;
      }
      if (resolved.kind === "external") continue;
      // Recurse: a file existing says nothing about whether ITS imports resolve.
      await visit(resolved.url, toPosix(relative(root, disk)));
    }
  };

  // Entry points: inline module scripts, plus <script src> for classic/worker scripts.
  for (const [, source] of html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/gi)) {
    for (const specifier of collectSpecifiers(source)) {
      const resolved = resolveSpecifier(specifier, pageUrl, effectiveMap);
      if (resolved.kind === "unresolved") {
        broken.push(`${page} inline -> "${specifier}" is not in the import map`);
        continue;
      }
      if (resolved.kind === "root") await visit(resolved.url, `${page} inline`);
    }
  }
  for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)) {
    const resolved = resolveSpecifier(src, pageUrl, effectiveMap);
    if (resolved.kind === "unresolved") {
      broken.push(`${page} <script src> -> "${src}" is not in the import map`);
      continue;
    }
    if (resolved.kind === "root") await visit(resolved.url, page);
  }

  check(
    `${page}: ${visited.size} module(s) in the graph all resolve`,
    broken.length === 0,
    broken.length ? broken.join("; ") : ""
  );
}

// =============================== 2b. named imports match the target's named exports

console.log("\n2b. named imports exist on their target modules");

/**
 * Collect the exported binding names of a module.
 *
 * Catches the class of bug where a module gains a new function but a caller's destructuring
 * import is not updated -- the browser reports it as a bare `X is not defined` at the moment
 * the code path runs, which in a diagnostic page looks like the thing under test failed.
 * Handles `export const/let/var/function/class`, `export { a, b as c }` and `export * from`.
 */
function exportedNames(source) {
  const code = stripComments(source);
  const names = new Set();
  let hasStarExport = false;

  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export { a, b as c }  -- note `as` renames, and the EXPORTED name is the one after `as`.
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  if (/\bexport\s*\*\s*from\b/.test(code)) hasStarExport = true;

  return { names, hasStarExport };
}

/** Names imported with braces from a specifier, with renames resolved to the SOURCE name. */
function namedImports(source) {
  const code = stripComments(source);
  const out = [];

  // import { a, b as c } from "..."
  for (const m of code.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const name of splitNames(m[1])) out.push({ name, specifier: m[2] });
  }

  // const { a, b } = await import("...")   -- the dynamic form, which this project uses for
  // lazy loading (the compile worker, the diagnostic page). Missing a name here fails at the
  // moment the code path runs, not at load, which makes it look like the feature under test
  // is broken rather than the import.
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\s*\(\s*[`"']([^`"'$]+)/g
  )) {
    for (const name of splitNames(m[1])) out.push({ name, specifier: m[2] });
  }

  return out;
}

/** Split an import/export brace list into SOURCE names, resolving `a as b` to `a`. */
function splitNames(list) {
  const names = [];
  for (const part of list.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const source = piece.split(/\s+as\s+/)[0].trim();
    if (source) names.push(source);
  }
  return names;
}

// The inline module scripts on HTML pages are scanned too: debug.html holds all of its logic
// there, and an import name that does not exist on its target is exactly the failure that
// hides inside a try/catch and looks like the tested feature broke.
const inlineModules = [];
for (const page of (await readdir(publicDir)).filter((n) => n.endsWith(".html"))) {
  const html = await readFile(join(publicDir, page), "utf8");
  for (const [i, m] of [...html.matchAll(/<script\s+type="module"\s*>([\s\S]*?)<\/script>/gi)].entries()) {
    inlineModules.push({ label: `${page} inline module #${i + 1}`, source: m[1], url: `/${page}` });
  }
}

let exportFailures = 0;
for (const unit of [
  ...allFiles.map((file) => ({
    label: toPosix(relative(root, file)),
    importerPath: "/" + toPosix(relative(publicDir, file)),
    source: null,
    files: file,
  })),
  ...inlineModules.map((m) => ({ label: m.label, importerPath: m.url, source: m.source, files: null })),
]) {
  const source = unit.source ?? (await readFile(unit.files, "utf8"));
  const importMap = referenceMap ? JSON.parse(referenceMap) : {};

  for (const { name, specifier } of namedImports(source)) {
    const resolved = resolveSpecifier(specifier, unit.importerPath, importMap);
    if (resolved.kind !== "root") continue; // external or unresolved: handled elsewhere

    const disk = toDiskPath(resolved.url);
    if (!disk || !(await exists(disk)) || !/\.(js|mjs)$/.test(disk)) continue;

    const target = exportedNames(await readFile(disk, "utf8"));
    if (target.hasStarExport) continue; // re-exports: cannot decide statically
    if (target.names.has(name)) continue;

    exportFailures++;
    check(
      `${unit.label} imports "${name}" from ${specifier}`,
      false,
      target.names.size ? `not exported (target exports: ${[...target.names].join(", ")})` : "target exports nothing"
    );
  }
}
if (exportFailures === 0) console.log("  PASS  every named import exists on its target");
failures += exportFailures;

// ============================================== 3. worker scripts are reachable by URL

console.log("\n3. worker scripts resolve to a real file");

// Compile workers cannot be discovered from HTML -- they are constructed in JS. Landing on a
// wrong path here is invisible until a user clicks the button, so check it explicitly.
{
  const source = await readFile(join(publicDir, "js/ar/mind-compile.js"), "utf8");
  const code = stripComments(source);

  // Accept either an inline literal or a named constant, since both are idiomatic. Resolve
  // the constant when used so the target is still verified.
  let workerPath = /new Worker\(\s*["']([^"']+)["']/.exec(code)?.[1] ?? null;
  if (!workerPath) {
    const constant = /new Worker\(\s*([A-Za-z_$][\w$]*)/.exec(code)?.[1];
    if (constant) {
      const decl = new RegExp(`(?:const|let|var)\\s+${constant}\\s*=\\s*["']([^"']+)["']`).exec(code);
      workerPath = decl?.[1] ?? null;
    }
  }
  check("mind-compile.js names a worker script", Boolean(workerPath), workerPath ?? "not found");
  if (workerPath) {
    const workerDisk = toDiskPath(workerPath);
    check("that worker script exists", workerDisk !== null && (await exists(workerDisk)), workerPath);
  }

  // The bare specifier must be resolved on the main thread, where import maps are reliable,
  // and handed to the worker -- so a bare import() inside the worker is a regression.
  const workerSource = await readFile(join(publicDir, "js/ar/mind-compile.worker.js"), "utf8");
  const workerBare = bareSpecifiersIn(workerSource);
  check(
    "the worker uses no bare specifiers (worker import-map support is uneven)",
    workerBare.length === 0,
    workerBare.join(", ")
  );
}

// ============================================================ 4. served over HTTP

console.log("\n4. assets serve correctly over HTTP");

const served = [
  ["/", "text/html"],
  ["/create", "text/html"],
  ["/selfcheck", "text/html"],
  ["/debug.html", "text/html"],
  ["/ar", "text/html"],
  ["/material.html", "text/html"],
  ["/favicon.svg", "image/svg"],
  ["/css/base.css", "text/css"],
  ["/css/ar.css", "text/css"],
  ["/css/material.css", "text/css"],
  ["/frames/viewfinder.webp", "image/webp"],
  ["/js/viewer.js", "javascript"],
  ["/js/create.js", "javascript"],
  ["/js/material.js", "javascript"],
  ["/js/selfcheck.js", "javascript"],
  ["/js/ar/ar-viewer.js", "javascript"],
  ["/js/ar/video-screen.js", "javascript"],
  ["/js/ar/precheck.js", "javascript"],
  ["/js/ar/mind-compile.js", "javascript"],
  ["/js/ar/mind-compile.worker.js", "javascript"],
  ["/js/ar/mp4-meta.js", "javascript"],
  ["/vendor/three.shim.js", "javascript"],
  ["/vendor/three.module.js", "javascript"],
  ["/vendor/mindar-image-three.prod.js", "javascript"],
  ["/vendor/mindar-image-compile.js", "javascript"],
  ["/vendor/mindar-extract/extract.js", "javascript"],
  ["/vendor/mindar-extract/cumsum.js", "javascript"],
  ["/vendor/controller-mGt1s8dJ.js", "javascript"],
  ["/vendor/ui-fBadYuor.js", "javascript"],
  ["/vendor/three-addons/renderers/CSS3DRenderer.js", "javascript"],
  ["/data/fixtures/test-target.png", null], // expected 404: data/ is not public
];

for (const [path, expectType] of served) {
  let res;
  try {
    res = await fetch(base + path);
  } catch (err) {
    check(`GET ${path}`, false, `server unreachable: ${err.message}`);
    continue;
  }

  if (expectType === null) {
    check(`GET ${path} is NOT public`, res.status === 404, `status ${res.status}`);
    continue;
  }

  const contentType = res.headers.get("content-type") ?? "";
  check(
    `GET ${path}`,
    res.ok && contentType.includes(expectType),
    `status ${res.status}, content-type ${contentType}`
  );
}

console.log("\n5. module responses are executable, not error pages");
{
  const res = await fetch(`${base}/js/viewer.js`);
  const body = await res.text();
  check(
    "modules are not served as HTML (browsers refuse to execute those)",
    !body.trimStart().startsWith("<"),
    body.slice(0, 40).replace(/\n/g, " ")
  );
}

console.log(failures === 0 ? "\nAll frontend checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
