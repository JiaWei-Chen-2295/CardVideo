// Ask the LIVE deployment whether its serverless function is actually being invoked.
//
// WHY THIS EXISTS
// The failure that took the API down produced no build error of any kind. The deployment
// succeeded, the site loaded, and every page worked -- because the whole thing had been
// published as a pure static bundle with the function left out. The only visible symptom
// was that `GET /api/health` answered the homepage document with `200 text/html` instead
// of JSON, and `POST` to any `/api/*` path was rejected `405` by the static layer.
//
// No local check can catch that: the code was correct on every machine it was tested on.
// Only a request to the real URL distinguishes "deployed" from "deployed correctly", so
// this script makes that request and fails loudly.
//
// usage: node scripts/check-live.mjs [url]
//        default url is $LIVE_URL, else https://card.javierchen.cn
//
// NOTE ON THIS MACHINE: a Clash-style proxy in fake-IP mode intercepts DNS for public
// hostnames and answers with 198.18.0.0/15 addresses. That makes the site appear to
// return 405s that come from the proxy, not from Vercel -- the exact red herring that
// started this investigation. Set HTTPS_PROXY="" or disable the proxy before trusting a
// failure reported by this script.

const BASE = (
  process.argv[2] ??
  process.env.LIVE_URL ??
  "https://card.javierchen.cn"
).replace(/\/$/, "");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Add a cache-buster: the CDN happily caches a wrong answer under an API path. */
const bust = (path) => `${BASE}${path}${path.includes("?") ? "&" : "?"}cb=${Date.now()}`;

async function call(method, path, body) {
  const res = await fetch(bust(path), {
    method,
    redirect: "manual",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    edge: res.headers.get("x-vercel-cache") ?? "-",
    server: res.headers.get("server") ?? "-",
    text,
  };
}

console.log(`\nlive deployment check\n\n  ${BASE}\n`);

let health;
try {
  health = await call("GET", "/api/health");
} catch (err) {
  console.log(`  FAIL  could not reach the deployment -- ${err.message}`);
  console.log(
    "\n  If the error mentions a certificate or a connection reset, check whether a\n" +
      "  system proxy is intercepting the hostname before blaming the deployment.\n"
  );
  process.exit(1);
}

console.log("is the serverless function running at all");
check(
  "GET /api/health answers JSON, not the homepage document",
  health.type.includes("application/json"),
  `ct=${health.type || "(none)"} status=${health.status} -- text/html here means the ` +
    "deployment went out as static files only and the entire API is unreachable"
);

let parsed = null;
if (health.type.includes("application/json")) {
  try {
    parsed = JSON.parse(health.text);
  } catch {
    /* reported below */
  }
}
check("the health payload parses", parsed !== null);
check("it reports ok", parsed?.ok === true);
check(
  "it reports a storage backend",
  typeof parsed?.storage === "string",
  `storage=${parsed?.storage}`
);
check(
  "it reports a card backend",
  typeof parsed?.cards === "string",
  `cards=${parsed?.cards}`
);
check("the vendor bundle is present on the deployment", parsed?.vendorReady === true);

// `disk`/`json` mean the environment variables never reached the function. The app then
// falls back to a local filesystem that Vercel does not persist, so uploads appear to
// succeed and the card is gone a moment later.
if (parsed) {
  check(
    "production is not falling back to local disk",
    parsed.storage !== "disk",
    parsed.storage === "disk"
      ? "S3_* environment variables are missing from this Vercel environment"
      : ""
  );
  check(
    "production is not falling back to a local JSON file",
    parsed.cards !== "json",
    parsed.cards === "json"
      ? "TURSO_* environment variables are missing from this Vercel environment"
      : ""
  );
}

console.log("\nthe rest of the API is reachable (405 and text/html are the failure modes)");
for (const [method, path, body, expected] of [
  ["GET", "/api/cards/000000000000", undefined, 404],
  ["POST", "/api/upload-ticket", {}, 400],
  ["POST", "/api/cards", {}, 400],
]) {
  const res = await call(method, path, body);
  check(
    `${method} ${path} reaches the API`,
    res.type.includes("application/json") && res.status === expected,
    `expected ${expected} JSON, got ${res.status} ${res.type || "(none)"}`
  );
}

console.log("\nthe pages still load");
for (const path of ["/", "/create", "/selfcheck"]) {
  const res = await call("GET", path);
  check(
    `GET ${path}`,
    res.status === 200 && res.type.includes("text/html"),
    `got ${res.status} ${res.type || "(none)"}`
  );
}

console.log(
  failures === 0
    ? "\nThe live deployment is serving the app, not just the static files.\n"
    : `\n${failures} check(s) FAILED against the live deployment.\n`
);
process.exit(failures === 0 ? 0 : 1);
