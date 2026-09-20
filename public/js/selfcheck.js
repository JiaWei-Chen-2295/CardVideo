// Self-check: compile the photo locally, then run AR in THIS page.
//
// WHY THERE IS NO NAVIGATION AND NO INDEXEDDB HAND-OFF
// An earlier version compiled here, parked the compiled target AND the whole video file in
// IndexedDB, then navigated to the AR page to read them back. That failed on a real phone with
//
//     Failed to execute 'createObjectURL' on 'URL': Overload resolution failed.
//
// because the value that came back out of IndexedDB was not a Blob. The deeper problem was the
// design, not the bug: the video was ALREADY in memory as a File, already usable as a blob URL,
// and there was no reason to persist it at all. Storing a multi-hundred-megabyte video in
// browser storage to pass it to another page is fragile on iOS in particular, where IndexedDB
// quotas are tight.
//
// So the AR session starts in place. Nothing is persisted, no quota is involved, and the only
// thing that has to survive is the File object already held in a variable.

import { precheckFile } from "/js/ar/precheck.js";
import { compileTarget } from "/js/ar/mind-compile.js";
import { inspectVideoFile, codecCapabilities, describeCapabilities } from "/js/ar/mp4-meta.js";

const MIN_TRACKING_POINTS = 8;

/**
 * `?debug=1` pins a live state readout on screen.
 *
 * A black AR screen has several indistinguishable causes from the outside -- autoplay blocked,
 * codec not decoded, texture not uploaded, or a video still buffering. Reading the numbers off
 * the device beats describing the symptom.
 */
const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

/**
 * Probe whether this browser can actually load and advance the chosen video.
 *
 * Runs BEFORE the compile (which costs seconds and megabytes) so an unplayable file is reported
 * in about a second instead of after a 30-second playback timeout.
 *
 * It tests BOTH routes deliberately: a blob URL over the raw picked File, and a blob URL over a
 * materialised in-memory copy. On iOS a File may be a lazy handle into Photos or iCloud Drive,
 * which can leave the element in `networkState = 3` with no MediaError -- the browser never even
 * tried to decode. If only the raw route fails, the copy route is the fix.
 *
 * @returns {Promise<{ok: boolean, detail: string, via?: string, media?: object}>}
 */
