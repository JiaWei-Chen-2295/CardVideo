// Turn a generated viewfinder frame into a transparent-centred overlay asset.
//
// WHAT THIS IS FOR
//
// The AR page fills the screen with the live camera feed and lays a decorative frame on top of
// it, so the frame asset must be a PNG/WebP with a HOLE in the middle -- otherwise the opaque
// panel the image generator drew there would cover the camera.
//
// The hole is not guessed. The generator is asked for a perfectly flat fill inside the window,
// so the window is found by walking outwards from the exact centre while pixels stay equal to
// the centre pixel. That is the same property the prompt demands ("no texture, no gradient"),
// so if detection is ambiguous, the artwork does not match the brief and the warnings below say
// so rather than silently producing a bad key.
//
// Usage:
//   node scripts/frame-alpha.mjs --in <generated.png> [--out public/frames/viewfinder]
//                                [--key 8,34] [--tolerance 8] [--dry-run]

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { decodeRGB, encodeRGBA, sizeLabel } from "./lib/image.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const input = arg("in");
const outBase = arg("out", join("public", "frames", "viewfinder"));
const [keyT0, keyT1] = String(arg("key", "8,34"))
  .split(",")
  .map((v) => Number(v.trim()));
const tolerance = Number(arg("tolerance", "8"));
const dryRun = argv.includes("--dry-run");

if (!input) {
  console.error("usage: node scripts/frame-alpha.mjs --in <generated.png> [--out public/frames/viewfinder] [--key 8,34] [--tolerance 8] [--dry-run]");
  process.exit(1);
}

// A representative portrait phone viewport, used only to predict how much of the frame survives
// `object-fit: cover`. iPhone-class CSS pixels; the ratio is what matters, not the absolute size.
const REFERENCE_VIEWPORT = { width: 390, height: 844 };

// ------------------------------------------------------------------- load & detect

const img = decodeRGB(input, { tag: "frame" });
const { width, height, rgb } = img;

console.log(`\n输入   ${input}`);
console.log(`       ${width} x ${height}   ${(width / height).toFixed(3)}:1   ${sizeLabel(statSync(input).size)}`);

const at = (x, y) => (y * width + x) * 3;

function detectWindow(tol) {
  const cx = width >> 1;
  const cy = height >> 1;
  const c = [rgb[at(cx, cy)], rgb[at(cx, cy) + 1], rgb[at(cx, cy) + 2]];
  const near = (x, y) => {
    const p = at(x, y);
    return (
      Math.abs(rgb[p] - c[0]) <= tol &&
      Math.abs(rgb[p + 1] - c[1]) <= tol &&
      Math.abs(rgb[p + 2] - c[2]) <= tol
    );
  };

  let x0 = cx;
  while (x0 > 0 && near(x0 - 1, cy)) x0--;
  let x1 = cx;
  while (x1 < width - 1 && near(x1 + 1, cy)) x1++;
  let y0 = cy;
  while (y0 > 0 && near(cx, y0 - 1)) y0--;
  let y1 = cy;
  while (y1 < height - 1 && near(cx, y1 + 1)) y1++;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, color: c, tol };
}

const win = detectWindow(tolerance);
const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const pct = (v, total) => ((v / total) * 100).toFixed(1);

console.log(`\n窗口   ${hex(win.color)}  (tolerance ±${tolerance})`);
console.log(`       x ${win.x0}..${win.x1}   y ${win.y0}..${win.y1}   ${win.w} x ${win.h} px   ${(win.w / win.h).toFixed(3)}:1`);
console.log(
  `       左右边带 ${pct(win.x0, width)}% / ${pct(width - 1 - win.x1, width)}%` +
    `   上下边带 ${pct(win.y0, height)}% / ${pct(height - 1 - win.y1, height)}%`
);

let warnings = 0;
const warn = (msg) => {
  console.log(`  ⚠  ${msg}`);
  warnings++;
};

// A window that failed to detect would be a sliver; one that over-ran would touch an edge.
if (win.w * win.h < width * height * 0.2) {
  warn(`窗口只占画面 ${pct(win.w * win.h, width * height)}%，检测几乎肯定失败了（提示词要求的"中间一块纯色空窗"没被生成出来？）`);
}
if (win.x0 === 0 || win.y0 === 0 || win.x1 === width - 1 || win.y1 === height - 1) {
  warn("窗口贴到了画布边缘，说明它一路走到底了 —— 要么窗口真的出血，要么检测越过了边界");
}

