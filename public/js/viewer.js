// The AR session page: pre-flight screen in, immersive camera view out (DESIGN.md P7, P8).
//
// Two rules shape this file:
//   1. "Start" must be a real user gesture. It satisfies iOS audio unlocking AND gives the
//      browser a sane moment to ask for camera permission, so the permission prompt never
//      appears over a blank screen.
//   2. Loading is parallel. Camera permission, the .mind file and the video are fetched
//      concurrently while the progress readout runs, because they are independent and the
//      tracker is the slow one.

const params = new URLSearchParams(location.search);

/**
 * Load the AR session module with a cache-busting query.
 *
 * The HTML that references this file is served no-cache, so a reload always re-reads it -- but
 * the modules it pulls in are a separate cache entry, and a stale one presents as a bug that was
 * already fixed. That is worse than an obvious error because it sends the investigation in the
 * wrong direction, so the import is busted instead of trusted.
 */
const arViewerModule = import(`/js/ar/ar-viewer.js?v=${Date.now()}`);
/**
 * `?debug=1` pins a live state readout on screen.
 *
 * A black AR screen has several indistinguishable causes from the outside -- autoplay blocked,
 * codec not decoded, texture not uploaded, or simply a video that is still buffering. Reading
 * the numbers off the device beats describing the symptom.
 */
const DEBUG = params.get("debug") === "1";
let debugPanel = null;

/**
 * Which landing page handed off to this session.
 *
 * `theme=material` means the viewer is already holding a printed piece (MATERIAL.md), so the
 * generic copy -- "把这张照片打印出来", the three-step list -- describes work they have already
 * done, and reads as if they skipped a step. Only WORDING branches on this: the audio gesture,
 * the parallel preload and the 0.8s tracking grace period are untouched, because those are what
 * make the session work at all.
 */
const MATERIAL = params.get("theme") === "material";

// Set at module scope, not when the card resolves: ar.html's static "正在准备…" overlay is
// already on screen by then, so recolouring it later would flash the generic gradient first.
// Unhiding the frame here also starts its download in parallel with the .mind and the video,
// rather than after them -- it is only 124KB, but it is on the same critical path.
if (MATERIAL) {
  document.body.dataset.theme = "material";
  document.getElementById("frame").hidden = false;
}

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

const stage = document.getElementById("stage");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayBody = document.getElementById("overlay-body");
const startButton = document.getElementById("start");
const spinnerRow = document.getElementById("spinner-row");
const progressText = document.getElementById("progress-text");

const hint = document.getElementById("hint");
const soundButton = document.getElementById("sound");
const exitButton = document.getElementById("exit");

let viewer = null;
let started = false;

// ---------------------------------------------------------------- card lookup

/**
 * Resolve the card this page is showing.
 *
 * The self-check path deliberately does NOT come through here: it runs its own AR session in
 * the selfcheck page, so there is no second source of truth and no cross-page hand-off.
 */
