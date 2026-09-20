// Verify the S3-compatible object storage backend against the REAL bucket.
//
// WHY THIS SCRIPT EXISTS
// The local disk adapter and the S3 adapter are different code. Everything checked locally
// exercises the disk adapter; the S3 path only runs in production. This exercises it end to end
// with the configured credentials, including the one step that is uniquely easy to get wrong and
// impossible to catch locally: the PRESIGNED UPLOAD.
//
// It also reports the public read URL and fetches it, which is what a viewer's browser will do --
// a bucket that is private, or whose CORS blocks cross-origin reads, fails there and nowhere else.
//
// usage:  node --env-file=.env scripts/check-storage.mjs
//
// Every object it creates is deleted before it exits.

import { createStorage, cardKey, assertSafeKey } from "../server/lib/storage.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

const endpoint = process.env.S3_ENDPOINT;
if (!endpoint) {
  console.error(
    "\nS3_ENDPOINT is not set, so there is nothing to verify.\n" +
      "Run with the values in your environment:\n" +
      "  node --env-file=.env scripts/check-storage.mjs\n"
  );
  process.exit(2);
}

console.log(`\nObject storage check`);
console.log(`  endpoint ${endpoint}`);
console.log(`  region   ${process.env.S3_REGION ?? "(unset)"}`);
console.log(`  bucket   ${process.env.S3_BUCKET}`);

