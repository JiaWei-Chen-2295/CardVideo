// Generate the local fixture assets used for end-to-end testing:
//
//   1. a high-texture test photo (PNG) that is actually trackable -- it mixes
//      multi-octave irregular noise with overlaid structure, because a pure noise
//      field and a perfectly regular pattern BOTH fail mind-ar for opposite reasons
//      (see DESIGN.md §5.2).
//   2. a short H.264 MP4 with a frame counter burned in, so playback is visually
//      verifiable in the AR screen.
//
// The PNG is written by hand (zlib + CRC32) rather than with an image library:
// this machine's sandbox blocks npm lifecycle scripts, so `sharp`/`canvas` cannot
// install (DESIGN.md §7). A PNG encoder for 8-bit greyscale is ~40 lines.
//
// ffmpeg is used for the video. If it is unavailable the script still emits the PNG
// and reports clearly that video generation was skipped.

import { deflateSync } from "node:zlib";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data", "fixtures");
await mkdir(outDir, { recursive: true });

// ----------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
};

/** Encode 8-bit greyscale pixels as a PNG buffer. */
function encodeGreyPng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline needs a filter byte prefix; filter 0 (None) keeps this simple.
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- target photo art

/**
 * Build a trackable test photo.
 *
 * Composition: blurred multi-octave noise (gives dense, irregular, non-repeating
 * gradients) + high-contrast geometric structure + scattered blobs (gives stable
 * corners and edges). Deliberately avoids large flat areas and any repeating lattice,
 * both of which mind-ar's feature extractor rejects.
 */
function buildTargetPhoto(width, height) {
  const pixels = Buffer.alloc(width * height);

  let seed = 20240920;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  // Four octaves of value noise, bilinearly sampled.
  const octaves = [];
  for (let o = 0; o < 5; o++) {
    const s = 6 << o;
    const grid = new Float32Array(s * s);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    octaves.push({ s, grid });
  }

  const sampleOctave = ({ s, grid }, u, v) => {
    const fx = u * s;
    const fy = v * s;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const xa = ((x0 % s) + s) % s;
    const ya = ((y0 % s) + s) % s;
    const xb = (xa + 1) % s;
    const yb = (ya + 1) % s;
    const a = grid[ya * s + xa] * (1 - tx) + grid[ya * s + xb] * tx;
    const b = grid[yb * s + xa] * (1 - tx) + grid[yb * s + xb] * tx;
    return a * (1 - ty) + b * ty;
  };

  // Scattered blobs give strong, well-distributed corners.
  const blobs = [];
  for (let i = 0; i < 70; i++) {
    blobs.push({
      x: rnd() * width,
      y: rnd() * height,
      r: 8 + rnd() * 46,
      sign: rnd() < 0.5 ? -1 : 1,
    });
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;

      let value = 0;
      let amp = 0.5;
      for (const octave of octaves) {
        value += sampleOctave(octave, u, v) * amp;
        amp *= 0.55;
      }
      value = (value - 0.28) * 1.7; // stretch contrast

      for (const blob of blobs) {
        const dx = x - blob.x;
        const dy = y - blob.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < blob.r) {
          const falloff = 1 - dist / blob.r;
          value += blob.sign * falloff * falloff * 0.42;
        }
      }

      // A few hard-edged bars: guarantees unambiguous straight edges for the
      // homography estimator to lock onto.
      if ((x > width * 0.08 && x < width * 0.12) || (y > height * 0.86 && y < height * 0.9)) {
        value += 0.35;
      }
      if (x > width * 0.62 && x < width * 0.66 && y < height * 0.45) {
        value -= 0.4;
      }

      pixels[y * width + x] = Math.max(0, Math.min(255, Math.round(value * 255)));
    }
  }

  return pixels;
}

const TARGET_W = 1024;
const TARGET_H = 768;
const photoPath = join(outDir, "test-target.png");
await writeFile(photoPath, encodeGreyPng(buildTargetPhoto(TARGET_W, TARGET_H), TARGET_W, TARGET_H));
console.log(`[fixtures] wrote ${photoPath} (${TARGET_W}x${TARGET_H})`);