async function resolveSource() {
  const cardId = params.get("card");
  if (!cardId) {
    throw new Error("缺少 card 参数。自检请用 /selfcheck 页面。");
  }

  const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}`);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? "找不到这张卡片");
  }
  const card = await res.json();

  // Fail loudly rather than handing undefined to a renderer: a malformed API response should
  // read as "this card is broken", not as a silent blank AR view.
  for (const field of ["mindUrl", "videoUrl"]) {
    if (typeof card[field] !== "string" || !card[field]) {
      throw new Error(`卡片数据不完整（缺少 ${field}）。`);
    }
  }

  return {
    mindUrl: card.mindUrl,
    videoUrl: card.videoUrl,
    videoAspect: card.videoAspect,
    title: card.title || "",
  };
}

// ---------------------------------------------------------------------- chrome

const showOverlay = (title, body, { button = null, spinner = false } = {}) => {
  overlay.hidden = false;
  overlayTitle.textContent = title;
  overlayBody.innerHTML = body;
  startButton.hidden = button === null;
  if (button) {
    startButton.textContent = button.label;
    startButton.disabled = false;
    startButton.dataset.action = button.action ?? "start";
  }
  spinnerRow.hidden = !spinner;
  if (!spinner) progressText.textContent = "";
};

const hideOverlay = () => {
  overlay.hidden = true;
};

/**
 * Treat the camera's own orientation as a hint about fullscreen support: iOS Safari does
 * not implement the element Fullscreen API, so calling it there is a no-op we should not
 * depend on. The layout is already fully immersive via `100dvh`, so fullscreen is only a
 * bonus where it exists (Android Chrome).
 */
async function tryFullscreen() {
  try {
    if (!document.fullscreenElement && stage.requestFullscreen) {
      await stage.requestFullscreen({ navigationUI: "hide" });
    }
  } catch {
    /* unsupported or denied; the fixed-position layout is already immersive */
  }
}

// ------------------------------------------------------------------ state wiring

const setHint = (text, soft = false) => {
  if (!text) {
    hint.hidden = true;
    return;
  }
  hint.hidden = false;
  hint.textContent = text;
  hint.classList.toggle("ar-hint--soft", soft);
};

/** How long a viewer may stare at nothing before we escalate the guidance. */
const ESCALATE_AFTER_MS = 6000;
let escalateTimer = null;

function clearEscalate() {
  if (escalateTimer) {
    clearTimeout(escalateTimer);
    escalateTimer = null;
  }
}

function onViewerState(state) {
  if (DEBUG) {
    const m = state.media;
    const button = document.getElementById("sound");
    const lines = [
      `phase    ${state.phase}`,
      `playing  ${state.playing ?? "-"}`,
      `sound    ${state.sound ?? "-"}`,
      `video    ${state.video ?? "-"}`,
      `textured ${state.textured ?? "-"}`,
    ];
    if (m) {
      lines.push(
        `rs/net   ${m.readyState} / ${m.networkState}`,
        `error    ${m.error}`,
        `size     ${m.size} paused=${m.paused} muted=${m.muted} vol=${m.volume}`,
        `time     ${m.time.toFixed(2)}s / ${m.duration == null ? "?" : m.duration.toFixed(2)}s`
      );
    }
    // Same lines as selfcheck.js, deliberately: the two pages must be instrumented identically or
    // a diff between them proves nothing.
    if (soundButton) {
      const rect = soundButton.getBoundingClientRect();
      lines.push(
        `btn      hidden=${soundButton.hidden} opacity=${getComputedStyle(soundButton).opacity}`,
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
    if (state.error) lines.push(`error    ${state.error}`);
    updateDebugPanel(lines.join("\n"));
  }

  switch (state.phase) {
    case "preparing":
      progressText.textContent = state.detail ?? "正在准备…";
      break;

    case "searching":
      clearEscalate();
      setHint(MATERIAL ? "把镜头对准卡片" : "把摄像头对准照片", true);
      // Silence is the worst outcome: after a few seconds of nothing, say what to try.
      escalateTimer = setTimeout(() => {
        setHint(
          MATERIAL
            ? "还没找到卡片 · 靠近一点、换个角度、把灯打开"
            : "还没找到照片 · 靠近一点、换个角度、或把光线调亮",
          false
        );
      }, ESCALATE_AFTER_MS);
      break;

    case "tracking":
      clearEscalate();
      if (state.fatalVideo) {
        // The video cannot play at all. Do not leave this as a small hint: the fix is to open a
        // different browser, and that instruction has to be prominent enough to act on.
        soundButton.hidden = true;
        setHint("");
        handleFatal(new Error(state.error ?? "视频无法播放"));
      } else {
        setHint(state.sound ? "" : "点下方开启声音", true);
        soundButton.hidden = Boolean(state.sound);
      }
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------- startup

async function start() {
  if (started) return;
  started = true;
  startButton.disabled = true;

  hideOverlay();
  setHint("正在启动摄像头…", true);

  try {
    const source = await resolveSource();
    if (source.title) document.title = `${source.title} · CardVideo`;

    void tryFullscreen();

    const { ARViewer } = await arViewerModule;
    viewer = new ARViewer({
      container: stage,
      mindUrl: source.mindUrl,
      videoUrl: source.videoUrl,
      videoAspect: source.videoAspect,
      onState: onViewerState,
      // Driven directly by the media element rather than by the state machine: a control the user
      // needs must not depend on an async playback chain completing in a particular order.
      onSoundAvailable: () => {
        if (!viewer?.soundEnabled) {
          soundButton.hidden = false;
          setHint("点下方开启声音", true);
        }
      },
    });
    await viewer.start();
  } catch (err) {
    started = false;
    handleFatal(err);
  }
}

/** Turn a failure into something the viewer can act on. */
function handleFatal(err) {
  const message = err?.message ?? String(err);
  console.error("[ar] fatal", err);

  let title = "无法开启 AR";
  let body = message;

  if (/AAC|DEMUXER_ERROR/i.test(message)) {
    // Measured behaviour of this class of failure: a browser that cannot decode AAC in an MP4
    // will still answer `probably` to canPlayType and `yes` to MediaSource.isTypeSupported, so
    // it cannot be detected up front -- only by attempting playback. Edge for Android was the
    // case here; Chrome on the same device played the same file without complaint.
    title = "这个浏览器无法播放视频的音频";
    body =
      "视频画面正常，但<strong>当前浏览器解码不了这段音频</strong>。" +
      "某些浏览器（尤其是手机版 Edge）会自称支持 AAC，实际却解不出来——" +
      "所以只能靠播放来发现。<br><br>" +
      "请<strong>改用 Chrome 或 Safari</strong> 打开这个链接，音频即可正常播放。";
  } else if (/Permission|NotAllowed|denied/i.test(message)) {
    title = "需要摄像头权限";
    body =
      "浏览器拒绝了摄像头访问。请在地址栏的权限设置里允许摄像头，然后重新加载这个页面。" +
      "<br><br>提示：摄像头只在 HTTPS 或 localhost 下可用。";
  } else if (/NotFound|DevicesNotFound|no camera/i.test(message)) {
    title = "没有找到摄像头";
    body = "这台设备没有可用的摄像头，或者摄像头被其他应用占用了。";
  } else if (/mind|tracking|fetch|load/i.test(message)) {
    title = "追踪数据加载失败";
    body = `${message}<br><br>如果这是你自己的部署，请确认已运行 <code>npm run vendor</code> 并且 .mind 文件可访问。`;
  } else if (/getUserMedia|mediaDevices/i.test(message)) {
    title = "浏览器不支持摄像头调用";
    body =
      "这个浏览器不支持所需的摄像头接口。请使用较新版本的 Chrome、Safari 或 Edge，" +
      "并且确保页面是通过 HTTPS 打开的。";
  }

  showOverlay(title, `<p>${body}</p>`, { button: { label: "重试", action: "retry" } });
}

// ------------------------------------------------------------------- controls

startButton.addEventListener("click", () => {
  if (startButton.dataset.action === "retry" && viewer) {
    viewer.dispose();
    viewer = null;
  }
  void start();
});

soundButton.addEventListener("click", async () => {
  if (!viewer) return;
  await viewer.enableSound();
  soundButton.hidden = true;
  setHint("声音已开启", true);
  setTimeout(() => {
    if (viewer?.soundEnabled) setHint("");
  }, 1600);
});

exitButton.addEventListener("click", () => {
  viewer?.dispose();
  viewer = null;
  // The camera can only be released by tearing the page down, and "exit" means the
  // viewer is done with this session.
  if (history.length > 1) history.back();
  else location.href = "/";
});

// Release the camera when the page is hidden, otherwise the phone keeps the indicator on.
window.addEventListener("pagehide", () => {
  viewer?.dispose();
  viewer = null;
});

// ------------------------------------------------------------------- first paint

(async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    showOverlay(
      "浏览器不支持",
      "<p>这个浏览器无法调用摄像头。请使用较新版本的 Chrome、Safari 或 Edge，并通过 HTTPS 打开。</p>"
    );
    return;
  }
  if (!window.isSecureContext) {
    showOverlay(
      "需要 HTTPS",
      "<p>摄像头只在 HTTPS 或 localhost 下可用。请用 <code>https://</code> 打开这个页面。</p>"
    );
    return;
  }

  try {
    const source = await resolveSource();

    // 物料版开场：没有可打印的东西，所以不列步骤，只留"标题 + 一句引导 + 一个按钮"。
    if (MATERIAL) {
      showOverlay(source.title || "现场", "<p>把镜头对准卡片</p>", {
        button: { label: "进入现场", action: "start" },
      });
      return;
    }

    const steps = [
      "把这张照片<strong>打印出来</strong>（建议 A4 彩打，短边至少 10cm）",
      "光线充足，避免屏幕反光",
      "手机对准照片，距离 25–45cm",
    ];
    showOverlay(
      source.title || "把摄像头对准照片",
      `<p>照片上会升起一块屏幕，播放这段视频。</p>
       <ul class="ar-steps">
         ${steps.map((s, i) => `<li data-n="${i + 1}">${s}</li>`).join("")}
       </ul>
       <p class="hint">点击下方按钮后会请求摄像头权限。</p>`,
      { button: { label: "开始体验", action: "start" } }
    );
  } catch (err) {
    handleFatal(err);
  }
})();