async function probeVideoPlayback(file, timeoutMs = 8000) {
  /** Load a URL in a fresh, correctly-configured element and report what the browser does. */
  const tryLoad = (url, timeout) =>
    new Promise((resolve) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.preload = "auto";
      video.style.cssText = "position:absolute;width:2px;height:2px;opacity:0;pointer-events:none";
      document.body.appendChild(video);

      const snapshot = () => ({
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message ?? null,
        size: `${video.videoWidth}x${video.videoHeight}`,
        duration: Number.isFinite(video.duration) ? video.duration : null,
      });

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        video.pause();
        video.removeAttribute("src");
        video.remove();
        resolve({ ...value, media: snapshot() });
      };

      const timer = setTimeout(() => finish({ kind: "timeout" }), timeout);
      // networkState 3 means resource selection is done and no frame will ever arrive. But it
      // frequently arrives a moment BEFORE the MediaError that explains WHY, and reporting the
      // bare network state sends the diagnosis in the wrong direction -- this cost a full
      // debugging round on a real file whose real problem was a bad AAC track. So give the error
      // event a brief window to land first.
      const poll = setInterval(() => {
        if (video.networkState === 3) {
          clearInterval(poll);
          setTimeout(() => finish({ kind: "no-source" }), 400);
        }
      }, 150);

      video.addEventListener("loadeddata", () => finish({ kind: "loaded" }));
      video.addEventListener("error", () => finish({ kind: "error" }));

      // Attach first, then set src, then load -- see the note in ar-viewer.js.
      video.src = url;
      video.load();
    });

  /** Confirm frames actually advance, rather than trusting that play() resolved. */
  const confirmPlays = async (url) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.src = url;
    video.style.cssText = "position:absolute;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        video.addEventListener("loadeddata", () => {
          clearTimeout(timer);
          resolve();
        });
        video.addEventListener("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await video.play();
      await new Promise((r) => setTimeout(r, 400));
      return !video.paused && video.currentTime > 0;
    } catch {
      return false;
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.remove();
    }
  };

  // --- route 1: the raw File handle -------------------------------------------------
  const rawUrl = URL.createObjectURL(file);
  const raw = await tryLoad(rawUrl, timeoutMs);
  const rawPlays = raw.kind === "loaded" ? await confirmPlays(rawUrl) : false;
  URL.revokeObjectURL(rawUrl);

  if (raw.kind === "loaded" && rawPlays) {
    return { ok: true, via: "raw", detail: `可播放（${raw.media.size}，${raw.media.duration?.toFixed(1) ?? "?"}s）`, media: raw.media };
  }

  // --- route 2: a materialised in-memory copy ---------------------------------------
  let copy = null;
  try {
    const bytes = await file.arrayBuffer();
    const copyUrl = URL.createObjectURL(new Blob([bytes], { type: file.type || "video/mp4" }));
    copy = await tryLoad(copyUrl, timeoutMs);
    const copyPlays = copy.kind === "loaded" ? await confirmPlays(copyUrl) : false;
    copy.plays = copyPlays;
    URL.revokeObjectURL(copyUrl);
  } catch (err) {
    copy = { kind: "read-failed", media: null, message: err.message };
  }
  if (copy?.kind === "loaded" && copy.plays) {
    return { ok: true, via: "copy", detail: `可播放（${copy.media.size}）`, media: copy.media };
  }

  // --- route 3: the same file with its audio track stripped -------------------------
  //
  // This separates "this file is broken" from "this browser cannot decode this audio codec",
  // which are completely different problems with completely different fixes. A real device
  // turned out to have no AAC decoder at all: every audio-bearing variant failed, including a
  // freshly re-encoded one, while the video-only variant played perfectly. Without this third
  // route the app would have rejected a usable video and blamed the file.
  let silent = null;
  let silentUrl = null;
  try {
    const res = await fetch(`${location.pathname.replace(/\/$/, "")}/api/strip-audio`, {
      method: "POST",
      headers: { "content-type": file.type || "video/mp4" },
      body: file,
    });
    if (res.ok) {
      const bytes = await res.arrayBuffer();
      silentUrl = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      silent = await tryLoad(silentUrl, timeoutMs);
      const silentPlays = silent.kind === "loaded" ? await confirmPlays(silentUrl) : false;
      silent.plays = silentPlays;
      if (!silentPlays) silent = { ...silent, kind: silent.kind === "loaded" ? "loaded-no-play" : silent.kind };
    } else {
      silent = { kind: `strip-http-${res.status}`, media: null };
    }
  } catch (err) {
    silent = { kind: "strip-unavailable", media: null, message: err.message };
  } finally {
    if (silentUrl) URL.revokeObjectURL(silentUrl);
  }

  if (silent?.kind === "loaded" && silent.plays) {
    // The video is fine; only its audio cannot be decoded here.
    const caps = codecCapabilities();
    return {
      ok: false,
      kind: "audio-unsupported",
      canPlaySilent: true,
      caps,
      detail:
        `<strong>这段视频的画面没问题，但这台设备的浏览器无法解码它的音频。</strong><br><br>` +
        `证据：去掉音频轨之后，同一个文件可以正常播放（${silent.media.size}）。<br>` +
        `<span style="font-size:12px;opacity:.85">解码能力：${describeCapabilities(caps)}</span><br><br>` +
        (caps.audioAac
          ? `浏览器自称支持 AAC，但仍然失败，说明是这个文件与解码器的兼容问题。`
          : `这台浏览器<strong>不支持 AAC 音频</strong>。常见于应用内置的浏览器` +
            `（微信、QQ、部分国产浏览器），它们为了规避专利会裁掉 AAC 解码器。<br>` +
            `<strong>请换用 Chrome 或 Safari 打开本页面</strong>，音频就能正常播放。`) +
        `<br><br>你也可以选择继续：画面会正常显示，但没有声音。`,
      media: silent.media,
    };
  }

  // --- everything failed: report the most specific reason available ------------------
  const interesting = copy?.media ? copy : raw;
  const media = interesting?.media;

  if (media?.errorCode) {
    const label =
      { 1: "加载被中止", 2: "网络错误", 3: "解码失败", 4: "格式不受支持" }[media.errorCode] ??
      `MediaError ${media.errorCode}`;
    return {
      ok: false,
      kind: "media-error",
      detail: `视频加载失败：${label}（${media.errorMessage ?? "无详细信息"}）`,
      media,
    };
  }

  if (interesting?.kind === "no-source" || media?.networkState === 3) {
    return {
      ok: false,
      kind: "no-source",
      detail:
        `浏览器拒绝加载这个视频源（networkState=3，未尝试解码），读入内存后仍然失败，` +
        `去掉音频后也失败。这是容器或视频编码层面的问题。`,
      media,
    };
  }

  if (interesting?.kind === "timeout") {
    return {
      ok: false,
      kind: "timeout",
      detail:
        `视频在 ${Math.round(timeoutMs / 1000)} 秒内没有产出可播放数据` +
        `（readyState=${media?.readyState}, networkState=${media?.networkState}）。`,
      media,
    };
  }

  return {
    ok: false,
    kind: interesting?.kind ?? "unknown",
    detail: `视频无法播放：${interesting?.kind ?? "未知原因"} ${interesting?.message ?? ""}`.trim(),
    media,
  };
}
let debugPanel = null;