// ---------------------------------------------------------------- credential sanity
//
// Checked BEFORE anything is sent, because the failure it prevents is not self-explanatory. Filling
// both variables with the same secret -- a copy-paste slip that is easy to make, since AccessKey and
// SecretKey are both 40 characters and both start with "S" -- produces `SignatureDoesNotMatch` from
// every request. That message names cryptography, not configuration, so it sends the investigation
// into request signing, addressing style and headers, none of which is at fault.
{
  const id = process.env.S3_ACCESS_KEY_ID ?? "";
  const secret = process.env.S3_SECRET_ACCESS_KEY ?? "";

  check("access key id is set", id.length > 0, id.length ? `${id.length} chars` : "empty");
  check("secret access key is set", secret.length > 0, secret.length ? `${secret.length} chars` : "empty");

  if (id && secret) {
    if (id === secret) {
      check(
        "the two credentials are different values",
        false,
        "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY hold the SAME string. They are a pair of " +
          "DISTINCT values from one row of the provider's key table -- copy each from its own field."
      );
      console.log("\nStopping here: every request would fail with SignatureDoesNotMatch.\n");
      process.exit(1);
    }
    check("the two credentials are different values", true, `fingerprints differ`);
  }

  // Invisible characters are the other silent killer; a trailing space survives look-alike review.
  for (const [name, value] of [["S3_ACCESS_KEY_ID", id], ["S3_SECRET_ACCESS_KEY", secret]]) {
    if (!value) continue;
    const suspect = /[\s'"]/.test(value) || /[^\x20-\x7e]/.test(value);
    check(`${name} has no stray whitespace or quotes`, !suspect, suspect ? "contains whitespace, a quote, or a non-ASCII character" : "");
  }
}

// A bucket name smuggled into the endpoint is the single most likely misconfiguration: the
// provider console shows the RESULT of prefixing the bucket, so pasting it back yields
// `<bucket>.<bucket>.<host>` and every request 404s against a host that does not exist.
if (process.env.S3_BUCKET && new URL(endpoint).host.startsWith(`${process.env.S3_BUCKET}.`)) {
  check(
    "endpoint does not already contain the bucket name",
    false,
    `remove "${process.env.S3_BUCKET}." from S3_ENDPOINT -- the SDK adds it automatically`
  );
} else {
  check("endpoint does not already contain the bucket name", true);
}

console.log("\nadapter");
let storage;
try {
  storage = await createStorage({ dataDir: "./data" });
  check("storage adapter created", storage.kind !== "disk", `kind = ${storage.kind}`);
} catch (err) {
  check("storage adapter created", false, err.message);
  process.exit(1);
}
if (storage.kind === "disk") {
  console.log("\nStorage fell back to local disk, so there is nothing cloud-side to verify.");
  console.log("Check that S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_BUCKET are all set.\n");
  process.exit(0);
}

// A stand-in card id; the objects are cleaned up at the end either way.
const cardId = "Q0CHECK00000".slice(0, 12).replace(/[^0-9A-Za-z]/g, "Q");
const created = [];

// ------------------------------------------------------------------ ticket

console.log("\nupload ticket");
const photoKey = cardKey(cardId, "photo", "png");
const payload = Buffer.from(
  // A 1x1 PNG: real bytes, so a content-type or size check on the bucket side is exercised.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

let uploadUrl;
let ticketHeaders;
try {
  const ticket = await storage.createUploadTicket(photoKey, { contentType: "image/png" });
  uploadUrl = ticket.uploadUrl;
  ticketHeaders = ticket.headers ?? {};
  check("ticket issued", Boolean(uploadUrl), `method ${ticket.method}`);
} catch (err) {
  check("ticket issued", false, err.message);
  process.exit(1);
}

// ------------------------------------------------------------------ CORS preflight
//
// Checked BEFORE the upload, because a CORS rejection and a credential problem look identical from
// the browser: both surface as a bare "network error". Node is not subject to the same-origin
// policy, so a PUT issued from this script succeeds even when every browser on the network is
// blocked -- which is exactly what happened on a real bucket whose CORS rules had never been set.
//
// A `PUT` carrying `Content-Type` is not a simple request, so the browser sends `OPTIONS` first and
// proceeds only if the response allows the origin, the method, AND every header the request sends.

console.log("\nCORS preflight (what the browser sends before uploading)");
{
  const origin = process.env.CHECK_ORIGIN ?? "https://localhost:3000";
  const headerNames = Object.keys(ticketHeaders);

  try {
    const res = await fetch(uploadUrl, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": headerNames.join(", "),
      },
    });

    const allowOrigin = res.headers.get("access-control-allow-origin");
    const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();

    check(
      `preflight allows origin ${origin}`,
      allowOrigin === "*" || allowOrigin === origin,
      allowOrigin ? `got "${allowOrigin}"` : "Access-Control-Allow-Origin is absent"
    );
    check(
      "preflight allows the PUT method",
      /PUT|\*/i.test(allowMethods),
      allowMethods ? `got "${allowMethods}"` : "Access-Control-Allow-Methods is absent"
    );

    const missing = headerNames.filter(
      (h) => !allowHeaders.includes(h.toLowerCase()) && !allowHeaders.includes("*")
    );
    check(
      "preflight allows every header the upload sends",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : ""
    );

    // When the header check fails, name the ONE header that is actually rejected.
    //
    // A bucket CORS rule that omits a single header rejects the whole preflight, and the service's
    // error names all three components at once -- "the evaluation of Origin, request method /
    // Access-Control-Request-Method or Access-Control-Request-Header ..." -- so the failing header
    // has to be isolated by asking again without it. That is worth automating: on a real bucket the
    // rule allowed `authorization` and `content-length` but not `content-type`, which is the one the
    // upload actually needs, and nothing in the error said so.
    if (missing.length) {
      console.log("\n  isolating which header is rejected:");
      for (const header of headerNames) {
        try {
          const probe = await fetch(uploadUrl, {
            method: "OPTIONS",
            headers: {
              Origin: origin,
              "Access-Control-Request-Method": "PUT",
              "Access-Control-Request-Headers": header,
            },
          });
          const allowed = Boolean(probe.headers.get("access-control-allow-origin"));
          console.log(
            `    ${allowed ? "allowed " : "REJECTED"}  ${header}` +
              (allowed ? "" : "   <- add this to the rule's allowed headers")
          );
        } catch (err) {
          console.log(`    unknown   ${header} (${err.message})`);
        }
      }
    }

    if (!allowOrigin) {
      console.log("");
      console.log("  UPLOADS WILL FAIL IN A BROWSER with a bare 'network error'.");
      console.log("  Set a CORS rule on the bucket:");
      console.log("    Qiniu:  空间设置 -> 跨域设置 -> 添加规则");
      console.log(`      来源: ${origin}   (use * while testing)`);
      console.log("      方法: GET, HEAD, PUT, POST, OPTIONS");
      console.log("      头部: Content-Type, Content-Length, Authorization");
      console.log("      缓存: 3600");
      console.log("  Override the origin with CHECK_ORIGIN=<your app origin>.");
    }
  } catch (err) {
    check("preflight request completed", false, err.message);
  }
}

