// Strip the audio track out of an MP4 at the container level, without decoding anything.
//
// WHY THIS EXISTS
// A real phone turned out to have NO AAC decoder: every audio-bearing variant of a video failed
// with `DEMUXER_ERROR_DETECTED_AAC`, including one whose audio had just been re-encoded to clean
// AAC-LC, while the video-only variant played perfectly. That is a property of the browser, not of
// the file, so re-encoding can never fix it.
//
// Rather than fail the whole card, the app can offer a silent version: the picture is what the AR
// screen is for, and a viewer would rather see it than be told their browser is wrong.
//
// HOW IT WORKS
// An MP4's `moov` box holds one `trak` per stream. Removing the audio `trak` leaves a valid
// video-only file. This runs on the metadata box alone -- the `mdat` payload is never read, and
// no frame is decoded -- so it is fast and works regardless of codec.
//
// The `mdat` size is deliberately NOT rewritten. `stco` offsets are absolute file offsets, so
// rewriting the size field would shift every sample and invalidate the whole index. Keeping the
// size and leaving the now-unreferenced audio bytes in place costs disk space and nothing else,
// and it is what makes this operation safe.

import { HttpError } from "./config.js";

/** Read a box header at `offset`. Returns null when there is no complete box there. */
function readBoxHeader(buf, offset, limit) {
  if (offset + 8 > limit) return null;

  let size = buf.readUInt32BE(offset);
  const type = buf.toString("latin1", offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > limit) return null;
    const hi = buf.readUInt32BE(offset + 8);
    const lo = buf.readUInt32BE(offset + 12);
    size = hi * 2 ** 32 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }

  if (size < headerSize || offset + size > limit) return null;
  return { type, size, headerSize, start: offset, payloadStart: offset + headerSize, end: offset + size };
}

