// The creator flow: pick a photo and a video, get a shareable link.
//
// Order of operations is deliberate and each step exists to avoid wasting the creator's
// time (DESIGN.md P10, §5, §8-Q4):
//
//   1. inspect the VIDEO first      -- milliseconds, and the cheapest possible failure.
//                                       An HEVC upload would otherwise burn a CPU-bound
//                                       compile and a full upload before failing.
//   2. pre-check the PHOTO          -- ~200ms using mind-ar's real feature extractor.
//                                       Rejecting an untrackable photo here is the whole
//                                       point: a viewer holding a card that can never be
//                                       scanned has no way to understand what went wrong.
//   3. compile the .mind            -- seconds of CPU in a worker, with real progress.
//   4. upload everything            -- browser -> storage directly (Vercel caps request
//                                       bodies at 4.5MB, so nothing large goes via the API).
//   5. offer the SELF-CHECK         -- let the creator prove the photo tracks on their own
//                                       phone before anyone else is involved.

import { precheckFile } from "/js/ar/precheck.js";
import { compileTarget } from "/js/ar/mind-compile.js";
import { inspectVideoFile } from "/js/ar/mp4-meta.js";

const MIN_TRACKING_POINTS = 8;

const els = {
  form: document.getElementById("form"),
  photo: document.getElementById("photo"),
  video: document.getElementById("video"),
  title: document.getElementById("title"),
  submit: document.getElementById("submit"),
  status: document.getElementById("status"),
  steps: document.getElementById("steps"),
  progress: document.getElementById("progress"),
  progressBar: document.getElementById("bar"),
  progressLabel: document.getElementById("progress-label"),
  result: document.getElementById("result"),
  shareUrl: document.getElementById("share-url"),
  copy: document.getElementById("copy"),
  selfcheck: document.getElementById("selfcheck"),
  manage: document.getElementById("manage"),
  deleteBtn: document.getElementById("delete-card"),
  manageNote: document.getElementById("manage-note"),
  reset: document.getElementById("reset"),
};

const STEP_ORDER = ["video", "photo", "compile", "upload"];

/** Mark a step active/done/error, and keep everything above it visually settled. */
function setStep(name, state) {
  const node = els.steps.querySelector(`[data-step="${name}"]`);
  if (!node) return;
  node.dataset.state = state;
  const dot = node.querySelector(".step__dot");
  if (dot) dot.textContent = state === "done" ? "✓" : state === "error" ? "!" : "";
  void STEP_ORDER;
}

function resetSteps() {
  for (const node of els.steps.querySelectorAll(".step")) {
    node.dataset.state = "";
    const dot = node.querySelector(".step__dot");
    if (dot) dot.textContent = "";
  }
  els.progress.hidden = true;
  els.progressBar.style.width = "0%";
  els.progressLabel.textContent = "";
}

const showStatus = (kind, html) => {
  els.status.hidden = false;
  els.status.className = `notice notice--${kind}`;
  els.status.innerHTML = html;
};

const clearStatus = () => {
  els.status.hidden = true;
  els.status.innerHTML = "";
};

const setProgress = (percent, label) => {
  els.progress.hidden = false;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressLabel.textContent = label ?? `${Math.round(percent)}%`;
};

const setBusy = (busy, label = "生成中…") => {
  els.submit.disabled = busy;
  els.photo.disabled = busy;
  els.video.disabled = busy;
  els.title.disabled = busy;
  els.submit.innerHTML = busy
    ? `<span class="spinner" aria-hidden="true"></span><span>${label}</span>`
    : "<span>生成分享链接</span>";
};

