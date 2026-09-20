// AR viewing session: camera, tracking, the video screen, and every bit of interaction
// state around them (DESIGN.md P4-P9).
//
// Responsibilities kept here on purpose:
//   - the rise animation and the tracking-loss grace period (P4, P9)
//   - silent autoplay plus the explicit "enable sound" tap (P6). Mobile browsers forbid
//     autoplaying audible media, so the picture is handed over immediately and sound
//     costs exactly one tap -- which also keeps the AR screen from being blocked.
//   - reporting state changes to the page so it can own the DOM chrome (P7, P8).

import { Clock } from "three";
import { createVideoScreen, RISE_DURATION_MS, HIDE_DURATION_MS, TRACKING_GRACE_MS } from "./video-screen.js";

/**
 * Materialise a picked video file into an in-memory Blob and return a blob URL for it.
 *
 * WHY NOT `URL.createObjectURL(file)` DIRECTLY
 * A File from `<input type="file">` can be a lazy handle into a provider such as iCloud Drive or
 * the Photos library rather than a plain byte container. A blob URL over such a handle can fail
 * to stream, and the failure signature is specific and confusing: the media element lands in
 * `networkState = 3` (NETWORK_NO_SOURCE) with NO MediaError, because resource selection gave up
 * before ever attempting a decode. Reading the bytes into an ArrayBuffer forces the provider to
 * hand over real data, and a Blob built from those bytes is an ordinary in-memory object.
 *
 * @returns {Promise<{url: string, revoke: () => void}>}
 */
export async function materializeVideoUrl(file) {
  // A plain File is already a Blob; `arrayBuffer()` is what forces the provider to materialise.
  const bytes = await file.arrayBuffer();
  const blob = new Blob([bytes], { type: file.type || "video/mp4" });
  const url = URL.createObjectURL(blob);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/** Wait for enough metadata that THREE.VideoTexture has real pixels to upload. */
function waitForVideoMetadata(video, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) return resolve();

    const cleanup = () => {
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("canplay", onLoaded);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
    };
    const onLoaded = () => {
      if (video.videoWidth > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      // Surface the media error code rather than a generic message: it is the difference
      // between "format not supported" and "the file is gone".
      const code = video.error?.code;
      const detail =
        { 1: "loading aborted", 2: "network error", 3: "decoding failed", 4: "format not supported" }[
          code
        ] ?? "unknown";
      reject(new Error(`视频加载失败：${detail}（code ${code ?? "?"}）`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `视频在 ${Math.round(timeoutMs / 1000)} 秒内没有准备好（readyState=${video.readyState}）。` +
            `如果是很大的文件，可能是设备解码太慢。`
        )
      );
    }, timeoutMs);

    video.addEventListener("loadeddata", onLoaded);
    video.addEventListener("canplay", onLoaded);
    video.addEventListener("error", onError);
    // Note: no load() here. Calling it would abort an in-flight load; the element already
    // started loading from its src, and `preload="auto"` keeps it going.
  });
}

export class ARViewer {
  /**
   * @param {object} options
   * @param {HTMLElement} options.container   element that hosts the camera feed + canvases
   * @param {string} options.mindUrl          compiled tracking target
   * @param {string} options.videoUrl         video shown on the floating screen
   * @param {number} [options.videoAspect]    width/height, avoids a layout jump
   * @param {(state: object) => void} [options.onState]
   */
  constructor({ container, mindUrl, videoUrl, videoAspect, onState = () => {}, onSoundAvailable = null }) {
    this.container = container;
    this.mindUrl = mindUrl;
    this.videoUrl = videoUrl;
    this.videoAspect = videoAspect;
    this.onState = onState;
    /** Called when the sound control should become visible. Optional. */
    this.onSoundAvailable = onSoundAvailable ?? null;

    this.mindarThree = null;
    this.screen = null;
    this.video = null;
    this.clock = new Clock();
    this.running = false;
    this.disposed = false;
    this.soundEnabled = false;
    this._seenTarget = false;
  }

