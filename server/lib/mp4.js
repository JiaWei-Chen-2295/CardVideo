// Minimal, dependency-free MP4 inspection: dimensions and duration.
//
// Why this exists: the AR screen's height is derived from the video's aspect ratio
// (DESIGN.md §4.3). The browser knows it cheaply via loadedmetadata, but the server
// should not simply trust a client-supplied value that changes the whole layout, and
// we also want to reject non-H.264 MP4s before they reach a viewer.
//
// Deliberately NOT using ffprobe: it is a heavy external binary, and this project
// targets serverless deployment where shipping one is impractical. Parsing the MP4
// box tree is enough for the few fields we need.

/** Read a 32-bit big-endian unsigned integer. */
const u32 = (buf, offset) => buf.readUInt32BE(offset);

/** Iterate the top-level boxes of an MP4/ISO-BMFF buffer. */
function* boxes(buf, start = 0, end = buf.length) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32(buf, offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      // 64-bit extended size; only the low 32 bits are usable here, which is fine
      // because we guard against absurd values below.
      if (offset + 16 > end) return;
      const hi = u32(buf, offset + 8);
      const lo = u32(buf, offset + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      // Box extends to the end of the enclosing container.
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) return;

    yield { type, start: offset + headerSize, end: offset + size, size };
    offset += size;
  }
}

/** Find the first direct child box of a given type. */
function findBox(buf, start, end, type) {
  for (const box of boxes(buf, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/**
 * Locate the first video track's sample table entry.
 * Path: moov > trak > mdia > minf > stbl > stsd > (avc1|hvc1|hev1|av01|vp09...)
 */
function findVideoSampleEntry(buf) {
  const moov = findBox(buf, 0, buf.length, "moov");
  if (!moov) return null;

  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = findBox(buf, trak.start, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = findBox(buf, mdia.start, mdia.end, "hdlr");
    if (!hdlr) continue;
    // handler_type sits 8 bytes into the hdlr payload (after version/flags + pre_defined).
    const handlerType = buf.toString("latin1", hdlr.start + 8, hdlr.start + 12);
    if (handlerType !== "vide") continue;

    const minf = findBox(buf, mdia.start, mdia.end, "minf");
    if (!minf) continue;
    const stbl = findBox(buf, minf.start, minf.end, "stbl");
    if (!stbl) continue;
    const stsd = findBox(buf, stbl.start, stbl.end, "stsd");
    if (!stsd) continue;

    // stsd payload: version/flags (4) + entry_count (4), then the sample entries.
    for (const entry of boxes(buf, stsd.start + 8, stsd.end)) {
      // VisualSampleEntry: 6 reserved + 2 data_reference_index, then 16 bytes of
      // pre_defined/reserved, then width/height as 16-bit values.
      const widthOffset = entry.start + 24;
      const heightOffset = entry.start + 26;
      if (heightOffset + 2 > entry.end) continue;
      return {
        codec: entry.type,
        width: buf.readUInt16BE(widthOffset),
        height: buf.readUInt16BE(heightOffset),
      };
    }
  }
  return null;
}

/** Duration from mvhd (timescale + duration). */
function readDurationSeconds(buf, moov) {
  const mvhd = findBox(buf, moov.start, moov.end, "mvhd");
  if (!mvhd || mvhd.end - mvhd.start < 20) return null;

  const version = buf.readUInt8(mvhd.start);
  if (version === 1) {
    if (mvhd.end - mvhd.start < 32) return null;
    const timescale = u32(buf, mvhd.start + 20);
    const hi = u32(buf, mvhd.start + 24);
    const lo = u32(buf, mvhd.start + 28);
    const duration = hi * 2 ** 32 + lo;
    return timescale ? duration / timescale : null;
  }
  const timescale = u32(buf, mvhd.start + 12);
  const duration = u32(buf, mvhd.start + 16);
  return timescale ? duration / timescale : null;
}

/**
 * Inspect an MP4 buffer.
 *
 * Returns { ok, codec, width, height, aspect, durationSeconds, reason }.
 * `ok` is false when the file is not a usable MP4 -- callers should reject uploads
 * with the given reason rather than guessing.
 *
 * `complete` should be false when the buffer is only a prefix of the file: a truncated
 * buffer is then reported as "incomplete" instead of "not an MP4", which matters because
 * servers only read the first chunk of a large upload to sniff its header.
 */
export function inspectMp4(buf, { complete = true } = {}) {
  if (!buf || buf.length < 16) {
    return { ok: false, reason: complete ? "file too small to be an MP4" : "incomplete header" };
  }
  const brand = buf.toString("latin1", 4, 8);
  if (brand !== "ftyp") return { ok: false, reason: "missing MP4 file signature (ftyp box)" };

  const moov = findBox(buf, 0, buf.length, "moov");
  if (!moov) {
    return {
      ok: false,
      reason: complete
        ? "MP4 has no moov box (file may be truncated)"
        : "moov box is not in the first chunk (re-export with faststart, or pass complete: true)",
      incomplete: !complete,
    };
  }

  const entry = findVideoSampleEntry(buf);
  if (!entry || !entry.width || !entry.height) {
    return { ok: false, reason: "could not find a video track in this MP4" };
  }

  // Browser-playable codecs. HEVC (hvc1/hev1) plays on Safari but NOT on Chrome for
  // Android, and WebGL texture upload from a non-decoding video yields a black screen
  // with no error -- so refusing it up front produces a far better failure than a
  // silently black AR screen.
  const PLAYABLE = new Set(["avc1", "avc3", "vp09", "av01"]);
  if (!PLAYABLE.has(entry.codec)) {
    const known = { hvc1: "HEVC/H.265", hev1: "HEVC/H.265", mp4v: "MPEG-4 Visual" };
    const label = known[entry.codec] ?? entry.codec;
    return {
      ok: false,
      codec: entry.codec,
      reason:
        `${label} video is not playable in all target browsers. ` +
        `Please export as H.264 (MP4) and upload again.`,
    };
  }

  const durationSeconds = readDurationSeconds(buf, moov);

  return {
    ok: true,
    codec: entry.codec,
    width: entry.width,
    height: entry.height,
    aspect: entry.width / entry.height,
    durationSeconds: durationSeconds ?? null,
  };
}

/**
 * Inspect only the beginning of an MP4.
 *
 * Used by the API when finalizing a card: the server holds a prefix of the upload, not
 * the whole file, so it cannot demand a parseable `moov` box that might live at the end.
 * A successful result confirms the bytes really are an H.264-class MP4 and yields the
 * authoritative aspect ratio; an `incomplete` result means "could not verify", which the
 * caller treats as softer than "verified bad".
 */
export function inspectMp4Header(prefix) {
  return inspectMp4(prefix, { complete: false });
}