/** Encode a 32-bit big-endian size, or the 64-bit extended form when it does not fit. */
function encodeSize(size) {
  if (size < 0xffffffff) {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(size);
    return out;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32BE(Math.floor(size / 2 ** 32), 0);
  out.writeUInt32BE(size % 2 ** 32, 4);
  return out;
}

/** All direct child boxes of a container box. */
function childBoxes(buf, parent) {
  const out = [];
  let offset = parent.payloadStart;
  while (offset < parent.end) {
    const box = readBoxHeader(buf, offset, parent.end);
    if (!box) break;
    out.push(box);
    offset = box.end;
  }
  return out;
}

/** Replace a box's payload while preserving its type and header width. */
function rebuildBox(buf, box, newPayload) {
  const type = Buffer.from(box.type, "latin1");
  const usesExtendedSize = box.headerSize === 16;
  const headerSize = usesExtendedSize ? 16 : 8;

  const size = headerSize + newPayload.length;
  if (!usesExtendedSize && size >= 0xffffffff) {
    throw new HttpError(413, "rebuilt box would need a 64-bit header");
  }

  const header = Buffer.concat([encodeSize(size), type]);
  const padded = usesExtendedSize
    ? Buffer.concat([header.subarray(0, 8), Buffer.alloc(8), type]).subarray(0, 16)
    : header;

  return Buffer.concat([padded, newPayload]);
}

/**
 * Which stream a `trak` describes: "vide", "soun", or whatever the handler says.
 * Path: trak > mdia > hdlr, whose payload holds the handler type at byte 8.
 */
function trackHandlerType(buf, trak) {
  const mdia = childBoxes(buf, trak).find((b) => b.type === "mdia");
  if (!mdia) return null;
  const hdlr = childBoxes(buf, mdia).find((b) => b.type === "hdlr");
  if (!hdlr || hdlr.payloadStart + 12 > hdlr.end) return null;
  return buf.toString("latin1", hdlr.payloadStart + 8, hdlr.payloadStart + 12);
}

/**
 * Shift every chunk offset in a track's `stco` (32-bit) and `co64` (64-bit) tables by `delta`.
 *
 * THIS IS THE PART THAT IS EASY TO GET WRONG, AND IT WAS
 * `stco`/`co64` entries are ABSOLUTE offsets into the file. Removing a track makes `moov` smaller,
 * which moves `mdat` and every sample in it earlier by exactly that many bytes -- so every kept
 * track's offsets must be shifted by the same amount or the file indexes garbage. The first
 * version of this module skipped this step and still looked plausible: the box structure was
 * correct, `mdat` was byte-identical, and the file was even slightly smaller. ffmpeg then reported
 * "Invalid NAL unit size" for nearly every video sample. An earlier version of the test asserted
 * the WRONG invariant -- that a byte-identical `mdat` kept the offsets valid, which is only true if
 * nothing before `mdat` changes size -- and so it passed a broken implementation.
 */
function shiftChunkOffsets(buf, node, delta) {
  // stco: version/flags (4) + entry_count (4) + entries (4 bytes each)
  if (node.type === "stco") {
    const count = buf.readUInt32BE(node.payloadStart + 4);
    const available = Math.floor((node.end - (node.payloadStart + 8)) / 4);
    for (let i = 0; i < Math.min(count, available); i++) {
      const at = node.payloadStart + 8 + i * 4;
      buf.writeUInt32BE(buf.readUInt32BE(at) + delta, at);
    }
    return 1;
  }

  // co64: version/flags (4) + entry_count (4) + entries (8 bytes each)
  if (node.type === "co64") {
    const count = buf.readUInt32BE(node.payloadStart + 4);
    const available = Math.floor((node.end - (node.payloadStart + 8)) / 8);
    for (let i = 0; i < Math.min(count, available); i++) {
      const at = node.payloadStart + 8 + i * 8;
      const value = buf.readUInt32BE(at) * 2 ** 32 + buf.readUInt32BE(at + 4);
      const shifted = value + delta;
      buf.writeUInt32BE(Math.floor(shifted / 2 ** 32), at);
      buf.writeUInt32BE(shifted % 2 ** 32, at + 4);
    }
    return 1;
  }

  // Recurse into containers. Only trak subtrees hold sample tables, and this walks everything, so
  // a table nested somewhere unexpected is still found.
  let patched = 0;
  for (const child of childBoxes(buf, node)) {
    patched += shiftChunkOffsets(buf, child, delta);
  }
  return patched;
}

/**
 * Remove every track whose handler type is in `drop`, using only the box tree.
 *
 * Box surgery rather than transcoding: `moov` holds one `trak` per stream, and the `mdat` payload
 * is never read, so this works for any codec and takes milliseconds.
 *
 * The `mdat` size is left alone, and its now-unreferenced bytes stay on disk. Rewriting the size
 * would move every sample, and the chunk-offset tables would have to be rewritten by the same
 * amount either way -- leaving it is the cheaper choice, at the cost of some wasted space.
 */
function stripTracks(input, drop) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);

  const ftyp = readBoxHeader(buf, 0, buf.length);
  if (!ftyp || ftyp.type !== "ftyp") throw new HttpError(400, "not an MP4 (no ftyp box)");

  // moov is normally first, but scan the top level so a moov-at-the-end file works too.
  let moov = null;
  let offset = 0;
  while (offset < buf.length) {
    const box = readBoxHeader(buf, offset, buf.length);
    if (!box) break;
    if (box.type === "moov") {
      moov = box;
      break;
    }
    offset = box.end;
  }
  if (!moov) throw new HttpError(400, "MP4 has no moov box");

  const children = childBoxes(buf, moov);
  const kept = [];
  const keptHandlers = [];
  let removed = 0;
  let droppedTracks = 0;

  for (const child of children) {
    if (child.type === "trak") {
      const handler = trackHandlerType(buf, child);
      if (drop.has(handler)) {
        removed++;
        continue;
      }
      if (handler === "soun" || handler === "vide") droppedTracks++;
      keptHandlers.push(handler);
    }
    kept.push(child);
  }

  if (removed === 0) {
    const want = [...drop].join("/");
    throw new HttpError(400, `this file has no ${want} track to remove`);
  }

  const newMoov = rebuildBox(buf, moov, Buffer.concat(kept.map((c) => buf.subarray(c.start, c.end))));

  // Chunk offsets are absolute, so shrinking moov moves every sample. Patch them before the file
  // is assembled -- see shiftChunkOffsets, which documents how this was missed the first time.
  const delta = newMoov.length - (moov.end - moov.start);
  let patchedTables = 0;
  if (delta !== 0) {
    const newMoovBox = {
      type: "moov",
      start: 0,
      payloadStart: newMoov.length >= 0xffffffff ? 16 : 8,
      end: newMoov.length,
    };
    patchedTables = shiftChunkOffsets(newMoov, newMoovBox, delta);
  }

  const pieces = [];
  offset = 0;
  while (offset < buf.length) {
    const box = readBoxHeader(buf, offset, buf.length);
    if (!box) {
      pieces.push(buf.subarray(offset));
      break;
    }
    if (box.type === "moov") pieces.push(newMoov);
    else pieces.push(buf.subarray(box.start, box.end));
    offset = box.end;
  }

  return { buffer: Buffer.concat(pieces), removed, keptHandlers, droppedTracks, patchedTables, delta };
}

/**
 * Remove every audio track from an MP4 buffer.
 *
 * @returns {{buffer: Buffer, removed: number}}
 * @throws {HttpError} when the buffer is not an MP4 or has no audio track to remove
 */
export function stripAudioTrack(input) {
  return stripTracks(input, new Set(["soun"]));
}

/**
 * Remove every video track, leaving an audio-only MP4.
 *
 * WHY THIS IS USEFUL
 * A real Android device could not decode AAC inside an MP4 that also had a video track, yet its
 * AAC decoder was demonstrably fine elsewhere (it played back audio it had just recorded, and
 * `canPlayType` reported full support). The trigger was the combination, not the codec.
 *
 * Splitting the tracks lets the viewer play the picture muted from one file and the sound from
 * another, which sidesteps the broken path without transcoding anything.
 */
export function stripVideoTrack(input) {
  return stripTracks(input, new Set(["vide"]));
}