  emit(state) {
    if (this.disposed) return;
    // Fold in live media-element state on every emit. `waitForVideoMetadata` can stall without
    // ever failing, and when it does the only useful evidence is the element's own numbers --
    // readyState, networkState, currentSrc and MediaError -- not the phase name.
    const media = this.videoDiagnostics?.();
    this.onState(media ? { ...state, media } : state);
  }

  /**
   * Start the session. Call from a user gesture: the camera prompt and iOS audio
   * unlocking both behave best when a tap opened the door.
   */
  async start() {
    this.emit({ phase: "preparing", detail: "正在加载追踪数据" });

    // Load the video and the tracker in parallel. They are independent, and the tracker
    // is the slow part, so serializing them would waste the user's time.
    this.video = this.#createVideoElement();

    // Load the tracker lazily through the import map. `mindar-image-three` maps to
    // mind-ar's pre-bundled render module, which is a true ES module -- so there is no
    // reason to also load it as a classic <script> (that would ship the same 385KB twice).
    // Importing it here also means the camera feed page never pays for the compiler
    // bundle, which is the one that pulls in @tensorflow/tfjs.
    const { MindARThree } = await import("mindar-image-three");

    const mindarThree = new MindARThree({
      container: this.container,
      imageTargetSrc: this.mindUrl,
      // Use our own chrome; mind-ar's built-in overlays would fight the page's UI.
      uiLoading: "no",
      uiScanning: "no",
      uiError: "no",
      // Raise the miss tolerance so a single dropped frame does not register as "lost".
      // The visible behaviour on true loss is still governed by TRACKING_GRACE_MS.
      missTolerance: 5,
      warmupTolerance: 5,
    });
    this.mindarThree = mindarThree;

    this.emit({ phase: "preparing", detail: "正在启动摄像头" });
    await mindarThree.start();

    if (this.disposed) {
      this.#teardown();
      return;
    }

    // With MindARThree the tracked image spans [-1, 1] horizontally, because the adapter
    // bakes the marker width into postMatrix. Reading it back keeps the screen sized to
    // the photo even if a future mind-ar version changes that constant.
    const anchor = mindarThree.addAnchor(0);
    const markerWidth = anchor.group.matrix.elements[0];
    const targetWidth = Number.isFinite(markerWidth) && markerWidth > 0 ? markerWidth : 1;

    // The photo's aspect ratio comes from the tracker itself rather than from the DOM,
    // so the screen is positioned against the real target rectangle. mind-ar exposes
    // this as `markerDimensions`; the second name is defensive against API drift.
    const dims =
      mindarThree.controller.markerDimensions?.[0] ??
      mindarThree.controller.imageTargetDimensions?.[0];
    const targetAspect = dims?.[0] && dims?.[1] ? dims[1] / dims[0] : 0.75;

    this.screen = createVideoScreen({
      video: this.video,
      targetWidth,
      targetHeight: targetWidth * targetAspect,
      videoAspect: this.videoAspect,
    });
    anchor.group.add(this.screen.group);
    this.screen.group.visible = false;

    anchor.onTargetFound = () => {
      this._seenTarget = true;
      this.emit({ phase: "tracking" });
      this.screen.rise();
      this.#startPlayback();
    };
    anchor.onTargetLost = () => {
      this.emit({ phase: "searching" });
      // Freeze the pose, pause the audio, and only retract after the grace period.
      this.#pausePlayback();
      this.screen.beginGrace(() => this.emit({ phase: "searching", retracted: true }));
    };

    this.running = true;
    this.emit({ phase: "searching" });
    this.#loop();
  }

  #createVideoElement() {
    const video = document.createElement("video");
    video.loop = true;
    // Silent autoplay (design decision P6). Both the property AND the attribute are set, and
    // `enableSound` clears both: a `muted` content attribute can survive a property assignment in
    // some browsers, which shows up as "the button did nothing".
    video.muted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.preload = "auto";