function updateDebugPanel(text) {
  if (!DEBUG) return;
  if (!debugPanel) {
    debugPanel = document.createElement("pre");
    debugPanel.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:40;margin:0;padding:8px 10px;" +
      "background:rgba(0,0,0,.78);color:#9fe8b0;font:11px/1.5 ui-monospace,monospace;" +
      "border-radius:8px;max-width:92vw;white-space:pre-wrap;pointer-events:none";
    document.body.appendChild(debugPanel);
  }
  debugPanel.textContent = text;
}

/** Warn above this size: the compile works regardless, but a huge local video is worth flagging. */
const LARGE_VIDEO_BYTES = 200 * 1024 * 1024;

const els = {
  form: document.getElementById("form"),
  intro: document.getElementById("intro"),
  photo: document.getElementById("photo"),
  video: document.getElementById("video"),
  submit: document.getElementById("submit"),
  status: document.getElementById("status"),
  progress: document.getElementById("progress"),
  bar: document.getElementById("bar"),
  label: document.getElementById("progress-label"),
  stage: document.getElementById("stage"),
  chrome: document.getElementById("chrome"),
  hint: document.getElementById("hint"),
  sound: document.getElementById("sound"),
  exit: document.getElementById("exit"),
};

const show = (kind, html) => {
  els.status.hidden = false;
  els.status.className = `notice notice--${kind}`;
  els.status.innerHTML = html;
};

const hideNotice = () => {
  els.status.hidden = true;
  els.status.innerHTML = "";
};

const setProgress = (percent, text) => {
  els.progress.hidden = false;
  els.bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.label.textContent = text ?? `${Math.round(percent)}%`;
};

const setBusy = (busy) => {
  els.submit.disabled = busy;
  els.photo.disabled = busy;
  els.video.disabled = busy;
  els.submit.innerHTML = busy
    ? '<span class="spinner" aria-hidden="true"></span><span>正在生成…</span>'
    : "<span>生成并打开 AR 自检</span>";
};

// ------------------------------------------------------------------- AR session

let viewer = null;
/** Blob URLs created for the AR session; revoke them when it ends. */
const objectUrls = [];
/** Extra cleanup callbacks (e.g. the materialised video's revoker). */
const revokeAlso = [];

const ESCALATE_AFTER_MS = 6000;
let escalateTimer = null;

const setHint = (text, soft = true) => {
  if (!text) {
    els.hint.hidden = true;
    return;
  }
  els.hint.hidden = false;
  els.hint.textContent = text;
  els.hint.classList.toggle("ar-hint--soft", soft);
};

