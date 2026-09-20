// Does this browser have a working AAC decoder?
//
// WHY THIS PAGE EXISTS
// A phone rejected every audio-bearing MP4 with `PipelineStatus::DEMUXER_ERROR_DETECTED_AAC`,
// including one whose audio had just been re-encoded to clean AAC-LC, while the identical file
// with its audio track removed played perfectly. Two explanations fit that evidence:
//
//   (a) the browser has no AAC decoder at all -- codec licensing means some builds ship without
//       one, and some Android devices lack the platform decoder; or
//   (b) something about these particular files.
//
// The way to tell them apart is to stop using our own files: generate audio IN the browser with
// MediaRecorder and try to play it back. If the browser cannot play audio it just recorded itself,
// the problem is definitively the decoder.
//
// It also prints the user agent, because which browser this is matters and asking a person to find
// it is needless friction.

const out = document.getElementById("out");

const caps = () => {
  const probe = document.createElement("video");
  const canPlay = (type) => {
    const answer = probe.canPlayType(type);
    return answer === "probably" || answer === "maybe" ? answer : "no";
  };
  const mse = (type) => {
    try {
      return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type) ? "yes" : "no";
    } catch {
      return "error";
    }
  };
  return {
    h264: canPlay('video/mp4; codecs="avc1.42E01E"'),
    aac: canPlay('audio/mp4; codecs="mp4a.40.2"'),
    mp3: canPlay("audio/mpeg"),
    opus: canPlay('audio/webm; codecs="opus"'),
    vorbis: canPlay('audio/webm; codecs="vorbis"'),
    wav: canPlay('audio/wav; codecs="1"'),
    flac: canPlay("audio/flac"),
    mseAac: mse('audio/mp4; codecs="mp4a.40.2"'),
    mseH264: mse('video/mp4; codecs="avc1.42E01E"'),
  };
};

const line = (label, value, ok = null) => {
  const color = ok === null ? "var(--text-dim)" : ok ? "#42d392" : "#ff5d5d";
  return `<tr><td style="padding:3px 14px 3px 0;color:var(--text-faint)">${label}</td><td style="font-family:var(--mono);font-size:12px;color:${color};word-break:break-all">${value}</td></tr>`;
};

/** Load a URL and report exactly what happened. */
function tryPlay(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.preload = "auto";
    video.style.cssText = "position:absolute;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(video);

    const snap = () => ({
      readyState: video.readyState,
      networkState: video.networkState,
      errorCode: video.error?.code ?? null,
      errorMessage: video.error?.message ?? null,
      size: video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : "-",
    });

    let settled = false;
    const finish = (kind) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      video.pause();
      const snapshot = snap();
      video.removeAttribute("src");
      video.remove();
      resolve({ kind, ...snapshot });
    };

    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const poll = setInterval(() => {
      if (video.networkState === 3) {
        clearInterval(poll);
        // The MediaError explaining why often arrives just after the network state changes.
        setTimeout(() => finish("no-source"), 500);
      }
    }, 150);

    video.addEventListener("loadeddata", () => finish("loaded"));
    video.addEventListener("error", () => finish("error"));
    video.src = url;
    video.load();
  });
}

/** Record N seconds of a tone with MediaRecorder, then report what it produced. */
async function recordTone(seconds = 2) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return { error: "no Web Audio API" };

  const ctx = new AudioCtx();
  const destination = ctx.createMediaStreamDestination();
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();

  const mimeCandidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/ogg;codecs=opus",
  ];
  const mimeType = mimeCandidates.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });

  if (!mimeType) {
    oscillator.stop();
    ctx.close();
    return { error: "MediaRecorder reports no supported audio type" };
  }

  const recorder = new MediaRecorder(destination.stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));

  recorder.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  recorder.stop();
  await stopped;
  oscillator.stop();
  await ctx.close();

  const blob = new Blob(chunks, { type: mimeType });
  return { blob, mimeType, size: blob.size };
}

