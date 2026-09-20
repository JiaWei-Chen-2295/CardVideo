// Verify that stripping tracks produces a file whose sample index is still correct.
//
// THE BUG THIS EXISTS FOR
// `stco` chunk offsets are ABSOLUTE file offsets. Removing a track shrinks `moov`, which moves
// `mdat` -- and every sample in it -- earlier by that many bytes. The first implementation left the
// offsets untouched, and it still looked plausible from the outside: correct box structure,
// byte-identical `mdat`, slightly smaller file. ffmpeg then reported "Invalid NAL unit size" for
// nearly every sample, and the browser produced nothing usable.
//
// Worse, an earlier version of THIS test asserted the wrong invariant -- that a byte-identical
// `mdat` kept the offsets valid, which only holds if nothing before `mdat` changes size. It passed
// a broken implementation. So the checks here are about what a DECODER needs, not about what looks
// unchanged:
//
//   1. every chunk offset lands inside the new `mdat` payload;
//   2. the offsets were actually shifted by the change in `moov` size;
//   3. ffmpeg can decode the result without errors.

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { stripAudioTrack, stripVideoTrack } from "../server/lib/stripAudio.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Direct children of a container. */
function children(buf, payloadStart, end) {
  const out = [];
  let o = payloadStart;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = buf.readUInt32BE(o + 8) * 2 ** 32 + buf.readUInt32BE(o + 12);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type, start: o, payloadStart: o + header, end: o + size });
    o += size;
  }
  return out;
}

const findIn = (buf, node, wanted) => children(buf, node.payloadStart, node.end).find((c) => c.type === wanted);

/** Per-track handler, chunk offsets (all of them), and the mdat extent. */
function analyse(buf) {
  const top = children(buf, 0, buf.length);
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!moov) throw new Error("no moov");

  const tracks = [];
  for (const trak of children(buf, moov.payloadStart, moov.end)) {
    if (trak.type !== "trak") continue;

    const mdia = findIn(buf, trak, "mdia");
    const hdlr = mdia && findIn(buf, mdia, "hdlr");
    const handler = hdlr ? buf.toString("latin1", hdlr.payloadStart + 8, hdlr.payloadStart + 12) : "?";

    const minf = mdia && findIn(buf, mdia, "minf");
    const stbl = minf && findIn(buf, minf, "stbl");
    const stco = stbl && findIn(buf, stbl, "stco");
    const co64 = stbl && findIn(buf, stbl, "co64");

    const offsets = [];
    if (stco) {
      const count = buf.readUInt32BE(stco.payloadStart + 4);
      for (let i = 0; i < count; i++) offsets.push(buf.readUInt32BE(stco.payloadStart + 8 + i * 4));
    } else if (co64) {
      const count = buf.readUInt32BE(co64.payloadStart + 4);
      for (let i = 0; i < count; i++) {
        const at = co64.payloadStart + 8 + i * 8;
        offsets.push(buf.readUInt32BE(at) * 2 ** 32 + buf.readUInt32BE(at + 4));
      }
    }
    tracks.push({ handler, offsets });
  }

  return { moov, mdat, mdatPayloadStart: mdat.payloadStart, mdatEnd: mdat.end, tracks };
}

/** Decode with ffmpeg and report whether it complained. */
function ffmpegDecode(path) {
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { available: false };

  const run = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", path, "-f", "null", "-"],
    { encoding: "utf8" }
  );
  return { available: true, ok: run.status === 0, errors: (run.stderr ?? "").trim() };
}

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error("usage: node scripts/test-track-split.mjs <source.mp4>");
  process.exit(2);
}

const source = await readFile(sourcePath);
console.log(`\nsource: ${sourcePath} (${(source.length / 1024 / 1024).toFixed(1)} MB)`);

const baseline = analyse(source);
console.log(`  moov ${baseline.moov.end - baseline.moov.start} bytes, mdat payload at ${baseline.mdatPayloadStart}`);
for (const track of baseline.tracks) {
  console.log(`  ${track.handler}: ${track.offsets.length} chunks`);
}

const workDir = await mkdtemp(join(tmpdir(), "cardvideo-split-"));

try {
  // ------------------------------------------------------------------ video only
  console.log("\n--- strip video track (keep audio) ---");
  {
    const { buffer, removed, patchedTables, delta } = stripVideoTrack(source);
    const out = analyse(buffer);

    check("removed exactly one track", removed === 1, String(removed));
    check("only the audio track remains", out.tracks.length === 1 && out.tracks[0].handler === "soun", out.tracks.map((t) => t.handler).join(","));
    check("chunk offset tables were patched", patchedTables > 0, `${patchedTables} table(s)`);
    check("moov size changed (so offsets MUST move)", delta !== 0, `delta ${delta}`);

    const audio = out.tracks[0];
    const inRange = audio.offsets.filter((v) => v >= out.mdatPayloadStart && v < out.mdatEnd).length;
    check(
      "every audio chunk offset lands inside the new mdat",
      inRange === audio.offsets.length,
      `${inRange}/${audio.offsets.length}`
    );

    const expected = baseline.tracks.find((t) => t.handler === "soun").offsets;
    const shifted = audio.offsets.every((v, i) => v === expected[i] + delta);
    check("offsets are the originals shifted by the moov size change", shifted);

    const file = join(workDir, "audio-only.mp4");
    await writeFile(file, buffer);
    const decode = ffmpegDecode(file);
    if (!decode.available) {
      console.log("  SKIP  ffmpeg not available, cannot verify decoding");
    } else {
      check("ffmpeg decodes the audio-only file without errors", decode.ok, decode.errors.split("\n").slice(0, 3).join(" | "));
    }
  }

  // ------------------------------------------------------------------ audio only
  console.log("\n--- strip audio track (keep video) ---");
  {
    const { buffer, removed, patchedTables, delta } = stripAudioTrack(source);
    const out = analyse(buffer);

    check("removed exactly one track", removed === 1, String(removed));
    check("only the video track remains", out.tracks.length === 1 && out.tracks[0].handler === "vide", out.tracks.map((t) => t.handler).join(","));
    check("chunk offset tables were patched", patchedTables > 0, `${patchedTables} table(s)`);

    const video = out.tracks[0];
    const inRange = video.offsets.filter((v) => v >= out.mdatPayloadStart && v < out.mdatEnd).length;
    check(
      "every video chunk offset lands inside the new mdat",
      inRange === video.offsets.length,
      `${inRange}/${video.offsets.length}`
    );

    const expected = baseline.tracks.find((t) => t.handler === "vide").offsets;
    const shifted = video.offsets.every((v, i) => v === expected[i] + delta);
    check("offsets are the originals shifted by the moov size change", shifted);

    const file = join(workDir, "video-only.mp4");
    await writeFile(file, buffer);
    const decode = ffmpegDecode(file);
    if (!decode.available) {
      console.log("  SKIP  ffmpeg not available, cannot verify decoding");
    } else {
      check("ffmpeg decodes the video-only file without errors", decode.ok, decode.errors.split("\n").slice(0, 3).join(" | "));
    }
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nTrack splitting is sound.\n" : `\n${failures} check(s) FAILED.\n`);
process.exitCode = failures === 0 ? 0 : 1;
