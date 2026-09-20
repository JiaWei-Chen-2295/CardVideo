// The floating video screen: geometry, materials, and the rise/dismiss animation.
//
// Placement (DESIGN.md §4.3) is intentionally hard-coded rather than user-tunable:
// the screen's final pose is defined by POSE below, expressed as multiples of the
// tracked photo's width so it scales correctly no matter how large the photo is printed.
//
// Coordinate frame reminder: MindAR's anchor group maps the tracked target into a local
// space where the photo spans [-w/2, w/2] x [-h/2, h/2] on the XY plane and +Z points
// out of the photo toward the camera. So "lifting" the screen means offsetting along +Z,
// and "above the photo" means +Y.

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  DoubleSide,
  VideoTexture,
  CanvasTexture,
} from "three";

/** Final resting pose of the screen, as multiples of the tracked photo's width. */
export const POSE = {
  /** How far the screen floats off the photo surface (+Z is out of the photo). */
  liftFactor: 0.25,
  /** How far the screen's centre sits above the photo's centre (+Y). */
  riseFactor: 0.06,
  /** Screen width relative to the photo width. */
  widthFactor: 1.2,
  /** Tilt toward the viewer, in degrees. */
  tiltDegrees: 18,
  /** Outline thickness relative to the photo width. */
  borderFactor: 0.035,
};

/** Rise/fall timing. Long enough to read as motion, short enough not to feel slow. */
export const RISE_DURATION_MS = 700;

/** Retracting is faster than rising: dismissal should feel decisive, not lingering. */
export const HIDE_DURATION_MS = 420;

/**
 * How long the screen keeps its last pose after tracking is lost (DESIGN.md P9).
 * Without this grace period, ordinary hand tremor makes the screen flicker in and out;
 * with it, brief losses are invisible and the video simply pauses.
 */
export const TRACKING_GRACE_MS = 800;

const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInCubic = (t) => t ** 3;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Build the 3D video screen.
 *
 * @param {object} options
 * @param {HTMLVideoElement} options.video     already-loaded video element
 * @param {number} options.targetWidth         tracked photo width in anchor units
 * @param {number} options.targetHeight        tracked photo height in anchor units
 * @param {number} [options.videoAspect]       width/height of the video; falls back to the element
 * @returns {object} the screen handle
 */
