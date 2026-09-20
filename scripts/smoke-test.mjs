// End-to-end smoke test against a running CardVideo server.
//
// Exercises the real upload path (ticket -> PUT -> finalize -> read -> delete) using the
// generated fixtures, so a green run proves the API contract rather than just that the
// process boots.
//
// Usage:  node scripts/smoke-test.mjs [baseUrl]
// Expects: npm run gen:target (for the photo) and npm run gen:video (for the MP4).

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Base URL of the server under test.
 *
 * The explicit argument wins; otherwise both documented ways of running the dev server are tried.
 * Hard-coding `http://localhost:3000` made `npm run check` fail wholesale whenever the server was
 * started with `npm run dev:https`, which is the normal mode for phone testing.
 */
async function resolveBase() {
  if (process.argv[2]) return process.argv[2].replace(/\/+$/, "");

  // HTTPS FIRST, then HTTP. Probing HTTP first against a TLS server reported success (the
  // connection closes without a body, which Node's fetch does not always surface as an error), so
  // this proceeded with a plaintext base URL against an HTTPS server.
  for (const candidate of ["https://localhost:3000", "http://localhost:3000"]) {
    const isTls = candidate.startsWith("https://");
    if (isTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    try {
      const res = await fetch(`${candidate}/api/health`);
      if (res.ok && (await res.json())?.ok === true) return candidate;
    } catch {
      /* try the next candidate */
    }

    if (isTls) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
  return "http://localhost:3000";
}

const base = await resolveBase();
console.log(`[smoke-test] target ${base}`);

// The HTTPS dev server uses a self-signed certificate, which Node's fetch rejects by default.
// Verification is disabled ONLY for a loopback or private-network target in a development check --
// never for a remote host.
if (base.startsWith("https://") && /^https:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(base)) {
  console.warn(`[warn] ${base} uses a self-signed certificate; disabling TLS verification for this run only`);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/**
 * Absolutise a URL returned by the API.
 *
 * The local disk adapter hands back a path (`/api/local-upload/...`) while an object store hands back
 * a full presigned URL (`https://...`). The test used to concatenate unconditionally, which worked
 * against the local adapter and produced `https://localhost:3000https://...` against a real bucket --
 * a test that only ever exercised one backend.
 */
const absolute = (url) => (/^https?:\/\//i.test(url) ? url : base + url);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const postJson = async (path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text };
};

console.log(`\nCardVideo smoke test -> ${base}\n`);

// ------------------------------------------------------------------- health
console.log("health");
{
  const res = await fetch(`${base}/api/health`);
  const json = await res.json().catch(() => null);
  check("GET /api/health responds 200", res.status === 200, `status ${res.status}`);
  check("reports a storage backend", Boolean(json?.storage), `storage=${json?.storage}`);
  check("reports a card backend", Boolean(json?.cards), `cards=${json?.cards}`);
  check(
    "vendor bundle is present",
    json?.vendorReady === true,
    json?.vendorReady ? "" : "run `npm run vendor`"
  );
}

// ------------------------------------------------------------------ fixtures
console.log("\nfixtures");
let photoBytes;
let videoBytes;
try {
  photoBytes = await readFile(join(root, "data", "fixtures", "test-target.png"));
  check("photo fixture exists", photoBytes.length > 0, `${photoBytes.length} bytes`);
} catch {
  check("photo fixture exists", false, "run `node scripts/gen-fixtures.mjs`");
}
try {
  videoBytes = await readFile(join(root, "data", "fixtures", "test-video.mp4"));
  check("video fixture exists", videoBytes.length > 0, `${videoBytes.length} bytes`);
} catch {
  check("video fixture exists", false, "generate an MP4 or ffmpeg is unavailable here");
}

if (photoBytes && videoBytes) {
  // ------------------------------------------------------------- upload flow
  console.log("\nupload flow");
  const mindBytes = Buffer.from("stub-mind-payload-for-smoke-test");

  const ticket = await postJson("/api/upload-ticket", {
    assets: "photo,video,mind",
    files: [
      { name: "target.png", type: "image/png", size: photoBytes.length },
      { name: "clip.mp4", type: "video/mp4", size: videoBytes.length },
      { name: "target.mind", type: "application/octet-stream", size: mindBytes.length },
    ],
  });
  check("ticket issued", ticket.status === 200, `status ${ticket.status} ${ticket.text.slice(0, 120)}`);
  const cardId = ticket.json?.cardId;
  check("card id looks like 12 base62 chars", /^[0-9A-Za-z]{12}$/.test(cardId ?? ""), cardId);

  const tickets = ticket.json?.tickets ?? [];
  const byKind = Object.fromEntries(tickets.map((t) => [t.kind, t]));
  check("three tickets returned", tickets.length === 3, `got ${tickets.length}`);

  let uploaded = 0;
  for (const [kind, bytes] of [
    ["photo", photoBytes],
    ["video", videoBytes],
    ["mind", mindBytes],
  ]) {
    const t = byKind[kind];
    if (!t) {
      check(`upload ${kind}`, false, "no ticket");
      continue;
    }
    const res = await fetch(absolute(t.uploadUrl), {
      method: t.method ?? "PUT",
      headers: t.headers ?? {},
      body: bytes,
    });
    check(`upload ${kind}`, res.ok, `status ${res.status}`);
    if (res.ok) uploaded++;
  }
  check("all three objects uploaded", uploaded === 3, `${uploaded}/3`);

  // ------------------------------------------------------------- finalize
  console.log("\nfinalize");
  const created = await postJson("/api/cards", {
    cardId,
    photoKey: byKind.photo?.key,
    videoKey: byKind.video?.key,
    mindKey: byKind.mind?.key,
    title: "smoke test card",
    videoAspect: 16 / 9,
    trackingPoints: 42,
  });
  check("card created", created.status === 201, `status ${created.status} ${created.text.slice(0, 160)}`);
  const ownerToken = created.json?.ownerToken;
  check("owner token returned", typeof ownerToken === "string" && ownerToken.length > 10);

  // ------------------------------------------------------------------ read
  console.log("\nread");
  const read = await fetch(`${base}/api/cards/${cardId}`);
  const card = await read.json().catch(() => null);
  check("GET card responds 200", read.status === 200, `status ${read.status}`);
  check("card exposes photoUrl", Boolean(card?.photoUrl), card?.photoUrl);
  check("card exposes videoUrl", Boolean(card?.videoUrl), card?.videoUrl);
  check("card exposes mindUrl", Boolean(card?.mindUrl), card?.mindUrl);
  check("share payload hides the owner token", card?.ownerToken === undefined);

  // The server re-derived the aspect ratio from the real MP4 header, so it must match
  // the actual 640x360 fixture rather than the 16/9 we sent.
  check(
    "aspect ratio taken from the video header",
    Math.abs((card?.videoAspect ?? 0) - 640 / 360) < 0.001,
    `videoAspect=${card?.videoAspect}`
  );

  // ------------------------------------------------------------- media fetch
  //
  // Against the disk adapter these URLs are same-origin paths served by the media router, where the
  // checks below (immutability header, ranged response) are our own behaviour. Against an object
  // store they are presigned URLs served by the provider, which does not set our cache headers and
  // may not honour Range at all -- so those two assertions only apply locally.
  console.log("\nmedia");
  const servedByDisk = /^\/(?!\/)/.test(card.photoUrl ?? "");
  {
    const res = await fetch(absolute(card.photoUrl));
    const bytes = Buffer.from(await res.arrayBuffer());
    check("photo is served", res.ok && bytes.length === photoBytes.length, `status ${res.status}, ${bytes.length} bytes`);
    if (servedByDisk) {
      check("photo is marked immutable", /immutable/.test(res.headers.get("cache-control") ?? ""), res.headers.get("cache-control"));
    } else {
      console.log("  skip  cache-header check: this URL is served by the object store, not by us");
    }
  }
  {
    const res = await fetch(absolute(card.videoUrl), { headers: { range: "bytes=0-99" } });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (servedByDisk) {
      check("video range request returns 206", res.status === 206, `status ${res.status}`);
      check("range payload is 100 bytes", bytes.length === 100, `${bytes.length} bytes`);
      check(
        "content-range is correct",
        res.headers.get("content-range") === `bytes 0-99/${videoBytes.length}`,
        res.headers.get("content-range")
      );
    } else {
      // Still worth asserting the object is reachable and non-empty; how the provider handles Range
      // is its business, and the video element does not require 206 to play.
      check("video is reachable through its read URL", res.ok && bytes.length > 0, `status ${res.status}, ${bytes.length} bytes`);
      console.log(`  note  range support is the object store's concern (status ${res.status})`);
    }
  }

  // ----------------------------------------------------- delete authorization
  console.log("\ndelete authorization");
  {
    const res = await fetch(`${base}/api/cards/${cardId}`, { method: "DELETE" });
    check("delete without token is refused", res.status === 403, `status ${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/cards/${cardId}`, {
      method: "DELETE",
      headers: { "x-owner-token": "wrong-token-value-here" },
    });
    check("delete with wrong token is refused", res.status === 403, `status ${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/cards/${cardId}`, {
      method: "DELETE",
      headers: { "x-owner-token": ownerToken },
    });
    check("delete with owner token succeeds", res.status === 200, `status ${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/cards/${cardId}`);
    check("card is gone after delete", res.status === 404, `status ${res.status}`);
  }
  {
    // After the card is deleted its objects must be gone. For a presigned URL the signature still
    // validates, so the provider answers 404 only if the object really was removed.
    const res = await fetch(absolute(card.photoUrl));
    check("photo object is gone after delete", res.status === 404, `status ${res.status}`);
  }

  // --------------------------------------------------------- input validation
  console.log("\nvalidation");
  {
    const res = await postJson("/api/upload-ticket", {
      assets: "photo",
      files: [{ name: "evil.exe", type: "application/octet-stream", size: 10 }],
    });
    check("rejects disallowed extension", res.status === 400, `status ${res.status}`);
  }
  {
    const res = await postJson("/api/upload-ticket", {
      assets: "photo",
      files: [{ name: "huge.png", type: "image/png", size: 90 * 1024 * 1024 }],
    });
    check("rejects oversized photo", res.status === 413, `status ${res.status}`);
  }
  {
    const res = await fetch(`${base}/api/cards/../../package.json`);
    check("path traversal is not served", res.status === 404 || res.status === 400, `status ${res.status}`);
  }
  {
    const res = await postJson("/api/cards", {
      cardId: "aaaaaaaaaaaa",
      photoKey: "cards/bbbbbbbbbbbb/photo.png",
      videoKey: "cards/bbbbbbbbbbbb/video.mp4",
      mindKey: "cards/bbbbbbbbbbbb/mind.mind",
    });
    check("rejects cross-card object keys", res.status === 400, `status ${res.status}`);
  }
}

console.log(failures === 0 ? "\nAll smoke checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