console.log("\npresigned upload (what the browser does)");
try {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: ticketHeaders,
    body: payload,
  });
  if (response.ok) {
    created.push(photoKey);
    check("presigned PUT accepted the bytes", true, `HTTP ${response.status}`);
  } else {
    const body = await response.text().catch(() => "");
    check("presigned PUT accepted the bytes", false, `HTTP ${response.status} ${body.slice(0, 200)}`);
  }
} catch (err) {
  check("presigned PUT accepted the bytes", false, err.message);
}

// ------------------------------------------------------------------ read URL
//
// This is what the viewer's browser does for every asset. Two configurations are valid, and they
// differ in cost rather than in correctness:
//
//   bound domain     -> a plain public URL, CDN-cacheable, cheap back-to-origin traffic
//   no domain        -> a presigned GET; works everywhere but is signed per request, expires, and
//                       cannot be cached by a CDN
//
// What is NOT valid is assuming the S3 endpoint itself serves public objects. Qiniu answers every
// anonymous request with `NotSupportAnonymous`, so a derived public URL would look right and fail
// at the viewer.

console.log("\nread URL (what the viewer's browser does)");
try {
  const url = await storage.readUrl(photoKey);
  const signed = /[?&](X-Amz|signature|sign)/i.test(url);
  const hasDomain = Boolean(process.env.S3_PUBLIC_BASE_URL);

  if (hasDomain) {
    console.log(`  url ${url}`);
    check("a bound domain is used, so the URL is unsigned", !signed, signed ? "still signed" : "");
  } else {
    console.log(`  url ${url.slice(0, 120)}${url.length > 120 ? "..." : ""}`);
    console.log("  note: no S3_PUBLIC_BASE_URL is set, so reads are presigned.");
    console.log("        That works, but binding a domain makes reads cacheable and roughly a third");
    console.log("        of the egress cost. See .env.example.");
  }

  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  check(
    "GET returns the object",
    response.ok && body.length === payload.length,
    `HTTP ${response.status}, ${body.length} bytes${response.ok ? "" : ` ${body.toString("utf8").slice(0, 120)}`}`
  );
  check(
    "content-type came back as expected",
    (response.headers.get("content-type") ?? "").includes("image/png"),
    response.headers.get("content-type") ?? "(none)"
  );
} catch (err) {
  check("GET returns the object", false, err.message);
}

// ------------------------------------------------------------------ delete
//
// The "delete this card" button depends on this, and a bucket policy that forbids deletion would
// otherwise only surface when a user tried to remove something.

console.log("\ndelete");
try {
  await storage.deleteObject(photoKey);
  created.length = 0;
  const url = await storage.readUrl(photoKey);
  const response = await fetch(url);
  check("object is gone after delete", response.status === 404, `HTTP ${response.status}`);
} catch (err) {
  check("object is gone after delete", false, err.message);
}

console.log("\nkey validation (must reject hostile keys)");
for (const [key, why] of [
  ["cards/../../etc/passwd", "traversal"],
  ["cards/x/photo.exe", "disallowed extension"],
  ["/absolute/path.png", "absolute path"],
]) {
  let rejected = false;
  try {
    assertSafeKey(key);
  } catch {
    rejected = true;
  }
  check(`rejects ${why}`, rejected, key);
}

for (const leftover of created) {
  await storage.deleteObject(leftover).catch(() => {});
}

console.log(failures === 0 ? "\nObject storage works.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
