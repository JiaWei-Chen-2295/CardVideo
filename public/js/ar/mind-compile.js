// Main-thread client for the .mind compile worker.
//
// Wraps the worker protocol in a promise and normalizes the two different failure
// surfaces: worker construction errors (a bad import map, a browser without module
// workers) versus compile errors reported from inside the worker.

/** mind-ar cannot use a target much smaller than its 256px tracking scale. */
const MIN_TARGET_SHORT_SIDE = 160;

/** Where the worker script lives. */
const WORKER_URL = "/js/ar/mind-compile.worker.js";

/**
 * Resolve mind-ar's compiler bundle to a concrete URL and hand it to the worker.
 *
 * Why not let the worker write `import("mindar-image-compile")` and rely on the page's
 * import map: bare-specifier support for MODULE WORKERS is uneven across engines, and when
 * it fails the error is an opaque "Failed to resolve module specifier" (observed in the
 * wild, not theorised). The main thread has strict import-map support everywhere, so it
 * resolves the specifier here and the worker imports the resulting URL.
 *
 * `import.meta.resolve` is preferred; the fallback keeps working on engines that lack it.
 */
function resolveCompileBundleUrl() {
  try {
    if (typeof import.meta.resolve === "function") {
      const resolved = import.meta.resolve("mindar-image-compile");
      if (typeof resolved === "string") return new URL(resolved, location.href).href;
    }
  } catch {
    /* fall through to the conventional path below */
  }
  return new URL("/vendor/mindar-image-compile.js", location.href).href;
}

/**
 * Compile a photo into a .mind tracking target.
 *
 * @param {Blob|File} file
 * @param {(percent: number) => void} [onProgress] called with 0..100
 * @param {AbortSignal} [signal]
 * @returns {Promise<{bytes: Uint8Array, trackingPoints: number[], matchingScales: number,
 *                    width: number, height: number, aspect: number}>}
 */
export async function compileTarget(file, onProgress = () => {}, signal) {
  const bitmap = await createImageBitmap(file);
  const shortSide = Math.min(bitmap.width, bitmap.height);
  if (shortSide < MIN_TARGET_SHORT_SIDE) {
    bitmap.close?.();
    throw new CompileError(
      `照片太小了（短边 ${shortSide}px）。请上传短边至少 ${MIN_TARGET_SHORT_SIDE}px 的照片，` +
        `否则无法生成足够清晰的追踪特征。`,
      "too-small"
    );
  }

  let worker;
  try {
    // `type: "module"` is required: mind-ar's bundles are ES modules.
    worker = new Worker(WORKER_URL, { type: "module" });
  } catch (err) {
    bitmap.close?.();
    throw new CompileError(`无法启动编译线程：${err.message}`, "worker-unavailable");
  }

  const bundleUrl = resolveCompileBundleUrl();

  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn(value);
    };

    const onAbort = () => finish(reject, new CompileError("已取消", "aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event) => {
      const message = event.data ?? {};
      if (message.id !== id) return;

      if (message.type === "progress") {
        onProgress(message.percent);
        return;
      }
      if (message.type === "error") {
        finish(reject, new CompileError(message.message, "compile-failed"));
        return;
      }
      if (message.type === "done") {
        finish(resolve, {
          bytes: message.bytes,
          trackingPoints: message.trackingPoints ?? [],
          matchingScales: message.matchingScales ?? 0,
          width: message.width,
          height: message.height,
          aspect: message.aspect,
        });
      }
    };

    worker.onerror = (event) => {
      finish(
        reject,
        new CompileError(
          event.message ||
            "编译线程加载失败。这通常意味着 public/vendor 未生成，请先运行 npm run vendor。",
          "worker-load-failed"
        )
      );
    };

    worker.postMessage({ id, bitmap, bundleUrl }, [bitmap]);
  });
}

export class CompileError extends Error {
  constructor(message, code = "compile-failed") {
    super(message);
    this.name = "CompileError";
    this.code = code;
  }
}
