// CardVideo server.
//
// Deployment reality that shapes this file (DESIGN.md §3.3, §6.1):
//   - Vercel functions cap request bodies at 4.5MB, so no video ever passes through
//     here. Uploads use per-object tickets handed to the browser (routes/api.js).
//   - There is no persistent local disk on Vercel, so media AND card metadata live in
//     S3-compatible object storage -- one provider, one credential set. Locally both fall
//     back to `data/` with zero credentials.
//   - Nothing here may import @tensorflow/tfjs. That tree is ~200MB and would blow the
//     250MB function bundle limit, so .mind compilation happens in the browser.

import express from "express";
import compression from "compression";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createStorage } from "./lib/storage.js";
import { createCardStore } from "./lib/cardStore.js";
import { createApiRouter } from "./routes/api.js";
import { createMediaRouter, createLocalUploadRouter } from "./routes/media.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dataDir = process.env.DATA_DIR ? join(process.env.DATA_DIR) : join(root, "data");
const publicDir = join(root, "public");

const storage = await createStorage({ dataDir });
// Metadata lives in Turso, media in object storage. Deliberately two providers: the object store's
// free tier is consumed by video traffic, and metadata reads should not compete with the thing this
// product actually spends.
const cardStore = await createCardStore({ dataDir });

/**
 * Optional TLS for phone testing.
 *
 * The camera is gated behind a secure context: on plain http over a LAN address,
 * `navigator.mediaDevices` is undefined and the AR page cannot work at all. localhost is
 * exempt, which is why this only bites when testing from a real device.
 *
 * Enabled with `npm run dev:https` (or HTTPS=1), which generates a self-signed certificate
 * covering the machine's LAN IPs. A self-signed certificate is not trusted by phones, so the
 * device shows a warning once and the user accepts it -- acceptable for testing, and the only
 * option that needs no external service or installed CA.
 */
const tlsOptions = process.env.HTTPS === "1"
  ? await (await import("../scripts/dev-cert.mjs")).ensureDevCertificate({ dataDir })
  : null;

const app = express();
app.disable("x-powered-by");

/**
 * Cache policy, split by how a file's content relates to its URL.
 *
 * This distinction is not cosmetic. Serving application code with a long max-age means the
 * browser will not even ASK the server for up to an hour, so a corrected script keeps
 * running the old code while the server is demonstrably serving the new bytes. That exact
 * trap cost two debugging round-trips on this project.
 *
 *   HTML        -> no-cache. These documents carry the import map, which is the only thing
 *                  binding bare module specifiers to real URLs, so a cached copy pins the
 *                  browser to a stale module graph.
 *   app code    -> no-cache (revalidate). /js and /css change whenever the app changes.
 *                  no-cache still allows a cached body: the browser revalidates with its
 *                  ETag every time and gets a 304, so freshness costs a header round trip
 *                  rather than a re-download.
 *   vendor      -> short max-age. These are third-party bundles, megabytes in size, and
 *                  genuinely worth caching -- but sync-vendor.mjs PATCHES some of them, so
 *                  they are not immutable and must not be cached for long either.
 *   media       -> long max-age (set by the media routes; object keys are per-card and a
 *                  card is never mutated in v1).
 */
const CACHE_POLICY = {
  html: "no-cache, must-revalidate",
  app: "no-cache, must-revalidate",
  vendor: "public, max-age=300",
};

function cacheControlFor(filePath) {
  const normalized = filePath.split("\\").join("/");
  if (normalized.endsWith(".html")) return CACHE_POLICY.html;
  if (normalized.includes("/vendor/")) return CACHE_POLICY.vendor;
  return CACHE_POLICY.app;
}

/** Send an HTML page with the policy above applied. */
const sendPage = (res, file) => {
  res.setHeader("Cache-Control", CACHE_POLICY.html);
  res.sendFile(join(publicDir, file));
};

// -------------------------------------------------------------------- middleware