const run = async () => {
  out.innerHTML = "";
  const c = caps();

  out.insertAdjacentHTML(
    "beforeend",
    `<div class="notice notice--info"><strong>浏览器</strong>` +
      `<table style="margin-top:8px">` +
      line("userAgent", navigator.userAgent.replace(/</g, "&lt;")) +
      line("platform", navigator.platform || "-") +
      line("isSecureContext", String(window.isSecureContext), window.isSecureContext) +
      `</table></div>`
  );

  out.insertAdjacentHTML(
    "beforeend",
    `<div class="notice notice--info"><strong>编解码器支持（canPlayType）</strong>` +
      `<table style="margin-top:8px">` +
      line("H.264 视频", c.h264, c.h264 !== "no") +
      line("AAC 音频", c.aac, c.aac !== "no") +
      line("MP3 音频", c.mp3, c.mp3 !== "no") +
      line("Opus 音频", c.opus, c.opus !== "no") +
      line("Vorbis 音频", c.vorbis, c.vorbis !== "no") +
      line("WAV 音频", c.wav, c.wav !== "no") +
      line("FLAC 音频", c.flac, c.flac !== "no") +
      `</table>` +
      `<div style="margin-top:8px;font-size:12px">MediaSource: AAC ${c.mseAac} · H.264 ${c.mseH264}</div>` +
      `</div>`
  );

  // The decisive test: audio the browser created itself.
  let recorded = null;
  try {
    recorded = await recordTone(2);
  } catch (err) {
    recorded = { error: err.message };
  }

  if (recorded?.error) {
    out.insertAdjacentHTML(
      "beforeend",
      `<div class="notice notice--warn"><strong>无法在浏览器内录音</strong><br>` +
        `<span style="font-size:12px">${recorded.error}</span><br>` +
        `这一步被跳过，下面的解码器结论可靠性降低。</div>`
    );
  } else {
    const url = URL.createObjectURL(recorded.blob);
    const result = await tryPlay(url);
    let plays = false;
    if (result.kind === "loaded") {
      const v = document.createElement("video");
      v.src = url;
      v.muted = false;
      try {
        await v.play();
        await new Promise((r) => setTimeout(r, 400));
        plays = !v.paused && v.currentTime > 0;
      } catch {
        plays = false;
      }
      v.pause();
      v.removeAttribute("src");
    }
    URL.revokeObjectURL(url);

    const ok = plays;
    out.insertAdjacentHTML(
      "beforeend",
      `<div class="notice ${ok ? "notice--ok" : "notice--error"}">` +
        `<strong>决定性测试：播放浏览器自己录制的音频</strong><br>` +
        `<span style="font-family:var(--mono);font-size:12px">` +
        `录制格式 ${recorded.mimeType} · ${recorded.size} bytes<br>` +
        `播放结果 ${plays ? "✓ 可以播放" : `✗ 失败（${result.kind}${result.errorCode ? ` code=${result.errorCode}` : ""}${result.errorMessage ? ` "${result.errorMessage}"` : ""}）`}` +
        `</span><br><br>` +
        (ok
          ? `这台浏览器能播放它自己录制的音频，所以音频解码器是可用的。`
          : `<strong>这台浏览器连它自己刚录制的音频都播不了。</strong>` +
            `这说明音频解码存在系统性问题，与我们的视频文件无关。`) +
        `</div>`
    );
  }

  // Second signal: a container whose audio codec is unrelated to AAC (Opus in WebM).
  //
  // The audio is generated INSIDE the page: a 440 Hz tone encoded by MediaRecorder. An earlier
  // version played fixed files out of /test/, but those were only ever scaffolding for a specific
  // bug hunt and have been deleted -- a diagnostic should not depend on fixture files that can go
  // missing.
  try {
    const tone = await recordTone(2);
    if (tone?.error) throw new Error(tone.error);

    const url = URL.createObjectURL(tone.blob);
    const result = await tryPlay(url);
    URL.revokeObjectURL(url);

    const fmt = (r) =>
      r.kind === "loaded"
        ? `<span style="color:#42d392">✓ ${r.size}</span>`
        : `<span style="color:#ff5d5d">✗ ${r.kind}${r.errorCode ? ` code=${r.errorCode}` : ""}${r.errorMessage ? ` "${r.errorMessage}"` : ""}</span>`;

    out.insertAdjacentHTML(
      "beforeend",
      `<div class="notice notice--info"><strong>播放浏览器录制的音频（${tone.mimeType}）</strong>` +
        `<div style="margin-top:8px;font-size:13px;font-family:var(--mono)">${fmt(result)}</div>` +
        `<div style="margin-top:6px;font-size:12px;color:var(--text-faint)">` +
        `如果这一条通过，说明音频解码可用；那么 AR 里没声音就另有原因。</div></div>`
    );
  } catch (err) {
    out.insertAdjacentHTML(
      "beforeend",
      `<div class="notice notice--warn"><strong>无法生成测试音频</strong><br>` +
        `<span style="font-size:12px">${err.message}</span></div>`
    );
  }

  window.__CODEC_TEST__ = { caps: c };
};

document.getElementById("run").addEventListener("click", () => void run());
