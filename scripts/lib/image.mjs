// Image I/O for the Node-side tooling.
//
// WHY FFMPEG AND NOT A NODE IMAGE LIBRARY
//
//   - `canvas` is in node_modules but its native binary was never built (npm lifecycle scripts
//     are blocked in this sandbox -- DESIGN.md §7), so it cannot decode anything.
//   - `sharp` cannot be installed for the same reason.
//
// ffmpeg is on PATH and does every decode, scale and encode this project needs.
//
// WHY NOTHING CAPTURES A CHILD'S OUTPUT
//
// `execFileSync` with the default `stdio: "pipe"` fails here with EPERM: the sandbox forbids the
// named pipes Node uses to capture a child's stdio. `stdio: "ignore"` works. So every call below
// asks ffmpeg to write a FILE and reads that file back afterwards -- never a pipe.
//
// PPM (P6, binary RGB) is the interchange format because it is trivial to parse and needs no
// library, and because it survives a round trip through ffmpeg byte-for-byte.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Scratch space for intermediate frames. Under `data/`, which is gitignored. */
export const CACHE_DIR = join(process.cwd(), "data", ".image-cache");

/** Run ffmpeg, capturing nothing. */
export function ffmpeg(args) {
  mkdirSync(CACHE_DIR, { recursive: true });
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore" });
}

/** Decode any image to an RGB byte plane. */
export function decodeRGB(file, { tag = "src" } = {}) {
  const out = join(CACHE_DIR, `${tag}.ppm`);
  ffmpeg(["-i", file, "-frames:v", "1", "-pix_fmt", "rgb24", out]);
  const buf = readFileSync(out);
  const { width, height, offset } = parsePpmHeader(buf);
  return { width, height, rgb: buf.subarray(offset, offset + width * height * 3) };
}

/**
 * Merge an RGB plane and an 8-bit alpha plane, writing a WebP (and optionally a PNG copy).
 *
 * The two planes are merged with ffmpeg's `alphamerge` rather than written as one PAM: it is one
 * more file on disk, but `alphamerge` is a core filter, whereas PAM support varies by build.
 *
 * @param {object} plane {width, height, rgb, alpha}
 * @param {string} webpPath output path for the alpha WebP (always written)
 * @param {object} [options]
 * @param {string} [options.pngPath] also write an alpha PNG here. Omitted by default: for the
 *   viewfinder frame the PNG is 1.96MB against 124KB for the WebP, and nothing serves it.
 */
export function encodeRGBA({ width, height, rgb, alpha }, webpPath, { quality = 82, pngPath = null } = {}) {
  const rgbPpm = join(CACHE_DIR, "rgba-rgb.ppm");
  const alphaPgm = join(CACHE_DIR, "rgba-alpha.pgm");
  const merged = join(CACHE_DIR, "rgba-merged.png");

  writePpm(rgbPpm, { width, height, rgb });
  writePgm(alphaPgm, { width, height, alpha });

  ffmpeg([
    "-i", rgbPpm,
    "-i", alphaPgm,
    "-filter_complex", "[0][1]alphamerge",
    "-frames:v", "1",
    merged,
  ]);
  // WebP with alpha is typically 10-15x smaller than the equivalent PNG, which matters because
  // this asset sits on the AR critical path next to a ~4MB JavaScript bundle.
  mkdirSync(join(webpPath, ".."), { recursive: true });
  ffmpeg(["-i", merged, "-c:v", "libwebp", "-quality", String(quality), webpPath]);

  if (pngPath) {
    mkdirSync(join(pngPath, ".."), { recursive: true });
    copyFileSync(merged, pngPath);
  }
  return { merged };
}

/** Write a binary P6 PPM. */
export function writePpm(path, { width, height, rgb }) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  writeFileSync(path, Buffer.concat([header, Buffer.from(rgb.buffer ?? rgb, rgb.byteOffset ?? 0, width * height * 3)]));
}

/** Write a binary P5 PGM (8-bit greyscale) -- used as an alpha plane. */
export function writePgm(path, { width, height, alpha }) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii");
  writeFileSync(path, Buffer.concat([header, Buffer.from(alpha.buffer ?? alpha, alpha.byteOffset ?? 0, width * height)]));
}

/** Minimal P6 header parser: `P6 <w> <h> <maxval>`, whitespace-separated, `#` starts a comment. */
export function parsePpmHeader(buf) {
  const magic = String.fromCharCode(buf[0], buf[1]);
  if (magic !== "P6") throw new Error(`expected a P6 PPM, got "${magic}"`);

  const nums = [];
  let i = 2;
  while (nums.length < 3 && i < buf.length) {
    const c = String.fromCharCode(buf[i]);
    if (c === "#") {
      while (i < buf.length && buf[i] !== 0x0a) i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      let token = "";
      while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) token += String.fromCharCode(buf[i++]);
      nums.push(Number(token));
    }
  }

  const [width, height] = nums;
  if (!width || !height) throw new Error("could not parse PPM header");
  // Exactly one whitespace byte separates the header from the pixel data.
  return { width, height, offset: i + 1 };
}

/** File size in a human-readable unit. */
export function sizeLabel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : `${Math.round(bytes / 1024)}KB`;
}