function onViewerState(state) {
  if (DEBUG) {
    const m = state.media;
    const lines = [
      `phase    ${state.phase}`,
      `playing  ${state.playing ?? "-"}`,
      `sound    ${state.sound ?? "-"}`,
      `video    ${state.video ?? "-"}`,
      `textured ${state.textured ?? "-"}`,
    ];
    if (state.error) lines.push(`error    ${state.error}`);
    if (m) {
      // readyState/networkState/error are the three fields that actually localise a failure:
      // rs=0 means no metadata arrived, net=3 means the browser rejected every source given.
      lines.push(
        `rs/net   ${m.readyState} / ${m.networkState}`,
        `error    ${m.error}`,
        `size     ${m.size} paused=${m.paused} muted=${m.muted}`,
        `time     ${m.time.toFixed(2)}s / ${m.duration == null ? "?" : m.duration.toFixed(2)}s`
      );
    }
    // Mirror of the diagnostics on the share-link page, so the two can be compared line by line --
    // the working page and the broken one have to be instrumented identically for a diff to mean
    // anything.
    const button = document.getElementById("sound");
    if (button) {
      const rect = button.getBoundingClientRect();
      lines.push(
        `btn      hidden=${button.hidden} opacity=${getComputedStyle(button).opacity}`,
        `btn rect ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`
      );
    }
    const el = viewer?.video;
    if (el) {
      lines.push(
        `attr     muted=${el.hasAttribute("muted")} volume=${el.volume}`,
        `tracks   audio=${el.audioTracks ? el.audioTracks.length : "n/a"} video=${el.videoTracks ? el.videoTracks.length : "n/a"}`,
        `soundOn  ${viewer?.soundEnabled}`
      );
    }
    updateDebugPanel(lines.join("\n"));
  }

  switch (state.phase) {
    case "searching":
      if (escalateTimer) clearTimeout(escalateTimer);
      setHint("把摄像头对准照片");
      escalateTimer = setTimeout(() => {
        setHint("还没找到照片 · 靠近一点、换个角度、或把灯打开");
      }, ESCALATE_AFTER_MS);
      break;
    case "tracking":
      if (escalateTimer) clearTimeout(escalateTimer);
      if (state.fatalVideo) {
        // Measured on a real device: a browser can answer `probably` to canPlayType and `yes` to
        // MediaSource.isTypeSupported for AAC and still fail to decode it, so this cannot be
        // detected before playback. Say plainly what to do instead of showing the raw error.
        els.sound.hidden = true;
        setHint("");
        show(
          "error",
          `<strong>这个浏览器无法播放视频的音频。</strong><br><br>` +
            `画面本身没问题，是当前浏览器解码不了这段音频。某些浏览器（尤其是手机版 Edge）` +
            `会自称支持 AAC，实际却解不出来，所以只能靠播放来发现。<br><br>` +
            `请<strong>改用 Chrome 或 Safari</strong> 重新打开本页面。` +
            `<br><br><span style="font-size:12px;opacity:.8">原始错误：${state.error ?? "未知"}</span>`
        );
      } else {
        setHint(state.sound ? "" : "点下方开启声音");
        els.sound.hidden = Boolean(state.sound);
      }
      break;
    default:
      break;
  }
}

/** Open the self-check AR session using blob URLs held in memory. */
async function startSelfCheckAr({ mindBytes, videoFile, aspect, title }) {
  els.form.hidden = true;
  els.intro.hidden = true;
  hideNotice();
  els.progress.hidden = true;
  els.stage.hidden = false;
  els.chrome.hidden = false;
  els.hint.hidden = false;
  setHint("正在启动摄像头…");

  // Cache-bust the AR modules on every session.
  //
  // These are the modules that change while chasing a rendering bug, and a stale copy presents
  // as a bug that was already fixed -- which is worse than an obvious error, because it sends
  // the investigation in the wrong direction. The HTML that references this script is served
  // no-cache, so a reload always re-reads this file, and this line then guarantees the modules
  // it pulls in are current too.
  const { ARViewer, materializeVideoUrl } = await import(`/js/ar/ar-viewer.js?v=${Date.now()}`);

  // Materialise the picked file rather than pointing a blob URL at the raw File handle: on iOS a
  // File can be a lazy handle into Photos or iCloud Drive, and a blob URL over it may never
  // stream (networkState=3 with no MediaError). See materializeVideoUrl for the details.
  const video = await materializeVideoUrl(videoFile);
  const mindUrl = URL.createObjectURL(
    new Blob([mindBytes], { type: "application/octet-stream" })
  );
  objectUrls.push(mindUrl);
  revokeAlso.push(video.revoke);
  const videoUrl = video.url;

  try {
    viewer = new ARViewer({
      container: els.stage,
      mindUrl,
      videoUrl,
      videoAspect: aspect,
      onState: onViewerState,
      // Same direct wiring as the share-link page: the control appears when the media element has
      // data, not when some unrelated promise happens to resolve.
      onSoundAvailable: () => {
        if (!viewer?.soundEnabled) {
          els.sound.hidden = false;
          setHint("点下方开启声音");
        }
      },
    });
    await viewer.start();
    setHint("把摄像头对准照片");
  } catch (err) {
    endSelfCheckAr();
    show("error", `AR 启动失败：${err?.message ?? err}`);
  }
}

