// Verify that mind-ar 1.2.5 and the installed three.js actually fit together.
//
// WHY THIS MATTERS MORE THAN IT LOOKS
// mind-ar 1.2.5 predates three.js r165 and imports names modern three.js removed
// (`sRGBEncoding`). The frontend has no build step and resolves "three" through an import
// map, so a missing export is not a build error -- it is a runtime SyntaxError that blanks
// the AR page with nothing useful in the console.
//
// HOW IT VERIFIES (and why it is written this way)
// Naive approaches all lie:
//   - pattern-matching the `export { ... }` text of three.module.js produced false
//     failures, because three.js re-exports across three.core.js;
//   - plainly importing mind-ar's bundle in Node resolves the bare specifier "three" to
//     node_modules/three -- a DIFFERENT module than the browser's shim -- and reports
//     failures the browser would never hit.
//
// So this script does two honest things:
//   1. reads the exported names off the REAL shim module, by importing it;
//   2. LINKS mind-ar's bundle against that shim using vm.SourceTextModule, which validates
//      syntax and every import binding without executing the code. Not executing matters:
//      the bundle embeds a UMD build of tfjs that probes for CommonJS `require`, and
//      actually running it in Node is neither necessary nor representative.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(root, "public", "vendor");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

if (typeof vm.SourceTextModule !== "function") {
  console.error(
    "\nThis check needs Node's ESM linker, which requires an experimental flag.\n" +
      "Run it through npm so the flag is applied:\n\n" +
      "  npm run check:three\n"
  );
  process.exit(2);
}

// ------------------------------------------- 1. which names does mind-ar import?

console.log('\n1. names mind-ar imports from "three"');

const distSource = await readFile(join(vendorDir, "mindar-image-three.prod.js"), "utf8");

const wanted = new Set();
for (const match of distSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']three["']/g)) {
  for (const raw of match[1].split(",")) {
    const name = raw.trim().split(/\s+as\s+/)[0].trim();
    if (name) wanted.add(name);
  }
}
check("found mind-ar's three imports", wanted.size > 0, `${wanted.size} symbol(s)`);

// ------------------------- 2. does the shim (the browser's "three") provide them all?

console.log("\n2. the compat shim provides every one of them");

const shim = await import(pathToFileURL(join(vendorDir, "three.shim.js")).href);
check("three.shim.js imports", true, `three r${shim.REVISION ?? "?"}`);

const absent = [...wanted].filter((name) => !(name in shim)).sort();
for (const name of [...wanted].sort()) {
  console.log(`         ${name in shim ? "ok     " : "MISSING"} ${name}`);
}
check(
  "every imported symbol resolves through the shim",
  absent.length === 0,
  absent.length ? `missing: ${absent.join(", ")}` : "none missing"
);

// ------------------------------- 3. is the legacy compatibility still needed at all?

console.log("\n3. is the legacy compatibility layer still needed?");

const realThree = await import(pathToFileURL(join(vendorDir, "three.module.js")).href);
for (const name of ["sRGBEncoding", "LinearEncoding"]) {
  if (name in realThree) {
    console.warn(
      `  NOTE  three.js exports ${name} again; the placeholder in three.shim.js is now ` +
        `redundant and should be deleted.`
    );
  } else {
    console.log(`  ok    ${name} is still absent from three.js, provided by the shim`);
  }
}

// ------------------- 4. do mind-ar's bundles parse and link against that same shim?

console.log("\n4. mind-ar bundles parse and link against the shim");

/**
 * Link a file as an ES module, resolving specifiers the way the page's import map does.
 * Linking runs the full grammar check AND verifies every named import exists on the target
 * module; nothing is executed.
 *
 * Handles the three specifier shapes the browser handles:
 *   - bare specifiers present in `importMap` (a Module to link against, or a file path);
 *   - prefix mappings such as "three/addons/" -> "/vendor/three-addons/";
 *   - relative and root-relative paths inside public/, linked recursively so their own
 *     syntax is validated too.
 */
async function linkModule(filePath, importMap) {
  const cache = new Map();

  /**
   * Turn an HTTP-style path into a disk path under public/.
   *
   * `new URL(...).pathname` yields "/D:/a_project/.../file.js" on Windows, so a naive
   * join() against public/ produces a doubled-up nonsense path. Detect the drive letter and
   * treat such paths as already absolute.
   */
  const toDiskPath = (urlPath) => {
    if (/^\/[A-Za-z]:[\\/]/.test(urlPath)) return urlPath.slice(1); // already a disk path
    return join(root, "public", urlPath.replace(/^\/+/, ""));
  };

  const linker = async (specifier, referencing) => {
    // Exact mapping: either a Module to link against, or a file path.
    if (Object.hasOwn(importMap, specifier)) {
      const target = importMap[specifier];
      if (target instanceof vm.Module) return target;
      return load(toDiskPath(target));
    }

    // Prefix mapping, longest match first, as the import map spec requires.
    const prefixes = Object.entries(importMap)
      .filter(([key]) => key.endsWith("/") && specifier.startsWith(key))
      .sort((a, b) => b[0].length - a[0].length);
    if (prefixes.length) {
      return load(toDiskPath(prefixes[0][1] + specifier.slice(prefixes[0][0].length)));
    }

    if (specifier.startsWith("/")) return load(toDiskPath(specifier));

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const resolved = new URL(specifier, pathToFileURL(referencing.identifier)).pathname;
      return load(toDiskPath(resolved));
    }

    throw new Error(`unmapped bare specifier "${specifier}"`);
  };

  const load = async (path) => {
    if (cache.has(path)) return cache.get(path);

    const source = await readFile(path, "utf8");
    const module = new vm.SourceTextModule(source, { identifier: path });
    cache.set(path, module);
    await module.link(linker);
    return module;
  };

  return load(filePath);
}

/**
 * Wrap an imported namespace object in a real Module, because the linker refuses anything
 * that is not a Module instance. This is how the browser's "three" (the shim) is injected
 * as the resolution of the bare specifier "three".
 */
function moduleFromNamespace(namespace) {
  const exportNames = Object.keys(namespace).filter((key) => key !== "default");
  return new vm.SyntheticModule(
    exportNames,
    function initialize() {
      for (const name of exportNames) this.setExport(name, namespace[name]);
    },
    { identifier: "three-shim" }
  );
}

// Reproduce the pages' import map exactly, so Node and the browser resolve identically.
// Drift between this and the HTML is caught by check-frontend.mjs.
const importMap = {
  three: moduleFromNamespace(shim),
  "three/addons/": "/vendor/three-addons/",
};

for (const bundle of ["mindar-image-three.prod.js", "mindar-image-compile.js"]) {
  try {
    await linkModule(join(vendorDir, bundle), importMap);
    check(`${bundle} parses and links against the shim`, true);
  } catch (err) {
    check(`${bundle} parses and links against the shim`, false, err.message);
  }
}

// The shim itself must parse and link, since the browser resolves every "three" import to it.
try {
  const shimModule = await linkModule(join(vendorDir, "three.shim.js"), {});
  check("three.shim.js parses and links", true, `status ${shimModule.status}`);
} catch (err) {
  check("three.shim.js parses and links", false, err.message);
}

console.log(failures === 0 ? "\nAll dependency checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
