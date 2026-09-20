// Verify the Turso backend against a REAL database.
//
// WHY THIS SCRIPT EXISTS
// The JSON store and the Turso store are different code. Everything checked locally exercises the
// JSON store; the Turso path only runs in production, which is exactly where a mistake is most
// expensive. This runs the same create/get/delete sequence the API performs, against whatever
// `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are configured, and reports what the database says.
//
// It is deliberately independent of the HTTP server: if this fails, the problem is the database
// connection or the schema, not the API layer.
//
// usage:  TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/check-turso.mjs
//    or:  node --env-file=.env scripts/check-turso.mjs

import { newCardId, newOwnerToken } from "../server/lib/config.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error(
    "\nTURSO_DATABASE_URL is not set.\n\n" +
      "Run with the values in your environment, or point it at a file:\n" +
      "  node --env-file=.env scripts/check-turso.mjs\n\n" +
      "Get them from:\n" +
      "  turso db show <name> --url\n" +
      "  turso db tokens create <name>\n"
  );
  process.exit(2);
}
if (!authToken) {
  console.error("\nTURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is missing.\n");
  process.exit(2);
}

// Never print the token; showing the host is enough to confirm WHICH database this hits.
console.log(`\nTurso check`);
console.log(`  url     ${url}`);
console.log(`  token   ${authToken.slice(0, 8)}... (${authToken.length} chars)`);

console.log("\nconnect");
let store;
try {
  const { createCardStore } = await import("../server/lib/cardStore.js");
  store = await createCardStore({ dataDir: "./data" });
  check("connected and schema created", store.kind === "turso", `store kind = ${store.kind}`);
} catch (err) {
  check("connected and schema created", false, err.message);
  console.log(
    "\nHints: an auth error usually means the token is for a different database or was revoked;\n" +
      "a DNS error usually means the URL should start with libsql:// or https://.\n"
  );
  process.exit(1);
}

// ------------------------------------------------------------------ round trip

const card = {
  id: newCardId(),
  ownerToken: newOwnerToken(),
  title: "turso connectivity check",
  createdAt: Date.now(),
  photoKey: `cards/PLACEHOLDER/photo.png`,
  videoKey: `cards/PLACEHOLDER/video.mp4`,
  mindKey: `cards/PLACEHOLDER/mind.mind`,
  videoAspect: 16 / 9,
  trackingPoints: 42,
};
card.photoKey = `cards/${card.id}/photo.png`;
card.videoKey = `cards/${card.id}/video.mp4`;
card.mindKey = `cards/${card.id}/mind.mind`;

console.log("\nround trip");
try {
  await store.createCard(card);
  check("createCard accepted the record", true, `id ${card.id}`);
} catch (err) {
  check("createCard accepted the record", false, err.message);
}

try {
  const read = await store.getCard(card.id);
  check("getCard returns the record", Boolean(read), read ? `title "${read.title}"` : "null");
  if (read) {
    // Field-for-field comparison: a column mapping mistake (snake_case vs camelCase) silently
    // produces undefined fields that only surface much later, at render time.
    const fields = ["ownerToken", "title", "createdAt", "photoKey", "videoKey", "mindKey"];
    const wrong = fields.filter((f) => read[f] !== card[f]);
    check("every text field survives the round trip", wrong.length === 0, wrong.length ? `differs: ${wrong.join(", ")}` : "");

    check(
      "videoAspect survives as a number",
      Math.abs(Number(read.videoAspect) - card.videoAspect) < 1e-9,
      String(read.videoAspect)
    );
    check(
      "trackingPoints survives as a number",
      Number(read.trackingPoints) === card.trackingPoints,
      String(read.trackingPoints)
    );
  }
} catch (err) {
  check("getCard returns the record", false, err.message);
}

try {
  const missing = await store.getCard("000000000000");
  check("getCard on an unknown id returns null (not an error)", missing === null, JSON.stringify(missing));
} catch (err) {
  check("getCard on an unknown id returns null (not an error)", false, err.message);
}

console.log("\ncleanup");
try {
  const deleted = await store.deleteCard(card.id);
  check("deleteCard reports success", deleted === true, String(deleted));
  const after = await store.getCard(card.id);
  check("record is gone after delete", after === null, JSON.stringify(after));
} catch (err) {
  check("deleteCard reports success", false, err.message);
}

console.log(failures === 0 ? "\nTurso backend works.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
