// Card lifecycle: reserve an upload, then finalize it into a shareable card.
//
// Flow (three calls, because nothing large may pass through the function -- DESIGN.md §6.1):
//
//   1. POST /api/upload-ticket   -> server mints the card id and presigned upload URLs
//   2. browser PUTs photo / video / .mind straight to storage
//   3. POST /api/cards           -> server writes metadata only (a few hundred bytes)
//
// The id is minted at step 1 rather than step 3 so object keys are bound to their card
// from the very first byte. The cost is that an abandoned upload leaves orphaned
// objects (see the note on `garbage` below).

import express from "express";
import {
  HttpError,
  asyncRoute,
  newCardId,
  newOwnerToken,
  isCardId,
  publicCard,
} from "../lib/config.js";
import { cardKey } from "../lib/storage.js";
import { inspectMp4Header } from "../lib/mp4.js";

/**
 * Uploadable assets.
 *
 * `maxBytes` exists so the disk upload route can size its body limit per kind, and so
 * the client can fail early with a useful message instead of after a long transfer.
 * Photo/video caps are deliberately generous but bounded -- there is no transcoding in
 * v1 (DESIGN.md P11), so an oversized video is a rejection, not a conversion job.
 */
const ASSETS = {
  photo: { ext: "png,jpg,jpeg,webp", maxBytes: 30 * 1024 * 1024, mime: /^image\// },
  video: { ext: "mp4,m4v,webm", maxBytes: 300 * 1024 * 1024, mime: /^video\// },
  mind: { ext: "mind", maxBytes: 20 * 1024 * 1024, mime: null },
};

const parseAssetList = (kind) => {
  if (!kind) throw new HttpError(400, "missing kind");
  const keys = String(kind)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) throw new HttpError(400, "missing kind");
  for (const key of keys) {
    if (!ASSETS[key]) throw new HttpError(400, `unknown asset kind: ${key}`);
  }
  return keys;
};

/** Extension for a client-supplied filename, checked against the allow-list. */
const pickExt = (filename, spec) => {
  const ext = String(filename ?? "")
    .split(".")
    .pop()
    ?.toLowerCase();
  const allowed = spec.ext.split(",");
  if (!ext || !allowed.includes(ext)) {
    throw new HttpError(400, `unsupported file type for this asset (allowed: ${spec.ext})`);
  }
  return ext;
};

export function createApiRouter({ storage, cardStore }) {
  const router = express.Router();

  // ------------------------------------------------------------- upload tickets

  router.post(
    "/upload-ticket",
    asyncRoute(async (req, res) => {
      const { assets, files } = req.body ?? {};
      const kinds = parseAssetList(assets);
      const fileInfo = Array.isArray(files) ? files : [];
      if (fileInfo.length !== kinds.length) {
        throw new HttpError(400, "files must supply one entry per requested asset");
      }

      const cardId = newCardId();
      const tickets = [];

      for (let i = 0; i < kinds.length; i++) {
        const kind = kinds[i];
        const spec = ASSETS[kind];
        const info = fileInfo[i];
        const ext = pickExt(info?.name, spec);

        const declaredSize = Number(info?.size ?? 0);
        if (Number.isFinite(declaredSize) && declaredSize > spec.maxBytes) {
          throw new HttpError(413, describeTooLarge(kind, declaredSize, spec.maxBytes));
        }

        const key = cardKey(cardId, kind, ext);
        const ticket = await storage.createUploadTicket(key, {
          contentType: info?.type || undefined,
        });
        tickets.push({
          kind,
          key: ticket.key,
          uploadUrl: ticket.uploadUrl,
          method: ticket.method,
          headers: ticket.headers,
          maxBytes: spec.maxBytes,
        });
      }

      res.json({ cardId, tickets });
    })
  );

  // ------------------------------------------------------------------ finalize

  router.post(
    "/cards",
    asyncRoute(async (req, res) => {
      const { cardId, photoKey, videoKey, mindKey, title, videoAspect, trackingPoints } =
        req.body ?? {};

      if (!isCardId(cardId)) throw new HttpError(400, "invalid card id");

      // Keys must belong to this card. Without this check a caller could point a card
      // at another card's objects -- and, once deletion exists, delete them.
      const expected = {
        photoKey: assertOwnKey(photoKey, cardId, "photo"),
        videoKey: assertOwnKey(videoKey, cardId, "video"),
        mindKey: assertOwnKey(mindKey, cardId, "mind"),
      };

      // Trust-but-record video geometry: the browser measured it from the MP4 moov box
      // (public/js/ar/mp4-meta.js). When the bytes are readable we re-derive the aspect
      // ratio server-side and reject anything that is not a browser-playable codec --
      // HEVC uploads otherwise produce a silently black AR screen on Android Chrome.
      // With R2 the adapter has no partial read, so this verification is skipped rather
      // than downloading a whole video to sniff its header; the browser probe already
      // rejected bad codecs before the upload started.
      let aspect = Number(videoAspect);
      if (typeof storage.getObject === "function") {
        const object = await storage.getObject(expected.videoKey);
        if (!object) throw new HttpError(400, "video object was not uploaded");
        const probe = inspectMp4Header(object.bytes.subarray(0, 256 * 1024));
        if (probe.ok && probe.width && probe.height) {
          aspect = probe.width / probe.height;
        } else if (!probe.ok && !probe.incomplete) {
          throw new HttpError(400, `video rejected: ${probe.reason}`, { rejected: "video" });
        }
      }

      const card = {
        id: cardId,
        ownerToken: newOwnerToken(),
        title: String(title ?? "").slice(0, 120),
        createdAt: Date.now(),
        ...expected,
        videoAspect: Number.isFinite(aspect) && aspect > 0 ? aspect : null,
        trackingPoints: Number.isFinite(Number(trackingPoints)) ? Number(trackingPoints) : null,
      };

      await cardStore.createCard(card);
      res.status(201).json({ id: card.id, ownerToken: card.ownerToken });
    })
  );

  // --------------------------------------------------------------------- read

  router.get(
    "/cards/:id",
    asyncRoute(async (req, res) => {
      const card = await cardStore.getCard(req.params.id);
      if (!card) throw new HttpError(404, "card not found");

      const body = publicCard(card);
      body.photoUrl = await resolveUrl(storage, card.photoKey);
      body.videoUrl = await resolveUrl(storage, card.videoKey);
      body.mindUrl = await resolveUrl(storage, card.mindKey);

      // The creator's own browser keeps the owner token in localStorage, so it is safe
      // to hand it back to anyone who already has it -- but never derive it from the
      // share id, which would make every link a deletion credential.
      if (req.query.owner === "1" && sameToken(req.headers["x-owner-token"], card.ownerToken)) {
        body.ownerToken = card.ownerToken;
      }

      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    })
  );

  // ------------------------------------------------------------------- delete

  router.delete(
    "/cards/:id",
    asyncRoute(async (req, res) => {
      const card = await cardStore.getCard(req.params.id);
      if (!card) throw new HttpError(404, "card not found");

      if (!sameToken(req.headers["x-owner-token"], card.ownerToken)) {
        throw new HttpError(403, "not allowed to delete this card");
      }

      // Storage first: if an object delete fails we still want the metadata gone so the
      // link stops working, and orphans are recoverable while a live broken card is not.
      const results = await Promise.allSettled([
        storage.deleteObject(card.photoKey),
        storage.deleteObject(card.videoKey),
        storage.deleteObject(card.mindKey),
      ]);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length) {
        console.error("[cards] object cleanup failed", failures.map((f) => f.reason?.message));
      }

      await cardStore.deleteCard(card.id);
      res.json({ ok: true, objectsDeleted: results.length - failures.length });
    })
  );

  return router;
}

// -------------------------------------------------------------------- helpers

const describeTooLarge = (kind, size, max) =>
  `${kind} is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${(max / 1024 / 1024).toFixed(0)}MB limit`;

/** Object keys are `<prefix>/<cardId>/<kind>.<ext>`; reject anything else. */
function assertOwnKey(key, cardId, kind) {
  const value = String(key ?? "");
  if (!value.startsWith(`cards/${cardId}/`)) {
    throw new HttpError(400, `${kind} object does not belong to this card`);
  }
  if (!value.slice(`cards/${cardId}/`.length).startsWith(`${kind}.`)) {
    throw new HttpError(400, `${kind} object key does not match its asset kind`);
  }
  return value;
}

const resolveUrl = (storage, key) =>
  typeof storage.readUrl === "function"
    ? storage.readUrl(key)
    : Promise.resolve(storage.publicUrl(key));

/** Constant-time-ish comparison for owner tokens. */
function sameToken(provided, expected) {
  const a = String(provided ?? "");
  const b = String(expected ?? "");
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