/** PUT bytes to wherever the ticket points (local disk endpoint or R2 presigned URL). */
async function uploadTo(ticket, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method ?? "PUT", ticket.uploadUrl, true);
    for (const [header, value] of Object.entries(ticket.headers ?? {})) {
      try {
        xhr.setRequestHeader(header, value);
      } catch {
        /* some headers are forbidden for presigned URLs; the signature covers them */
      }
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`上传失败（HTTP ${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error("上传失败：网络错误"));
    xhr.ontimeout = () => reject(new Error("上传超时"));
    xhr.send(body);
  });
}

// ------------------------------------------------------------------- main flow

async function generate(event) {
  event.preventDefault();
  clearStatus();
  resetSteps();
  els.result.hidden = true;

  const photoFile = els.photo.files?.[0];
  const videoFile = els.video.files?.[0];

  if (!photoFile || !videoFile) {
    showStatus("error", "请同时选择一张照片和一段视频。");
    return;
  }

  setBusy(true);

  try {
    // -- 1. video ------------------------------------------------------------
    setStep("video", "active");
    const videoInfo = await inspectVideoFile(videoFile);
    if (!videoInfo.ok) {
      setStep("video", "error");
      throw new Error(videoInfo.reason);
    }
    setStep("video", "done");

    // -- 2. photo pre-check ---------------------------------------------------
    setStep("photo", "active");
    const verdict = await precheckFile(photoFile);
    if (!verdict.ok) {
      setStep("photo", "error");
      throw new Error(verdict.message);
    }
    setStep("photo", "done");

    // -- 3. compile ----------------------------------------------------------
    setStep("compile", "active");
    setProgress(0, "正在生成追踪数据 0%");
    const compiled = await compileTarget(photoFile, (percent) => {
      setProgress(percent, `正在生成追踪数据 ${percent}%`);
    });

    const trackingPoints = compiled.trackingPoints ?? [];
    const weakest = trackingPoints.length ? Math.min(...trackingPoints) : 0;
    if (weakest < MIN_TRACKING_POINTS) {
      setStep("compile", "error");
      throw new Error(
        "这张照片编译后得到的追踪特征点太少，实际识别会不稳定。" +
          "建议换一张细节更丰富的照片，或给照片加一圈带纹理的边框。"
      );
    }
    setStep("compile", "done");

    // -- 4. upload -----------------------------------------------------------
    setStep("upload", "active");
    const mindFile = new File([compiled.bytes], "target.mind", {
      type: "application/octet-stream",
    });
    const photoExt = (photoFile.name.split(".").pop() || "png").toLowerCase();

    const ticketRes = await fetch("/api/upload-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: "photo,video,mind",
        files: [
          { name: `photo.${photoExt}`, type: photoFile.type, size: photoFile.size },
          { name: videoFile.name, type: videoFile.type, size: videoFile.size },
          { name: "target.mind", type: "application/octet-stream", size: mindFile.size },
        ],
      }),
    });
    if (!ticketRes.ok) {
      const detail = await ticketRes.json().catch(() => ({}));
      throw new Error(detail.error ?? "无法取得上传凭证");
    }
    const { cardId, tickets } = await ticketRes.json();
    const byKind = Object.fromEntries(tickets.map((t) => [t.kind, t]));

    // The video dominates the transfer time, so weight the progress bar toward it.
    const weights = { photo: 0.15, mind: 0.1, video: 0.75 };
    const done = { photo: 0, mind: 0, video: 0 };
    const reportUpload = () => {
      const total = Object.entries(weights).reduce((sum, [kind, w]) => sum + w * done[kind], 0);
      setProgress(total * 100, `正在上传 ${Math.round(total * 100)}%`);
    };

    setProgress(0, "正在上传 0%");
    await uploadTo(byKind.photo, photoFile, (p) => {
      done.photo = p;
      reportUpload();
    });
    await uploadTo(byKind.mind, mindFile, (p) => {
      done.mind = p;
      reportUpload();
    });
    await uploadTo(byKind.video, videoFile, (p) => {
      done.video = p;
      reportUpload();
    });

    const createRes = await fetch("/api/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cardId,
        photoKey: byKind.photo.key,
        videoKey: byKind.video.key,
        mindKey: byKind.mind.key,
        title: els.title.value.trim(),
        videoAspect: videoInfo.aspect,
        trackingPoints: weakest,
      }),
    });
    if (!createRes.ok) {
      const detail = await createRes.json().catch(() => ({}));
      throw new Error(detail.error ?? "创建卡片失败");
    }
    const { ownerToken } = await createRes.json();
    setStep("upload", "done");
    els.progress.hidden = true;

    // -- 5. hand-off ---------------------------------------------------------
    // Remember the owner token locally so the manage section works on a revisit, and
    // stash the compiled target + video for a self-check run that needs no upload.
    try {
      localStorage.setItem(`cardvideo:owner:${cardId}`, ownerToken);
    } catch {
      /* private mode; the manage link below still works for this session */
    }

    const shareUrl = `${location.origin}/c/${cardId}`;
    els.shareUrl.value = shareUrl;

    // Self-check re-selects the same two files rather than receiving them from here: passing a
    // video between pages would mean persisting it in browser storage, which is fragile and
    // unnecessary. See the note at the top of /js/selfcheck.js.
    els.selfcheck.href = "/selfcheck";

    els.manageNote.textContent = "";
    els.deleteBtn.hidden = false;
    els.deleteBtn.dataset.cardId = cardId;
    els.deleteBtn.dataset.ownerToken = ownerToken;

    els.result.hidden = false;
    els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });

    showStatus(
      "ok",
      `卡片已生成（追踪特征点 ${trackingPoints.join(" / ")}）。` +
        `下一步：<strong>先自己用手机扫一遍</strong>，确认照片能被识别，再把链接和照片发出去。`
    );
  } catch (err) {
    console.error("[create] failed", err);
    const step = els.steps.querySelector('.step[data-state="active"]');
    if (step) {
      step.dataset.state = "error";
      const dot = step.querySelector(".step__dot");
      if (dot) dot.textContent = "!";
    }
    els.progress.hidden = true;
    showStatus("error", err.message ?? "生成失败，请重试。");
  } finally {
    setBusy(false);
  }
}

els.form.addEventListener("submit", generate);

els.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.shareUrl.value);
    els.copy.textContent = "已复制";
    setTimeout(() => (els.copy.textContent = "复制"), 1500);
  } catch {
    // Clipboard access can be denied; selecting the text is a fine fallback.
    els.shareUrl.select();
  }
});

els.deleteBtn.addEventListener("click", async () => {
  const { cardId, ownerToken } = els.deleteBtn.dataset;
  if (!cardId || !ownerToken) return;
  if (!confirm("删除后这个链接和视频都会失效，且无法恢复。确定删除吗？")) return;

  els.deleteBtn.disabled = true;
  try {
    const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}`, {
      method: "DELETE",
      headers: { "x-owner-token": ownerToken },
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error ?? "删除失败");
    }
    try {
      localStorage.removeItem(`cardvideo:owner:${cardId}`);
    } catch {
      /* ignore */
    }
    els.result.hidden = true;
    showStatus("ok", "卡片已删除，链接和视频都已失效。");
  } catch (err) {
    showStatus("error", err.message ?? "删除失败");
  } finally {
    els.deleteBtn.disabled = false;
  }
});

els.reset.addEventListener("click", () => {
  els.form.reset();
  resetSteps();
  clearStatus();
  els.result.hidden = true;
  void els.form.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Surface file choices immediately so the form never feels inert.
for (const input of [els.photo, els.video]) {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const mb = (file.size / 1024 / 1024).toFixed(1);
    showStatus("info", `已选择 ${file.name}（${mb}MB）。点击下方按钮开始生成。`);
  });
}