    // CROSS-ORIGIN MODE, for cross-origin sources only.
    //
    // A video frame can only be uploaded as a WebGL texture if the media was fetched in CORS mode.
    // Without it the browser refuses the upload and -- this is the part that costs hours -- it does
    // so SILENTLY: no error, no exception, and the element goes on playing, so the audio is audible
    // while the screen stays black. Nothing in the element's own state reveals it (`currentTime`
    // advances, `readyState` is 4, `error` is null), which is why the texture state looked healthy
    // while the screen rendered nothing.
    //
    // Set only when the source is actually cross-origin, because the attribute forces a CORS fetch
    // that a same-origin or blob URL neither needs nor always satisfies, and it must be set BEFORE
    // `src` or it has no effect.
    let crossOrigin = false;
    try {
      crossOrigin = new URL(this.videoUrl, location.href).origin !== location.origin;
    } catch {
      crossOrigin = false;
    }
    if (crossOrigin) {
      video.crossOrigin = "anonymous";
      video.setAttribute("crossorigin", "anonymous");
    }
    this.videoIsCrossOrigin = crossOrigin;

    // Rendered only through the WebGL texture, so it must stay in the document (browsers refuse
    // to decode detached media) but must never be visible or intercept touches.
    video.style.position = "absolute";
    video.style.width = "2px";
    video.style.height = "2px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    video.style.top = "0";
    video.style.left = "0";

    // ORDER MATTERS: attach to the document BEFORE assigning src. A detached element has no document
    // to run the media resource selection algorithm in, which on a real phone left it in
    // networkState=3 -- the browser had given up on a source it never tried to fetch.
    this.container.appendChild(video);
    video.src = this.videoUrl;
    video.load();

    this.videoDiagnostics = () => {
      const screen = this.screen?.textureState;
      return {
        readyState: video.readyState,
        networkState: video.networkState,
        currentSrc: video.currentSrc || "(none)",
        // MediaError codes are the difference between "format unsupported" and "network died".
        error: video.error ? `code ${video.error.code}: ${video.error.message || "no message"}` : "none",
        size: `${video.videoWidth}x${video.videoHeight}`,
        paused: video.paused,
        muted: video.muted,
        time: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        // The texture pipeline, reported separately from the element: a video can be playing with
        // audible sound while the screen stays black, because the element's audio and its frames
        // travel different paths. `crossOrigin` matters because a frame from a cross-origin source
        // that was NOT fetched in CORS mode cannot be uploaded as a WebGL texture at all.
        textured: screen?.attached ?? null,
        crossOrigin: this.videoIsCrossOrigin ?? null,
      };
    };