// Interior composition.
//
// The generator draws the viewfinder brackets INSIDE the window, so a naive "max deviation inside
// the window" reads the white bracket line as 243 levels of filth. What matters is the split into
// the three populations the key actually distinguishes:
//
//   dev <= t0        fully transparent  -- the flat fill, leaves nothing behind
//   t0 < dev < t1    partially transparent -- THE ONLY RESIDUE RISK: these pixels composite as a
//                    faint tint over the live camera feed
//   dev >= t1        fully opaque -- the brackets and any other detail, which is intended
{
  let flat = 0;
  let partial = 0;
  let detail = 0;
  let total = 0;

  for (let y = win.y0 + 2; y <= win.y1 - 2; y++) {
    for (let x = win.x0 + 2; x <= win.x1 - 2; x++) {
      const p = at(x, y);
      const dev = Math.max(
        Math.abs(rgb[p] - win.color[0]),
        Math.abs(rgb[p + 1] - win.color[1]),
        Math.abs(rgb[p + 2] - win.color[2])
      );
      total++;
      if (dev <= keyT0) flat++;
      else if (dev < keyT1) partial++;
      else detail++;
    }
  }

  console.log(
    `       窗口内部：纯底色 ${pct(flat, total)}%（全透明）  过渡带 ${pct(partial, total)}%（会有淡淡的残留）  ` +
      `细节 ${detail} px = ${pct(detail, total)}%（保留，浮在实时画面上，四角白线属于这里）`
  );
  if (partial / total > 0.01) {
    warn(
      `过渡带占 ${pct(partial, total)}%，说明窗口底色有渐变而不是纯色 —— 抠图后会在实时画面上留一层可见的膜。` +
        `建议重新生成，并把"绝对均匀的纯色填充"写得更重`
    );
  }
}

// Edge ambiguity: if the pixels just outside an edge are ALSO window-coloured, the walk probably
// stopped early rather than found a real edge.
{
  const sample = (points) =>
    points.reduce((worst, [x, y]) => {
      const p = at(x, y);
      return Math.max(
        worst,
        Math.abs(rgb[p] - win.color[0]),
        Math.abs(rgb[p + 1] - win.color[1]),
        Math.abs(rgb[p + 2] - win.color[2])
      );
    }, 0);

  const rows = [];
  for (let y = win.y0; y <= win.y1; y += Math.max(1, Math.round(win.h / 12))) rows.push(y);
  const cols = [];
  for (let x = win.x0; x <= win.x1; x += Math.max(1, Math.round(win.w / 12))) cols.push(x);

  const edges = {
    left: win.x0 > 4 ? sample(rows.map((y) => [win.x0 - 4, y])) : Infinity,
    right: win.x1 < width - 5 ? sample(rows.map((y) => [win.x1 + 4, y])) : Infinity,
    top: win.y0 > 4 ? sample(cols.map((x) => [x, win.y0 - 4])) : Infinity,
    bottom: win.y1 < height - 5 ? sample(cols.map((x) => [x, win.y1 + 4])) : Infinity,
  };
  console.log(
    `       紧贴窗口外的 4px：左 ${edges.left} 右 ${edges.right} 上 ${edges.top} 下 ${edges.bottom}（相对窗口色的最大偏差）`
  );
  for (const [name, dev] of Object.entries(edges)) {
    if (dev <= tolerance) warn(`${name} 边之外 4px 仍然是窗口色（偏差 ${dev}）—— 检测可能提前/滞后停在渐变上，边带会被多抠或少抠`);
  }
}

// ---------------------------------------------- predict how a phone crops this frame

const coverScale = Math.max(
  REFERENCE_VIEWPORT.width / width,
  REFERENCE_VIEWPORT.height / height
);
const cropSrcX = Math.max(0, (width * coverScale - REFERENCE_VIEWPORT.width) / 2 / coverScale);
const cropSrcY = Math.max(0, (height * coverScale - REFERENCE_VIEWPORT.height) / 2 / coverScale);

console.log(
  `\n竖屏预测  ${REFERENCE_VIEWPORT.width}x${REFERENCE_VIEWPORT.height} 上用 object-fit: cover：` +
    `左右各裁掉 ${cropSrcX.toFixed(0)}px（${pct(cropSrcX, width)}%），上下各裁掉 ${cropSrcY.toFixed(0)}px（${pct(cropSrcY, height)}%）`
);