app.use((req, res, next) => {
  // The AR page needs the camera, which browsers only grant on a secure origin.
  // `Permissions-Policy` keeps that capability scoped to our own origin.
  res.setHeader("Permissions-Policy", "camera=(self)");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Compression matters more than usual here: the AR page pulls three.js plus mind-ar's
// render bundle, which is ~4MB of JavaScript uncompressed and roughly a third of that
// gzipped -- on a phone over cellular that difference is the whole loading experience.
// Vercel's CDN compresses on its own, so this is primarily for local and self-hosted runs.
app.use(compression());

// JSON only ever carries small metadata; the real ceiling in production is Vercel's
// 4.5MB body cap, so stay comfortably under it.
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------------------ routes

/** Health/diagnostics; also reports which storage backends are live. */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    storage: storage.kind,
    cards: cardStore.kind,
    vendorReady: existsSync(join(publicDir, "vendor", "mindar-image-three.prod.js")),
    // Which address the request actually arrived on. When a phone reports "cannot connect",
    // this says whether the request ever reached the server at all: if it did, the problem is
    // in the app; if it did not, it is firewall, subnet or AP isolation.
    via: req.headers.host ?? null,
    serverAddresses: serverAddresses(),
  });
});

/** Addresses this process is bound to, for diagnostics. */
function serverAddresses() {
  const out = [];
  for (const [iface, entries] of Object.entries(networkInterfaces() ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4") out.push({ iface, address: entry.address });
    }
  }
  return out;
}

app.use("/api", createApiRouter({ storage, cardStore }));

// Local disk has no presigned URLs, so the browser PUTs to us instead. With R2 this is
// not mounted at all and the browser talks to R2 directly.
if (storage.kind === "disk") {
  app.use("/media", createMediaRouter({ storage }));
  app.use(
    "/api/local-upload",
    createLocalUploadRouter({ storage, maxBytes: 300 * 1024 * 1024 })
  );
}

/**
 * Conditional-request handling for the static assets.
 *
 * Written by hand rather than relying on Express implementing it, because it does not:
 * measured against this configuration, a request carrying a matching `If-None-Match` was
 * answered `200` with the full body (with and without `compression` in the chain, and for
 * HEAD too). Since the point of `no-cache` is that revalidation is CHEAP, a revalidation
 * that re-sends the whole file is worthless -- so the 304 is issued explicitly here.
 *
 * This must run BEFORE express.static, which also means the compression middleware never
 * sees the 304 response and has nothing to compress.
 */
app.use(async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const diskPath = toPublicPath(req.path);
  if (!diskPath) return next();

  const policy = cacheControlFor(diskPath);
  // Only revalidating policies benefit; vendor assets are served from cache by age.
  if (!policy.startsWith("no-cache")) return next();

  try {
    const info = await stat(diskPath);
    if (!info.isFile()) return next();

    const tag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
    res.setHeader("Cache-Control", policy);
    res.setHeader("ETag", tag);

    if (!sameEntityTag(req.headers["if-none-match"], tag)) return next();

    res.status(304);
    res.removeHeader("Content-Type");
    res.removeHeader("Content-Length");
    res.end();
    return;
  } catch {
    // Missing or unreadable file: let express.static produce its own 404.
    return next();
  }
});

/**
 * Map a request path to a file inside public/, or null if it would escape.
 *
 * The guard matters: `req.path` is attacker-controlled, and a traversal here would expose
 * arbitrary files from disk.
 */
function toPublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const full = resolve(publicDir, "." + (decoded.startsWith("/") ? decoded : `/${decoded}`));
  return full === publicDir || full.startsWith(publicDir + sep) ? full : null;
}

