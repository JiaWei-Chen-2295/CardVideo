// Small shared helpers: config, id generation, and a single place where the
// "is this photo usable as an AR target" heuristic lives.
//
// IMPORTANT: the authoritative version of that heuristic runs in the browser
// (public/js/ar/precheck.js), because it needs the raw pixels. This module holds only
// the thresholds and the copy the server and the UI must agree on.

import { randomBytes } from "node:crypto";

// --------------------------------------------------------------------- constants

/** Design decision P12: acceptance is measured at 25-45cm on an A5 print. */
export const ACCEPTANCE = {
  minA5ShortSideCm: 10,
  distanceCm: [25, 45],
};

/**
 * Minimum dimension of the *uploaded* photo.
 *
 * mind-ar builds its tracking images by scaling the photo so that min(width, height)
 * equals 256px and 128px (see mind-ar/src/image-target/image-list.js). A photo whose
 * short side is already below ~256px would be *upsampled*, inventing no real detail,
 * so tracking features would be unreliable. [measured] a 512x384 target still yields
 * 18/28 features, so we keep the bar there and reject anything smaller.
 */
export const MIN_SHORT_SIDE_PX = 256;

/**
 * Authoritative tracking-feature floor, applied to the compiled .mind payload.
 *
 * mind-ar extracts features at two scales (min side downscaled to 256px and 128px).
 * [measured] a synthetic 1600x1200 natural-texture target produced 25/29 features;
 * a 512x384 target produced 18/28; a perfectly regular checkerboard produced 0/0
 * (mind-ar's self-similarity suppression discards repetitive patterns).
 *
 * So a healthy target in our tests sat at >=18 per scale. We require a much lower bar
 * than that because these numbers came from synthetic images, not real photographs --
 * thresholds must be recalibrated against real photos before launch (DESIGN.md §9-A1).
 */
export const MIN_TRACKING_POINTS = 8;

// ------------------------------------------------------------------------- ids

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * 12-character base62 id. 62^12 ~= 3.2e21, so links are unguessable -- which is the
 * whole access-control model (DESIGN.md §6.3), and why deletion exists (Q5).
 */
export function newCardId(length = 12) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/**
 * Separate, equally unguessable token for the owner. The share link must NOT be able
 * to delete the card, so management gets its own secret.
 */
export function newOwnerToken() {
  return randomBytes(24).toString("base64url");
}

export const isCardId = (value) => /^[0-9A-Za-z]{12}$/.test(String(value ?? ""));

// -------------------------------------------------------------------- payloads

/** Public shape sent to the viewer. Deliberately excludes the owner token. */
export function publicCard(card) {
  return {
    id: card.id,
    title: card.title ?? "",
    createdAt: card.createdAt,
    photoUrl: card.photoUrl,
    videoUrl: card.videoUrl,
    mindUrl: card.mindUrl,
    videoAspect: card.videoAspect ?? null,
  };
}

/** Shape returned to the creator only. */
export function ownerCard(card) {
  return { ...publicCard(card), ownerToken: card.ownerToken };
}

// ---------------------------------------------------------------------- errors

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Wrap an async express handler so rejections reach the error middleware. */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