export function createVideoScreen({ video, targetWidth, targetHeight, videoAspect }) {
  const aspect =
    Number.isFinite(videoAspect) && videoAspect > 0
      ? videoAspect
      : video.videoWidth && video.videoHeight
        ? video.videoWidth / video.videoHeight
        : 16 / 9;

  const screenWidth = targetWidth * POSE.widthFactor;
  const screenHeight = screenWidth / aspect;
  const border = targetWidth * POSE.borderFactor;
  const halfDepth = Math.max(screenHeight * 0.055, targetWidth * 0.012);

  const group = new Group();
  group.matrixAutoUpdate = true;

  // --- video face -----------------------------------------------------------
  //
  // The texture is attached only once the video reports real dimensions.
  //
  // This is not tidiness. A THREE.VideoTexture samples `video.videoWidth/videoHeight` when it
  // first uploads, and three.js only marks it dirty when those values are valid. The AR flow
  // necessarily builds the scene BEFORE the video has loaded (the scene must exist so the rise
  // animation can start the instant tracking locks on), so a texture created here and now would
  // be initialised from a 0x0 source and can stay permanently black -- a black screen with no
  // error anywhere.
  const placeholder = new MeshBasicMaterial({ color: 0x0b0f16, toneMapped: false, side: DoubleSide });
  placeholder.name = "video-placeholder";
  const face = new Mesh(new PlaneGeometry(screenWidth, screenHeight), placeholder);
  face.position.z = halfDepth;
  group.add(face);

  let texture = null;
  let faceMaterial = placeholder;
  let videoReady = false;
  /** Frames rendered since attachment; used to force the first uploads. */
  let framesSinceAttach = 0;

  const attachVideoTexture = () => {
    if (texture || !video.videoWidth || !video.videoHeight) return false;

    texture = new VideoTexture(video);
    texture.colorSpace = "srgb";
    texture.needsUpdate = true;

    const material = new MeshBasicMaterial({
      map: texture,
      toneMapped: false,
      side: DoubleSide,
    });
    face.material = material;
    placeholder.dispose();
    faceMaterial = material;
    videoReady = true;
    return true;
  };

  // Attach on the events, AND on every frame until it succeeds.
  //
  // The per-frame attempt is not belt-and-braces, it is load-bearing. `loadeddata` fires exactly
  // once, so if it has already fired by the time this function runs -- which happens when the video
  // is served from a fast CDN and finishes loading before the AR scene is built -- the listener
  // never fires and the texture is never attached. The symptom is precise and misleading: the
  // element plays, so the audio is audible, while the screen stays black because no video frame
  // ever reaches the GPU. That is a race between an event that has already happened and a listener
  // registered afterwards, and no ordering of one-shot listeners can close it.
  attachVideoTexture();
  video.addEventListener("loadeddata", attachVideoTexture);
  video.addEventListener("playing", attachVideoTexture);
  video.addEventListener("timeupdate", attachVideoTexture);

  // --- bezel ----------------------------------------------------------------
  // A flat frame drawn behind the video face. Deliberately only 4 meshes with no depth
  // test tricks: it exists to give the screen an edge, not to be a modelled device.
  const bezelMaterial = new MeshBasicMaterial({ color: 0x0d1117, toneMapped: false, side: DoubleSide });
  const outerWidth = screenWidth + border * 2;
  const outerHeight = screenHeight + border * 2;

  const bars = [
    { w: outerWidth, h: border, x: 0, y: (screenHeight + border) / 2 },
    { w: outerWidth, h: border, x: 0, y: -(screenHeight + border) / 2 },
    { w: border, h: screenHeight, x: (screenWidth + border) / 2, y: 0 },
    { w: border, h: screenHeight, x: -(screenWidth + border) / 2, y: 0 },
  ];
  for (const bar of bars) {
    const mesh = new Mesh(new PlaneGeometry(bar.w, bar.h), bezelMaterial);
    mesh.position.set(bar.x, bar.y, halfDepth * 0.5);
    group.add(mesh);
  }

  // --- final pose -----------------------------------------------------------
  const restPosition = {
    x: 0,
    y: targetHeight * POSE.riseFactor,
    z: targetWidth * POSE.liftFactor,
  };
  const restTilt = (POSE.tiltDegrees * Math.PI) / 180;

  // --- animation state ------------------------------------------------------
  /** 0 = flat on the photo, 1 = fully risen. */
  let progress = 0;
  let direction = 0; // -1 falling, 0 idle, +1 rising
  let hidden = true;
  let ghosted = false;

  // Hiding freezes the screen at its current pose instead of teleporting it away, so a
  // momentary tracking loss does not visibly reset the animation.
  let hideTimer = null;

  const applyPose = () => {
    const eased = direction >= 0 ? easeOutCubic(progress) : easeInCubic(progress);

    // Flat on the photo -> standing up. A plane is born facing +Z (toward the camera);
    // rotating +90 degrees about X lays it flat, so we interpolate that rotation out.
    const flatTilt = Math.PI / 2;
    const tilt = flatTilt + (restTilt - flatTilt) * eased;

    group.position.set(
      restPosition.x * eased,
      restPosition.y * eased,
      restPosition.z * eased
    );
    group.rotation.set(tilt, 0, 0);

    // Growing from 60% to full size reinforces the "rising toward you" read.
    const scale = 0.6 + 0.4 * eased;
    group.scale.setScalar(scale);

    // Fade out while retracting so it does not look like a flat card sliding away.
    const opacity = direction < 0 ? clamp01(progress) : 1;
    faceMaterial.opacity = opacity;
    faceMaterial.transparent = opacity < 1;
    bezelMaterial.opacity = opacity;
    bezelMaterial.transparent = opacity < 1;
  };

  applyPose();

  return {
    group,
    screenWidth,
    screenHeight,

    /** True while the screen should be considered on display. */
    get isVisible() {
      return !hidden;
    },

    /** 0..1 rise progress, exposed for status readouts. */
    get riseProgress() {
      return progress;
    },

    /** Begin (or resume) the rise animation. */
    rise() {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (ghosted) {
        // Returning inside the grace window: carry on from where we froze.
        ghosted = false;
        direction = 1;
        hidden = false;
        return;
      }
      hidden = false;
      direction = 1;
      group.visible = true;
    },

    /**
     * Tracking was lost. Latch the current pose and keep it for TRACKING_GRACE_MS before
     * retracting -- see the note on TRACKING_GRACE_MS.
     */
    beginGrace(onExpired) {
      if (hidden || hideTimer) return;
      ghosted = true;
      hideTimer = setTimeout(() => {
        hideTimer = null;
        ghosted = false;
        direction = -1;
        onExpired?.();
      }, TRACKING_GRACE_MS);
    },

    /** Advance the animation. Returns true when the screen just finished retracting. */
    update(deltaMs) {
      // Close the attach race from the render loop, which runs every frame regardless of which
      // media events have or have not fired. Also force the first few uploads: a VideoTexture
      // created from an element that has metadata but no decoded frame yet can upload nothing and
      // then never be marked dirty again, leaving the screen black while the audio plays.
      if (!videoReady) {
        attachVideoTexture();
      } else if (framesSinceAttach < 8) {
        framesSinceAttach++;
        texture.needsUpdate = true;
      }

      if (direction === 0) return false;

      const duration = direction > 0 ? RISE_DURATION_MS : HIDE_DURATION_MS;
      progress += (direction * deltaMs) / duration;

      if (progress >= 1) {
        progress = 1;
        direction = 0;
      } else if (progress <= 0) {
        progress = 0;
        direction = 0;
        if (hidden !== true) {
          hidden = true;
          group.visible = false;
        }
        applyPose();
        return true;
      }
      applyPose();
      return false;
    },

    dispose() {
      if (hideTimer) clearTimeout(hideTimer);
      // The listeners stay attached to the video element, which outlives this screen; detach them so
      // a disposed screen can never be resurrected by a late media event.
      video.removeEventListener("loadeddata", attachVideoTexture);
      video.removeEventListener("playing", attachVideoTexture);
      video.removeEventListener("timeupdate", attachVideoTexture);
      texture?.dispose();
      faceMaterial.dispose();
      bezelMaterial.dispose();
      for (const bar of bars) bar.geometry?.dispose?.();
      for (const child of [...group.children]) {
        if (child.geometry) child.geometry.dispose();
      }
    },

    /** True once the video's pixels are actually on the material rather than the placeholder. */
    get hasVideoTexture() {
      return videoReady;
    },

    /**
     * Diagnostic view of the texture pipeline.
     *
     * Separate from `hasVideoTexture` because the interesting failure is "attached but still black",
     * which needs the source dimensions and the element's frame position to interpret.
     */
    get textureState() {
      return {
        attached: videoReady,
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        currentTime: video.currentTime,
        paused: video.paused,
        readyState: video.readyState,
      };
    },
  };
}

/**
 * Draw a short instruction onto a canvas and wrap it as a texture.
 *
 * This exists so the "point at the photo" hint can be attached to the card in 3D rather
 * than floating over the whole camera feed as a DOM overlay. The canvas is explicitly
 * NOT colour-managed: the text should stay legible rather than be tone-mapped.
 */
export function createHintTexture(text, { width = 640, height = 144 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(10, 14, 22, 0.74)";
  ctx.beginPath();
  ctx.roundRect(4, 4, width - 8, height - 8, (height - 8) / 2);
  ctx.fill();

  ctx.fillStyle = "#e8eef8";
  ctx.font = `600 ${Math.round(height * 0.36)}px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2 + 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = "srgb";
  texture.needsUpdate = true;
  return texture;
}
