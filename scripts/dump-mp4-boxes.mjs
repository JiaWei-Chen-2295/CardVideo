// Recursively dump the box tree of an MP4 and compare two files.
//
// The flat top-level listing was not enough: a container problem that makes Chromium reject a
// whole file lives in the NESTED boxes. This walks the tree the way a demuxer does and prints
// every box with its absolute offset, so a stray or malformed box stands out immediately.
//
// usage: node scripts/dump-mp4-boxes.mjs <file> [--compare <file2>]

import { readFile } from "node:fs/promises";

const CONTAINERS = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst",
  "moof", "traf", "mvex", "stsd", "wave", "sinf", "schi", "----",
]);

/**
 * Walk boxes in [start, end). `stsd` needs special handling: its payload starts with a
 * version/count header before child boxes, and its children are codec sample entries whose
 * own payloads are NOT box lists (a fixed header, then nested boxes).
 */
function walk(buf, start, end, depth, out) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    let header = 8;

    if (size === 1) {
      if (o + 16 > end) {
        out.push({ depth, offset: o, type, size: end - o, note: "TRUNCATED 64-bit size" });
        return;
      }
      size = buf.readUInt32BE(o + 8) * 2 ** 32 + buf.readUInt32BE(o + 12);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }

    if (size < header || o + size > end) {
      out.push({
        depth,
        offset: o,
        type,
        size,
        note: `INVALID (extends past parent: box end ${o + size} > ${end})`,
      });
      return;
    }

    const printable = /^[\x20-\x7e]{4}$/.test(type);
    out.push({
      depth,
      offset: o,
      type,
      size,
      note: printable ? "" : "NON-ASCII TYPE",
    });

    const childStart = o + header;
    const childEnd = o + size;

    if (type === "stsd") {
      // version(1) + flags(3) + entry_count(4), then sample entries.
      if (childEnd - childStart > 8) {
        walk(buf, childStart + 8, childEnd, depth + 1, out);
      }
    } else if (CONTAINERS.has(type) || (!printable && size > header)) {
      // meta and ---- have a 4-byte version/flags prefix before children.
      const skip = type === "meta" || type === "----" ? 4 : 0;
      if (childEnd - childStart > skip) walk(buf, childStart + skip, childEnd, depth + 1, out);
    }

    o += size;
  }
  if (o !== end) {
    out.push({ depth, offset: o, type: "(trailing)", size: end - o, note: `unparsed ${end - o} bytes` });
  }
}

const dump = async (path) => {
  const buf = await readFile(path);
  const out = [];
  walk(buf, 0, buf.length, 0, out);
  return { buf, out };
};

const render = (out) =>
  out
    .map(
      (b) =>
        `${"  ".repeat(b.depth)}${String(b.offset).padStart(10)}  ${b.type.padEnd(6)} ${String(b.size).padStart(10)}${b.note ? `   <-- ${b.note}` : ""}`
    )
    .join("\n");

const fileA = process.argv[2];
const compareIndex = process.argv.indexOf("--compare");
const fileB = compareIndex > 0 ? process.argv[compareIndex + 1] : null;

if (!fileA) {
  console.error("usage: node scripts/dump-mp4-boxes.mjs <file> [--compare <file2>]");
  process.exit(2);
}

const a = await dump(fileA);
console.log(`=== ${fileA} (${(a.buf.length / 1024 / 1024).toFixed(1)} MB) ===`);
console.log(render(a.out));

if (fileB) {
  const b = await dump(fileB);
  console.log(`\n=== ${fileB} (${(b.buf.length / 1024 / 1024).toFixed(1)} MB) ===`);
  console.log(render(b.out));

  // Structural diff: compare the sequence of box paths, ignoring sizes and offsets, so real
  // differences in WHAT boxes exist are visible.
  const shape = (list) => {
    const stack = [];
    const paths = [];
    for (const box of list) {
      stack.length = box.depth;
      stack[box.depth] = box.type;
      paths.push(stack.slice(0, box.depth + 1).join("/"));
    }
    return paths;
  };
  const sa = new Set(shape(a.out));
  const sb = new Set(shape(b.out));

  console.log("\n=== structural differences ===");
  const onlyA = [...sa].filter((p) => !sb.has(p));
  const onlyB = [...sb].filter((p) => !sa.has(p));
  if (!onlyA.length && !onlyB.length) console.log("  box paths are identical");
  for (const p of onlyA) console.log(`  only in A: ${p}`);
  for (const p of onlyB) console.log(`  only in B: ${p}`);
}