function endSelfCheckAr() {
  viewer?.dispose();
  viewer = null;
  if (escalateTimer) clearTimeout(escalateTimer);
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.length = 0;
  for (const revoke of revokeAlso) revoke();
  revokeAlso.length = 0;

  els.stage.hidden = true;
  els.chrome.hidden = true;
  els.form.hidden = false;
  els.intro.hidden = false;
  els.hint.hidden = true;
  els.sound.hidden = true;
  setBusy(false);
}

// ------------------------------------------------------------------------ events

els.exit.addEventListener("click", () => {
  endSelfCheckAr();
  show("info", "自检结束。如果刚才屏幕能升起来，说明这张照片可以用来做卡片。");
});

els.sound.addEventListener("click", async () => {
  if (!viewer) return;
  await viewer.enableSound();
  els.sound.hidden = true;
  setHint("声音已开启");
  setTimeout(() => {
    if (viewer?.soundEnabled) setHint("");
  }, 1600);
});

// Release the camera if the page goes away mid-session.
window.addEventListener("pagehide", () => viewer?.dispose());

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideNotice();

  const photoFile = els.photo.files?.[0];
  const videoFile = els.video.files?.[0];

  if (!photoFile || !videoFile) {
    show("error", "请同时选择照片和视频（用卡片实际用的那两个文件，这样自检才有意义）。");
    return;
  }

  setBusy(true);

  try {
    setProgress(4, "检查视频格式…");
    const info = await inspectVideoFile(videoFile);
    if (!info.ok) throw new Error(info.reason);
    const aspect = info.aspect;

    // Prove the browser can actually play this file before spending seconds compiling a tracking
    // target for it. A container can pass the header check and still be rejected by the decoder.
    setProgress(12, "测试视频能否播放…");
    const playback = await probeVideoPlayback(videoFile);
    if (!playback.ok) {
      // Render the message as HTML: the AAC case includes a copy-pasteable command.
      throw Object.assign(new Error(playback.detail), { alreadyHtml: true });
    }

    if (videoFile.size > LARGE_VIDEO_BYTES) {
      show(
        "warn",
        `这段视频有 ${(videoFile.size / 1024 / 1024).toFixed(0)}MB，本地播放可能较慢。` +
          `识别效果的自检不受影响。`
      );
    }

    setProgress(18, "预检照片…");
    const verdict = await precheckFile(photoFile);
    if (!verdict.ok) throw new Error(verdict.message);

    const compiled = await compileTarget(photoFile, (percent) => {
      setProgress(18 + percent * 0.78, `正在生成追踪数据 ${percent}%`);
    });

    const points = compiled.trackingPoints ?? [];
    const weakest = points.length ? Math.min(...points) : 0;
    if (weakest < MIN_TRACKING_POINTS) {
      throw new Error(
        "这张照片编译后追踪特征点太少（" +
          points.join(" / ") +
          "），实际识别会不稳定。换一张细节更丰富的照片试试。"
      );
    }

    setProgress(97, "准备 AR…");
    await startSelfCheckAr({
      mindBytes: compiled.bytes,
      videoFile,
      aspect,
      title: "自检",
    });
  } catch (err) {
    console.error("[selfcheck] failed", err);
    els.progress.hidden = true;
    // Probe failures may carry HTML (a copy-pasteable fix command); everything else is plain text
    // and must be escaped so a file name cannot inject markup.
    const message = err?.alreadyHtml
      ? err.message
      : String(err?.message ?? "自检准备失败。").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
    show("error", message.replace(/\n/g, "<br>"));
    setBusy(false);
  }
});