// --------------------------------------------------------------- test video

// Probe ffmpeg up front. On this machine spawned executables can be blocked by the
// sandbox (DESIGN.md §7), so fail fast and skip the video rather than writing an
// 80MB raw intermediate that then goes nowhere.
const ffmpegProbe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
const ffmpegAvailable = !ffmpegProbe.error && ffmpegProbe.status === 0;

if (!ffmpegAvailable) {
  console.warn(
    "[fixtures] ffmpeg is not runnable here" +
      (ffmpegProbe.error ? ` (${ffmpegProbe.error.code})` : "") +
      "; skipping video fixture."
  );
  console.warn(
    "[fixtures] The photo fixture above is still valid. To generate the video, run " +
      "`node scripts/gen-fixtures.mjs` from an unsandboxed shell."
  );
  process.exit(0);
}

const VIDEO_W = 640;
const VIDEO_H = 360;
const FPS = 30;
const SECONDS = 4;
const frameCount = FPS * SECONDS;
const rawPath = join(outDir, "test-video.raw");
const videoPath = join(outDir, "test-video.mp4");

// Render frames as raw RGB and pipe them into ffmpeg. A moving bar plus a per-second
// colour shift makes it obvious in the AR view that the video is genuinely playing.
const raw = Buffer.alloc(VIDEO_W * VIDEO_H * 3);
for (let frame = 0; frame < frameCount; frame++) {
  const t = frame / FPS;
  const barX = Math.floor(((Math.sin(t * 1.6) + 1) / 2) * (VIDEO_W - 60));
  const phase = t / SECONDS;
  const baseR = Math.round(30 + 120 * phase);
  const baseG = Math.round(60 + 80 * (1 - phase));
  const baseB = Math.round(140 - 60 * phase);

  for (let y = 0; y < VIDEO_H; y++) {
    for (let x = 0; x < VIDEO_W; x++) {
      const i = (y * VIDEO_W + x) * 3;
      // Diagonal gradient background, so movement is visible even between bars.
      const g = ((x + y + frame * 3) % 255) / 255;
      let r = baseR + g * 60;
      let gg = baseG + g * 60;
      let b = baseB + g * 60;

      if (x >= barX && x < barX + 60) {
        r = 255;
        gg = 240;
        b = 120;
      }
      // Frame counter as a coarse 4x3 block grid, readable without a font.
      const digitBlock = 40;
      if (y < digitBlock && x < digitBlock * 6) {
        const cell = Math.floor(x / 20);
        const row = Math.floor(y / 20);
        const value = Math.floor(frame / 5) % 10;
        const pattern = [0b111, 0b101, 0b101, 0b101, 0b111][row] ?? 0;
        const on = (pattern >> (2 - (cell % 3))) & 1;
        const bright = on && cell < 3 && value >= 0;
        r = bright ? 255 : 20;
        gg = bright ? 255 : 20;
        b = bright ? 255 : 20;
      }
      raw[i] = Math.max(0, Math.min(255, Math.round(r)));
      raw[i + 1] = Math.max(0, Math.min(255, Math.round(gg)));
      raw[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
}

await writeFile(rawPath, raw);

const ffmpeg = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-s", `${VIDEO_W}x${VIDEO_H}`,
    "-r", String(FPS),
    "-i", rawPath,
    "-c:v", "libx264",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    videoPath,
  ],
  { encoding: "utf8" }
);

await rm(rawPath, { force: true });

if (ffmpeg.status === 0) {
  console.log(`[fixtures] wrote ${videoPath} (${VIDEO_W}x${VIDEO_H}, ${SECONDS}s, H.264 baseline)`);
} else {
  console.warn("[fixtures] ffmpeg failed; video fixture not generated.");
  console.warn(ffmpeg.stderr?.split("\n").slice(-6).join("\n") ?? "(no stderr)");
  process.exitCode = 1;
}
