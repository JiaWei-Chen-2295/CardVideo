// Decide whether a photo is usable as an AR tracking target -- BEFORE spending time on
// a full .mind compile and an upload.
//
// Why not just compile and look at the result: compilation runs mind-ar's matching pass
// over ~12 image scales using @tensorflow/tfjs, which costs seconds and megabytes. The
// tracking-feature extractor answers the same question in ~200ms with zero extra
// dependencies, so it acts as the gate and the compiler only ever sees candidates.
//
// It uses mind-ar's REAL extractor (vendored at /vendor/mindar-extract/extract.js), not a
// hand-rolled proxy heuristic. That matters, because the failure modes are not the ones
// people expect. [measured] BOTH of these produce exactly ZERO tracking features:
//
//   1. a flat image -- obviously, there is no detail to find;
//   2. per-pixel random noise -- because the extractor looks at the image downscaled to a
//      256px short side, so each output pixel is a box average of several source pixels and
//      the average of independent random samples converges on mid-grey;
//   3. a perfect checkerboard -- high contrast and plenty of edges, but mind-ar's
//      self-similarity suppression (MAX_SIM_THRESH / SD_THRESH in extract.js) discards
//      repetitive patterns wholesale.
//
// A contrast- or edge-count heuristic would pass (2) and (3) happily. Real photographs score
// in the 40s on the same measure, because blobs and edges survive downscaling.

import { extract } from "/vendor/mindar-extract/extract.js";

/** mind-ar's tracking pass uses exactly these two minimum-dimension sizes. */
export const TRACKING_SCALE_SIZES = [256, 128];

/** Reject below this many features at either scale. See server/lib/config.js for the rationale. */
export const MIN_TRACKING_POINTS = 8;

/**
 * Draw an image and read back its greyscale bytes.
 *
 * mind-ar's extractor takes a flat Uint8Array of grey values (row-major), which is what
 * `image.data` is everywhere inside mind-ar.
 */
function toGrey(image, width, height) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;

  const grey = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
    grey[i] = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3;
  }
  return grey;
}

/**
 * Nearest-box resize, mirroring mind-ar's own `resize()` in
 * mind-ar/src/image-target/utils/images.js so the pre-check sees the same pixels the
 * compiler would.
 */
function resizeGrey(source, ratio) {
  const width = Math.round(source.width * ratio);
  const height = Math.round(source.height * ratio);
  const out = new Uint8Array(width * height);
  const { data, width: sw } = source;

  for (let i = 0; i < width; i++) {
    let si1 = Math.round(i / ratio);
    let si2 = Math.round((i + 1) / ratio) - 1;
    if (si2 >= sw) si2 = sw - 1;
    for (let j = 0; j < height; j++) {
      let sj1 = Math.round(j / ratio);
      let sj2 = Math.round((j + 1) / ratio) - 1;
      if (sj2 >= source.height) sj2 = source.height - 1;

      let sum = 0;
      let count = 0;
      for (let ii = si1; ii <= si2; ii++) {
        for (let jj = sj1; jj <= sj2; jj++) {
          sum += data[jj * sw + ii];
          count++;
        }
      }
      out[j * width + i] = Math.floor(sum / Math.max(1, count));
    }
  }
  return { data: out, width, height };
}

/**
 * Raw tracking-feature counts for a photo, computed the same way mind-ar will compute
 * them during compilation.
 *
 * @returns {{ pointCounts: number[], minPoints: number, shortSide: number, scales: object[] }}
 */
export function measureTrackability(grey, width, height) {
  const shortSide = Math.min(width, height);
  const source = { data: grey, width, height };
  const scales = [];

  for (const targetShort of TRACKING_SCALE_SIZES) {
    const ratio = targetShort / shortSide;
    const scaled = resizeGrey(source, ratio);
    const points = extract({ ...scaled, scale: ratio });
    scales.push({
      targetShort,
      width: scaled.width,
      height: scaled.height,
      points: points.length,
    });
  }

  const pointCounts = scales.map((s) => s.points);
  return {
    pointCounts,
    minPoints: pointCounts.length ? Math.min(...pointCounts) : 0,
    shortSide,
    scales,
  };
}

/**
 * Run the pre-check on a decoded image.
 *
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} image
 * @returns {Promise<object>} verdict; `ok: false` carries a user-facing `message`
 */
export async function precheckImage(image) {
  const width = image.width ?? image.naturalWidth;
  const height = image.height ?? image.naturalHeight;

  if (!width || !height) {
    return { ok: false, code: "decode-failed", message: "无法读取这张照片，请换一张试试。" };
  }

  const grey = toGrey(image, width, height);
  const metrics = measureTrackability(grey, width, height);

  if (metrics.minPoints >= MIN_TRACKING_POINTS) {
    return { ok: true, metrics };
  }

  return {
    ok: false,
    code: metrics.minPoints === 0 ? "no-features" : "too-few-features",
    metrics,
    message:
      metrics.minPoints === 0
        ? "这张照片几乎没有可识别的特征点。纯色、大面积渐变、强烈虚化的照片无法被追踪；" +
          "带文字、花纹、树叶、砖墙、书架这类细节的照片可以。"
        : "这张照片的可识别特征点偏少，识别可能不稳定。建议换一张细节更丰富的照片，" +
          "或者给照片加一圈带纹理的边框。",
  };
}

/** Same as precheckImage but from a File/Blob (used by the upload inputs). */
export async function precheckFile(file) {
  const bitmap = await createImageBitmap(file);
  try {
    return await precheckImage(bitmap);
  } finally {
    bitmap.close?.();
  }
}
