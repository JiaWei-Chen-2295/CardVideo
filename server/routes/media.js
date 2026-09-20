// HTTP Range support for locally stored media.
//
// Videos are served through this route in local development, and byte ranges are not
// optional: seeking requires them, and Safari can refuse to play a video at all without
// `Accept-Ranges` support. Express's static middleware would do this for filesystem
// paths, but media here is addressed by opaque object keys, so parsing lives here.

import express from "express";
import { HttpError } from "../lib/config.js";
import { contentTypeForExt } from "../lib/storage.js";

/** Parse a single-range `Range: bytes=start-end` header. Multi-range is unsupported. */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start;
  let end;
  if (rawStart === "") {
    // Suffix form: the final N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Router serving objects out of a storage adapter by key.
 *
 * Object keys are immutable for the lifetime of a card, so everything is served with a
 * long max-age. Videos additionally honour Range requests.
 */
export function createMediaRouter({ storage }) {
  if (typeof storage.getObject !== "function") {
    throw new Error("createMediaRouter requires a storage adapter with getObject()");
  }

  const router = express.Router();

  const serve = async (req, res, next) => {
    try {
      const key = req.params[0] ?? "";
      const object = await storage.getObject(key);
      if (!object) throw new HttpError(404, "media not found");

      const ext = key.split(".").pop()?.toLowerCase() ?? "";
      const contentType = contentTypeForExt(ext);
      const isVideo = contentType.startsWith("video/");

      res.setHeader("Content-Type", contentType);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

      if (isVideo) {
        const range = parseRange(req.headers.range, object.size);
        if (range) {
          const { start, end } = range;
          res.status(206);
          res.setHeader("Content-Range", `bytes ${start}-${end}/${object.size}`);
          res.setHeader("Content-Length", end - start + 1);
          res.end(object.bytes.subarray(start, end + 1));
          return;
        }
      }

      res.setHeader("Content-Length", object.size);
      res.end(object.bytes);
    } catch (err) {
      next(err);
    }
  };

  router.get("/*", serve);
  router.head("/*", serve);
  return router;
}

/**
 * Router mounted at /api/local-upload for the disk adapter.
 *
 * R2 hands the browser a presigned URL and the bytes never touch Node. Local disk has
 * no such mechanism, so the browser PUTs here instead. Keeping the client's upload code
 * identical for both ("one URL, one PUT") is worth this small endpoint.
 */
export function createLocalUploadRouter({ storage, maxBytes }) {
  const router = express.Router();

  router.put(
    "/*",
    express.raw({ type: "*/*", limit: maxBytes }),
    async (req, res, next) => {
      try {
        const key = req.params[0] ?? "";
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          throw new HttpError(400, "empty upload body");
        }
        const result = await storage.putObject(key, body);
        res.json({ ok: true, key: result.key, size: result.size });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