{
  const surviving = win.x0 - cropSrcX;
  if (surviving <= 0) {
    warn(
      `左右边带会被整条裁掉（边带 ${win.x0}px < 裁掉 ${cropSrcX.toFixed(0)}px）—— ` +
        `四周外框会退化成只有上下两条。素材需要更竖（1024x1536），或把左右边带加宽到 ${((cropSrcX / width) * 100 + 4).toFixed(0)}% 以上`
    );
  } else {
    console.log(`       左右边带还剩 ${surviving.toFixed(0)}px（${pct(surviving, width)}% 宽），四周外框完整`);
  }
}

// ------------------------------------------------------------------- alpha & output

/**
 * Build the alpha plane: flat window fill becomes transparent, everything else stays opaque.
 *
 * WHY NOT A PLAIN RECTANGLE, which is what this script did first. The generator draws the
 * viewfinder corner brackets INSIDE the window rectangle. Punching out the whole rectangle
 * deleted them -- and those brackets are the single most viewfinder-ish element of the artwork,
 * precisely the thing that should float over the live camera feed.
 *
 * WHY NOT A PLAIN COLOUR KEY EITHER. A key applied to the whole image would also punch holes in
 * any genuinely dark part of the border art that lands near the window colour.
 *
 * So: a colour key, applied ONLY inside the window rectangle. The rectangle boundary needs no
 * extra feather because the generator's own anti-aliasing between fill and art IS the ramp -- and
 * a hard 1px edge at 1536px wide is well under one device pixel once the frame is drawn on a
 * phone.
 *
 * @param {object} win detected window rectangle
 * @param {number[]} windowColor the flat fill colour
 * @param {number} t0 distance at or below which a pixel is fully transparent
 * @param {number} t1 distance at or above which a pixel is fully opaque
 */
function buildAlpha(win, windowColor, t0 = 8, t1 = 34) {
  const alpha = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x > win.x0 && x < win.x1 && y > win.y0 && y < win.y1;
      if (!inside) {
        alpha[y * width + x] = 255;
        continue;
      }

      const p = at(x, y);
      const dev = Math.max(
        Math.abs(rgb[p] - windowColor[0]),
        Math.abs(rgb[p + 1] - windowColor[1]),
        Math.abs(rgb[p + 2] - windowColor[2])
      );
      const t = (dev - t0) / (t1 - t0);
      alpha[y * width + x] = Math.round(Math.max(0, Math.min(1, t)) * 255);
    }
  }
  return alpha;
}

const alpha = buildAlpha(win, win.color, keyT0, keyT1);

// How much of the camera feed stays uncovered once the frame is laid over the viewport. This is
// the number that decides whether the AR view still feels open or feels like a peephole.
{
  const visibleW = width - cropSrcX * 2;
  const visibleH = height - cropSrcY * 2;
  console.log(
    `\n透明区   在 ${REFERENCE_VIEWPORT.width}x${REFERENCE_VIEWPORT.height} 屏上占 ` +
      `${pct(Math.min(win.w, visibleW), visibleW)}% 宽 / ${pct(Math.min(win.h, visibleH), visibleH)}% 高（实时画面从这块透出来）`
  );
}

if (dryRun) {
  console.log(`\n--dry-run：没有写出文件。${warnings ? ` ${warnings} 条警告。` : ""}\n`);
  process.exit(warnings ? 2 : 0);
}

mkdirSync(join(outBase, ".."), { recursive: true });
encodeRGBA(
  { width, height, rgb, alpha },
  `${outBase}.webp`,
  // The alpha PNG is 16x the WebP and nothing serves it, so it is opt-in for inspection only.
  { pngPath: argv.includes("--png") ? `${outBase}.png` : null }
);

const webpPath = `${outBase}.webp`;
console.log(`       写出 ${webpPath}  ${sizeLabel(statSync(webpPath).size)}`);
if (argv.includes("--png")) console.log(`       写出 ${outBase}.png  ${sizeLabel(statSync(`${outBase}.png`).size)}`);

console.log(
  warnings
    ? `\n完成，但有 ${warnings} 条警告 —— 先处理它们再把这个素材用上去。\n`
    : "\n完成，未发现异常。\n"
);
process.exitCode = warnings ? 2 : 0;
