// Inspect a real MP4 the way the browser would, box by box.
//
// Written to answer one question about a specific file that the phone refused to decode:
// what is actually inside this container? The app's own header check only looks for `ftyp`,
// a video track and a playable codec; a file can satisfy all three and still be unplayable if
// the moov box sits at the end (no progressive playback), or if the track is fragmented, or if
// the audio codec is exotic.

import { readFile, stat } from "node:fs/promises";
import { inspectMp4 } from "../server/lib/mp4.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/inspect-video.mjs <file.mp4>");
  process.exit(2);
}

const info = await stat(path);
const buf = await readFile(path);

console.log(`file        ${path}`);
console.log(`size        ${buf.length} bytes (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);

// ---------------------------------------------------------------- top-level box map

const describeBox = (type) => {
  const known = {
    ftyp: "file type / brand",
    moov: "movie metadata (index)",
    mdat: "media data (the actual frames)",
    free: "padding",
    mfra: "movie fragment random access",
    moof: "movie fragment (fragmented MP4)",
    sidx: "segment index",
    wide: "placeholder",
  };
  return known[type] ?? "unknown";
};

console.log("\n--- top-level boxes (in file order) ---");
let offset = 0;
let moovOffset = null;
let mdatOffset = null;
let sawMoof = false;

while (offset + 8 <= buf.length) {
  let size = buf.readUInt32BE(offset);
  const type = buf.toString("latin1", offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > buf.length) break;
    size = buf.readUInt32BE(offset + 8) * 2 ** 32 + buf.readUInt32BE(offset + 12);
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }

  console.log(
    `  ${String(offset).padStart(10)}  ${type.padEnd(6)} ${String(size).padStart(10)}  ${describeBox(type)}`
  );

  if (type === "moov" && moovOffset === null) moovOffset = offset;
  if (type === "mdat" && mdatOffset === null) mdatOffset = offset;
  if (type === "moof") sawMoof = true;

  if (size < headerSize) break;
  offset += size;
}

// ------------------------------------------------------------- progressive playback

console.log("\n--- progressive playback (faststart) ---");
if (moovOffset === null) {
  console.log("  NO moov BOX AT ALL -- the file is truncated or not an MP4");
} else if (mdatOffset === null) {
  console.log(`  moov at ${moovOffset}, no mdat found`);
} else if (moovOffset < mdatOffset) {
  console.log(`  OK: moov (${moovOffset}) precedes mdat (${mdatOffset}) -- can stream and seek`);
} else {
  console.log(
    `  PROBLEM: moov (${moovOffset}) comes AFTER mdat (${mdatOffset}).\n` +
      `           The browser must download the whole ${(buf.length / 1024 / 1024).toFixed(1)}MB file before it can\n` +
      `           find any sample. Over LAN this looks like a stalled or black video.\n` +
      `           Fix: ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`
  );
}
if (sawMoof) {
  console.log("  NOTE: fragmented MP4 (moof boxes present); support varies by browser");
}

// ---------------------------------------------------------------- codec + geometry

console.log("\n--- stream info ---");
const probe = inspectMp4(buf);
console.log(`  ${JSON.stringify(probe, null, 2).split("\n").join("\n  ")}`);

// ----------------------------------------------------------------- audio track

console.log("\n--- tracks ---");
function* boxes(view, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = view.readUInt32BE(o);
    const type = view.toString("latin1", o + 4, o + 8);
    let headerSize = 8;
    if (size === 1) {
      size = view.readUInt32BE(o + 8) * 2 ** 32 + view.readUInt32BE(o + 12);
      headerSize = 16;
    } else if (size === 0) size = end - o;
    if (size < headerSize || o + size > end) return;
    yield { type, start: o + headerSize, end: o + size };
    o += size;
  }
}
const find = (start, end, type) => {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
};

const moov = moovOffset === null ? null : find(moovOffset + 8, Math.min(moovOffset + 8 + buf.readUInt32BE(moovOffset), buf.length), "moov")
  ?? { start: moovOffset + 8, end: Math.min(moovOffset + 8 + buf.readUInt32BE(moovOffset), buf.length) };

if (moov) {
  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = find(trak.start, trak.end, "mdia");
    if (!mdia) continue;
    const hdlr = find(mdia.start, mdia.end, "hdlr");
    const handler = hdlr ? buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) : "?";
    const minf = find(mdia.start, mdia.end, "minf");
    const stbl = minf ? find(minf.start, minf.end, "stbl") : null;
    const stsd = stbl ? find(stbl.start, stbl.end, "stsd") : null;
    const codecs = [];
    if (stsd) for (const entry of boxes(buf, stsd.start + 8, stsd.end)) codecs.push(entry.type);
    const label = { vide: "video", soun: "audio", sbtl: "subtitle", text: "text" }[handler] ?? handler;
    console.log(`  ${label.padEnd(8)} codec(s): ${codecs.join(", ") || "(none found)"}`);
  }
}