    return video;
  }

  async #startPlayback() {
    if (!this.video || this.disposed) return;

    // Show the sound control as soon as the media element has data, independent of everything else
    // on this page.
    //
    // It used to be revealed only by the `tracking` state emitted after `play()` resolved, which
    // made a UI affordance depend on the timing of async playback. On the share-link page that
    // chain did not complete, so the button never appeared and the audio was unreachable -- the
    // video played silently and there was no way to turn sound on. A control the user needs must not
    // be gated on an unrelated promise settling.
    this.#revealSoundControl();

    try {
      await waitForVideoMetadata(this.video);
      await this.video.play();
      this.#revealSoundControl();
      // Report real state, not intent: `play()` resolving does not by itself prove frames are
      // advancing, and a screen stuck on the placeholder looks identical to a black video.
      this.emit({
        phase: "tracking",
        playing: !this.video.paused && this.video.currentTime > 0,
        sound: this.soundEnabled,
        video: `${this.video.videoWidth}x${this.video.videoHeight}`,
        textured: this.screen?.hasVideoTexture === true,
      });
    } catch (err) {
      // A blocked autoplay is recoverable: the first user tap will start it. A rejected source
      // is not, so the reason is surfaced verbatim -- including the browser's own MediaError
      // classification, because "networkState 3" and "codec unsupported" need different fixes.
      const net = this.video?.networkState;
      const mediaError = this.video?.error;
      const reason =
        mediaError
          ? `浏览器无法解码这个视频：${mediaError.message || `MediaError ${mediaError.code}`}`
          : net === 3
            ? "浏览器拒绝了这个视频源（networkState=3）。通常意味着编码格式或容器不被支持，" +
              "或者是这个文件的 moov 索引在末尾导致无法边下边播。"
            : err.message;
      console.warn("[ar] playback did not start", err, { networkState: net, mediaError });
      this.emit({
        phase: "tracking",
        playing: false,
        sound: this.soundEnabled,
        error: reason,
        fatalVideo: net === 3 || Boolean(mediaError),
      });
    }
  }

  /**
   * Bring the sound control into view, if this page has one and sound is not already on.
   *
   * Called from several points rather than one: any of them may be the first to run depending on
   * how playback resolves, and showing the control twice is harmless.
   */
  #revealSoundControl() {
    if (this.soundEnabled) return;
    if (!this.video || this.video.videoWidth === 0) return;
    // A file with no audio track can never produce sound, so offering the control would be a lie.
    const tracks = this.video.audioTracks;
    if (tracks && tracks.length === 0) return;
    this.onSoundAvailable?.();
  }

  #pausePlayback() {
    if (this.video && !this.video.paused) this.video.pause();
  }

  /**
   * Turn sound on. Must be called from a user gesture on iOS; afterwards playback keeps
   * its audio even across tracking losses.
   */
  async enableSound() {
    if (!this.video) return false;
    this.video.muted = false;
    this.video.removeAttribute("muted");
    this.video.volume = 1;
    try {
      await this.video.play();
    } catch {
      /* the gesture may still have been rejected; the button stays available */
    }
    this.soundEnabled = !this.video.muted;
    this.emit({ phase: "tracking", sound: this.soundEnabled, playing: !this.video.paused });
    return this.soundEnabled;
  }

  toggleSound() {
    return this.soundEnabled ? this.disableSound() : this.enableSound();
  }

  disableSound() {
    if (!this.video) return false;
    this.video.muted = true;
    this.video.setAttribute("muted", "");
    this.soundEnabled = false;
    this.emit({ phase: "tracking", sound: false, playing: !this.video.paused });
    return false;
  }

  #loop() {
    if (!this.running || this.disposed) return;
    this._raf = requestAnimationFrame(() => this.#loop());

    const deltaMs = this.clock.getDelta() * 1000;
    if (this.screen) this.screen.update(deltaMs);

    // MindAR renders its own scene graph; we only drive our per-frame animation.
    this.mindarThree?.renderer.render(this.mindarThree.scene, this.mindarThree.camera);
  }

  /** Release the camera and all GPU resources. Safe to call more than once. */
  #teardown() {
    try {
      this.mindarThree?.controller?.stopProcessVideo?.();
    } catch (err) {
      console.warn("[ar] controller stop failed", err);
    }
    try {
      const stream = this.mindarThree?.video?.srcObject;
      stream?.getTracks?.().forEach((track) => track.stop());
    } catch (err) {
      console.warn("[ar] camera release failed", err);
    }
    try {
      this.video?.pause();
      this.video?.removeAttribute("src");
      this.video?.load?.();
      this.video?.remove();
    } catch (err) {
      console.warn("[ar] video cleanup failed", err);
    }
    try {
      this.screen?.dispose();
    } catch (err) {
      console.warn("[ar] screen dispose failed", err);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.#teardown();
    // Drop mind-ar's own canvases; the page removes the container afterwards.
    this.container.replaceChildren();
  }
}

export { RISE_DURATION_MS, HIDE_DURATION_MS, TRACKING_GRACE_MS };
