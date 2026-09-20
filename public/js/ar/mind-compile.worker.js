// Compile a photo into a mind-ar tracking target (.mind), inside a Web Worker.
//
// WHY COMPILATION IS IN THE BROWSER (DESIGN.md §3.2)
// mind-ar's compiler needs @tensorflow/tfjs, whose tree is ~200MB uncompressed while
// Vercel caps a function bundle at 250MB. Server-side compilation would sit permanently
// against that wall and reload on every cold start. In the browser it costs the creator a
// few seconds of CPU, and buys something valuable: they can self-check that their photo
// really tracks before sending the link to anyone (DESIGN.md §8-Q4).
//
// WHY THIS IS A *MODULE* WORKER
// mind-ar's dist bundles (`mindar-image.prod.js` -> `controller-*.js`) are ES modules with
// static `import` statements, so `importScripts` cannot load them.
//
// WHY THE BUNDLE URL ARRIVES VIA postMessage
// The obvious alternative is `import("mindar-image-compile")` and letting the page's import
// map resolve it. That works in Chromium but bare-specifier support for module workers is
// uneven across engines, and the failure mode is an opaque "Failed to resolve module
// specifier". The main thread resolves the specifier (strict import-map support everywhere)
// and passes the concrete URL down, so the worker never depends on import maps at all.

// mind-ar's dist addresses the global object as `window`, which does not exist in a worker.
// Aliasing it is the documented way to reuse browser bundles in worker scope. This runs
// before the dynamic import below, so the alias is in place in time.
self.window = self;

/** Longest edge of the image actually compiled. The reasoning is in `rasterize()`. */
const MAX_COMPILE_DIMENSION = 1024;

/**
 * Rasterize the image at a bounded size and read back greyscale bytes.
 *
 * Downscaling before compiling is a measured decision, not a guess:
 *   - mind-ar's tracking pass ALWAYS rescales the target so its short side is 256px and
 *     128px, so detail above ~512px cannot improve tracking;
 *   - [measured] a 1600x1200 target compiled in 20.1s and produced 25/29 tracking
 *     features; a 512x384 target took 3.6s and produced 18/28. Compile time is roughly
 *     linear in pixel count while feature counts barely move;
 *   - the .mind payload stays ~0.26-0.36MB across that whole range.
 * 1024px keeps a comfortable margin of matching scales (10 rather than 12) while halving
 * compile time compared with 1600px.
 */
function rasterize(bitmap) {
  const scale = Math.min(1, MAX_COMPILE_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;

  const grey = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
    grey[i] = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3;
  }
  return { grey, width, height };
}

self.onmessage = async (event) => {
  const { id, bitmap, bundleUrl } = event.data ?? {};
  const post = (message) => self.postMessage({ id, ...message });

  try {
    const source = rasterize(bitmap);
    bitmap.close?.();

    if (!bundleUrl) {
      throw new Error("compile worker received no bundle URL");
    }
    const { Compiler } = await import(/* @vite-ignore */ bundleUrl);

    // The stock Compiler draws the image into a DOM canvas to obtain grey bytes. We
    // already hold exact grey bytes from the offscreen rasterization, so this override
    // skips a redundant canvas round-trip AND guarantees the compiled pixels are
    // bit-identical to the ones the pre-check measured.
    class GreyCompiler extends Compiler {
      createProcessCanvas() {
        return {
          getContext: () => ({
            drawImage() {},
            getImageData: () => {
              const rgba = new Uint8ClampedArray(source.width * source.height * 4);
              for (let i = 0; i < source.grey.length; i++) {
                const v = source.grey[i];
                rgba[i * 4] = v;
                rgba[i * 4 + 1] = v;
                rgba[i * 4 + 2] = v;
                rgba[i * 4 + 3] = 255;
              }
              return { data: rgba, width: source.width, height: source.height };
            },
          }),
        };
      }
    }

    const compiler = new GreyCompiler();
    let lastReported = -1;

    const result = await compiler.compileImageTargets(
      [{ width: source.width, height: source.height }],
      (progress) => {
        const percent = Math.max(0, Math.min(100, Math.round(progress)));
        // Throttle to whole percents; chattier progress costs more than it informs.
        if (percent !== lastReported) {
          lastReported = percent;
          post({ type: "progress", percent });
        }
      }
    );

    // Tracking features per frame, as produced by the compiler itself. This is the
    // authoritative "is this photo trackable" signal, and it is why an unusable photo is
    // rejected here instead of after an upload.
    const trackingPoints = (result?.[0]?.trackingData ?? []).map((frame) => frame.points.length);

    post({
      type: "done",
      bytes: new Uint8Array(compiler.exportData()),
      trackingPoints,
      matchingScales: result?.[0]?.matchingData?.length ?? 0,
      width: source.width,
      height: source.height,
      aspect: source.width / source.height,
    });
  } catch (error) {
    post({ type: "error", message: error?.message ?? String(error) });
  }
};
