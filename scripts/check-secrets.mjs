// Refuse to commit secrets.
//
// WHY THIS IS A SCRIPT AND NOT A CAREFUL READ-THROUGH
// The repository is about to be pushed somewhere, and a leaked credential cannot be un-leaked: it
// has to be rotated. Reading a diff carefully is not a control -- it depends on attention, it does
// not cover files added later, and it produces no artefact. This does: it scans every file Git is
// about to commit, against both structural patterns (a JWT, a private key) and the specific secret
// VALUES this project actually holds, read from the environment.
//
// Matching on real values matters because the most likely leak is not a pattern at all -- it is
// someone pasting a working credential into a document, a test fixture, or a comment.
//
// usage:  node scripts/check-secrets.mjs
// exit:   0 clean, 1 a secret was found, 2 git unavailable

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

let failures = 0;
const report = (file, line, what) => {
  failures++;
  console.log(`  LEAK  ${file}${line ? `:${line}` : ""}  ${what}`);
};

/** Files Git would commit: staged if anything is staged, otherwise everything not ignored. */
function trackedFiles() {
  try {
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    if (staged.length) return { files: staged, source: "staged" };

    const all = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return { files: all, source: "would-be-committed" };
  } catch (err) {
    console.error("git is not usable:", err.message);
    process.exit(2);
  }
}

const { files, source } = trackedFiles();
console.log(`\nsecret scan: ${files.length} file(s) (${source})\n`);

// --------------------------------------------------------- forbidden paths

console.log("forbidden paths");
// These must never be tracked even if their content looks harmless.
const FORBIDDEN = [
  { test: /(^|\/)\.env$/, why: "environment file (holds real cloud credentials)" },
  { test: /(^|\/)\.env\.(local|production|development)$/, why: "environment file" },
  { test: /\.(pem|key|p12|pfx)$/i, why: "private key material" },
  { test: /(^|\/)data\//, why: "runtime data (uploaded media, generated certificate)" },
  { test: /(^|\/)node_modules\//, why: "dependencies" },
  { test: /(^|\/)scratch\//, why: "throwaway experiments" },
];

let forbiddenFound = false;
for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.test.test(file)) {
      report(file, 0, rule.why);
      forbiddenFound = true;
    }
  }
}
if (!forbiddenFound) console.log("  none");

// --------------------------------------------------------- value matching

// Collect the real secrets from the environment so a pasted copy can be found wherever it landed.
const knownSecrets = [];
for (const name of [
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "TURSO_AUTH_TOKEN",
  "TURSO_DATABASE_URL",
]) {
  const value = process.env[name];
  // Short values would match everywhere; only distinctive ones are useful as fingerprints.
  if (value && value.length >= 12) knownSecrets.push({ name, value });
}

// The real secrets are collected from the environment above. Deliberately no hardcoded fragments:
// an earlier version listed a distinctive substring of the database host here, which made this
// file itself the leak -- caught by this very scan, and a good illustration of why the values are
// read from the environment instead of being written down.

// --------------------------------------------------------- content patterns

const PATTERNS = [
  { what: "JSON Web Token", re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { what: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: "AWS-style access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { what: "hardcoded assignment of a long secret", re: /(SECRET|TOKEN|PASSWORD|APIKEY|API_KEY)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{20,}["']/i },
];

console.log("\nfile contents");
let contentIssues = false;
let scanned = 0;

for (const file of files) {
  if (!existsSync(file)) continue;

  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // Binary or unreadable; nothing meaningful to scan.
    continue;
  }
  scanned++;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const secret of knownSecrets) {
      if (line.includes(secret.value)) {
        report(file, i + 1, `contains the value of ${secret.name}`);
        contentIssues = true;
      }
    }
    for (const pattern of PATTERNS) {
      if (pattern.re.test(line)) {
        report(file, i + 1, `looks like a ${pattern.what}`);
        contentIssues = true;
      }
    }
  }
}
console.log(`  scanned ${scanned} text file(s)`);
if (!contentIssues) console.log("  no secret values or credential patterns found");

// --------------------------------------------------------- template sanity

console.log("\n.env.example must stay a template");
if (files.includes(".env.example")) {
  const template = await readFile(".env.example", "utf8");
  const filled = template
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+\s*=\s*\S+/.test(line))
    .map((line) => line.split("=")[0]);

  if (filled.length) {
    report(".env.example", 0, `has non-empty values for: ${filled.join(", ")}`);
  } else {
    console.log("  every value is empty, as a template requires");
  }
} else {
  console.log("  .env.example is not being committed -- that is a mistake, it is the setup guide");
  failures++;
}

console.log(
  failures === 0
    ? `\nNo secrets in ${files.length} file(s). Safe to commit.\n`
    : `\n${failures} problem(s) found. DO NOT COMMIT until they are resolved.\n`
);
process.exitCode = failures === 0 ? 0 : 1;