/** Compare an If-None-Match header against an entity tag, ignoring weak prefixes and lists. */
function sameEntityTag(header, tag) {
  if (!header) return false;
  const weak = (value) => value.trim().replace(/^W\//, "");
  return String(header)
    .split(",")
    .some((candidate) => weak(candidate) === weak(tag) || candidate.trim() === "*");
}

app.use(express.static(publicDir, {
    extensions: ["html"],
    setHeaders(res, filePath) {
      res.setHeader("Cache-Control", cacheControlFor(filePath));
    },
  })
);

// Share-link landing page. The page fetches /api/cards/:id itself, so this is a static
// shell that also survives being hit directly on a cold CDN.
app.get("/c/:id", (req, res) => sendPage(res, "card.html"));

// The AR session and creator pages. These are also reachable as plain .html files via the
// static middleware above; the extensionless routes exist so share links stay short.
//
// All of them are sent with no-cache for the reason documented on express.static below:
// these documents carry the import map, so a cached copy pins the browser to whatever
// module URLs were current when it was fetched.
app.get("/ar", (req, res) => sendPage(res, "ar.html"));
app.get("/create", (req, res) => sendPage(res, "create.html"));
app.get("/selfcheck", (req, res) => sendPage(res, "selfcheck.html"));

// ------------------------------------------------------------------------- errors

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

// eslint-disable-next-line no-unused-vars -- express detects error handlers by arity
app.use((err, req, res, next) => {
  const status = err?.status || 500;
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({
    error: err?.message ?? "internal error",
    ...(err?.extra ?? {}),
  });
});

// -------------------------------------------------------------------------- start

const port = Number(process.env.PORT ?? 3000);

/**
 * Interface to bind.
 *
 * 0.0.0.0 by default, not localhost: testing this app requires a phone, and a phone is a
 * different device. Binding only to loopback silently makes the LAN address unreachable,
 * which presents as "the server is running but my phone cannot connect".
 */
const host = process.env.HOST ?? "0.0.0.0";

/** Every non-internal IPv4 address, so the startup banner can print a testable URL. */
function lanAddresses() {
  const { networkInterfaces } = require("node:os");
  const out = [];
  for (const addresses of Object.values(networkInterfaces() ?? {})) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) out.push(address.address);
    }
  }
  return out;
}

// Listen only when run directly; exporting `app` lets Vercel's Node runtime wrap it.
if (!process.env.VERCEL) {
  const scheme = tlsOptions ? "https" : "http";
  const { lanCandidates, preferredLanAddress } = await import("../scripts/lib/lan.mjs");

  const server = tlsOptions
    ? (await import("node:https")).createServer(tlsOptions, app)
    : (await import("node:http")).createServer(app);

  server.listen(port, host, () => {
    const vendorReady = existsSync(join(publicDir, "vendor", "mindar-image-three.prod.js"));
    const preferred = preferredLanAddress();
    const candidates = lanCandidates();

    console.log(`\n  CardVideo ready`);
    console.log(`  storage    ${storage.kind}`);
    console.log(`  cards      ${cardStore.kind}`);
    console.log(`  protocol   ${scheme}${tlsOptions ? " (self-signed certificate)" : ""}`);
    console.log(`  local      ${scheme}://localhost:${port}/`);

    if (host !== "127.0.0.1" && preferred) {
      console.log(`\n  ┌─ 手机测试地址（手机需连同一 Wi-Fi）`);
      console.log(`  │  ${scheme}://${preferred}:${port}/debug.html`);
      console.log(`  └─ 先用这个地址打开 /debug.html，全绿了再去 /selfcheck`);

      const others = candidates.filter((c) => c.address !== preferred);
      if (others.length) {
        console.log(`\n  本机其它地址（多半连不通，仅供排查）:`);
        for (const candidate of others) {
          console.log(
            `    ${candidate.address.padEnd(16)} ${candidate.iface.padEnd(30)}` +
              (candidate.virtual ? `✗ ${candidate.reason}` : "✓ 可用")
          );
        }
      }

      if (!tlsOptions) {
        console.log(
          `\n  ⚠  http 下浏览器不会给摄像头权限，AR 页面会直接报错。\n` +
            `     用 npm run dev:https 启动（自签证书，手机需手动信任一次）。`
        );
      } else {
        console.log(
          `\n  手机首次打开会提示证书不受信任，各浏览器的处理方式：\n` +
            `     Android Chrome: 点"高级" -> "继续前往"\n` +
            `     iOS Safari:     点"显示详细信息" -> "访问此网站"\n` +
            `     iOS 还要额外一步: 设置 > 通用 > 关于本机 > 证书信任设置 -> 打开该证书`
        );
      }
    } else if (host !== "127.0.0.1" && !preferred) {
      console.log(
        `\n  ⚠  没有找到可用的局域网地址（只有虚拟网卡）。\n` +
          `     请确认这台机器连上了 Wi-Fi 或有线网络。`
      );
    }

    if (!vendorReady) console.warn(`\n  WARNING    public/vendor is empty -- run: npm run vendor`);
    console.log("");
  });
}

export default app;
