// Read an MP4's dimensions, duration and codec in the browser, without decoding it.
//
// Why parse the container instead of just asking the video element: the AR screen refuses
// to show a video whose codec the browser cannot decode, and a failure there is invisible
// (a black screen with no error). Checking the codec BEFORE compiling the tracking target
// means an HEVC upload is rejected in milliseconds instead of after seconds of CPU work
// and a finished upload. The server independently re-derives the aspect ratio from the
// same box structure (server/lib/mp4.js), so this is not the only line of defence.
//
// Only the header region is read -- a 300MB video is never loaded into memory here.

/** How much of the file to inspect. Enough for a faststart moov plus generous slack. */
const HEADER_PROBE_BYTES = 2 * 1024 * 1024;

/** Codecs that actually decode in Chrome on Android, Safari and desktop browsers. */
const PLAYABLE_CODECS = new Set(["avc1", "avc3", "vp09", "av01"]);

// ------------------------------------------------------------------ capabilities

/**
 * What this browser can actually decode.
 *
 * Worth asking directly rather than inferring from a playback failure: a device that cannot
 * decode AAC at all is telling us something categorically different from a device that dislikes
 * one particular file. This distinction was the source of a wrong diagnosis -- an AAC demuxer
 * error was blamed on a malformed audio track, re-encoding changed nothing, and only a
 * video-only file revealed the truth, which is that the browser has no AAC decoder.
 *
 * `canPlayType` is the portable signal; MediaSource is more precise where it exists.
 */
export function codecCapabilities() {
  const probe = document.createElement("video");

  const canPlay = (type) => {
    const answer = probe.canPlayType(type);
    return answer === "probably" || answer === "maybe";
  };

  const mse = typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function";
  const mseSupports = (type) => {
    if (!mse) return null;
    try {
      return MediaSource.isTypeSupported(type);
    } catch {
      return null;
    }
  };

  const videoH264 = canPlay('video/mp4; codecs="avc1.42E01E"');
  const audioAac = canPlay('audio/mp4; codecs="mp4a.40.2"');
  const audioMp3 = canPlay("audio/mpeg");
  const audioOpus = canPlay('audio/webm; codecs="opus"');
  const audioPcm = canPlay('audio/wav; codecs="1"');

  return {
    videoH264,
    audioAac,
    audioMp3,
    audioOpus,
    audioPcm,
    mseAudioAac: mseSupports('audio/mp4; codecs="mp4a.40.2"'),
    mseVideoH264: mseSupports('video/mp4; codecs="avc1.42E01E"'),
    /** True when no audio codec we could reasonably offer is decodable. */
    get noAudioAtAll() {
      return !audioAac && !audioMp3 && !audioOpus && !audioPcm;
    },
    userAgent: navigator.userAgent,
  };
}

/** Human-readable summary line for the diagnostics panel. */
export function describeCapabilities(caps) {
  const mark = (value) => (value === null ? "?" : value ? "yes" : "NO");
  return (
    `H.264 ${mark(caps.videoH264)} | AAC ${mark(caps.audioAac)} | MP3 ${mark(caps.audioMp3)} | ` +
    `Opus ${mark(caps.audioOpus)} | WAV ${mark(caps.audioPcm)}` +
    (caps.mseAudioAac === null ? "" : ` | MSE-AAC ${mark(caps.mseAudioAac)}`)
  );
}

const CODEC_LABELS = {
  hvc1: "HEVC / H.265",
  hev1: "HEVC / H.265",
  mp4v: "MPEG-4 Visual",
  vp08: "VP8",
  avc1: "H.264",
};

/** Iterate ISO-BMFF boxes within [start, end). */
function* boxes(view, start, end) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end) return;
      const hi = view.getUint32(offset + 8);
      const lo = view.getUint32(offset + 12);
      size = hi * 2 ** 32 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) return;
    yield { type, start: offset + headerSize, end: offset + size };
    offset += size;
  }
}

const findBox = (view, start, end, type) => {
  for (const box of boxes(view, start, end)) if (box.type === type) return box;
  return null;
};

/** Locate the video track's sample description entry. */
function findVideoSampleEntry(view) {
  const moov = findBox(view, 0, view.byteLength, "moov");
  if (!moov) return { missingMoov: true };

  for (const trak of boxes(view, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;

    const mdia = findBox(view, trak.start, trak.end, "mdia");
    if (!mdia) continue;

    const hdlr = findBox(view, mdia.start, mdia.end, "hdlr");
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      view.getUint8(hdlr.start + 8),
      view.getUint8(hdlr.start + 9),
      view.getUint8(hdlr.start + 10),
      view.getUint8(hdlr.start + 11)
    );
    if (handler !== "vide") continue;

    const minf = findBox(view, mdia.start, mdia.end, "minf");
    const stbl = minf && findBox(view, minf.start, minf.end, "stbl");
    const stsd = stbl && findBox(view, stbl.start, stbl.end, "stsd");
    if (!stsd) continue;

    // stsd payload: version/flags (4) + entry_count (4), then the sample entries.
    for (const entry of boxes(view, stsd.start + 8, stsd.end)) {
      return {
        codec: entry.type,
        width: view.getUint16(entry.start + 24),
        height: view.getUint16(entry.start + 26),
      };
    }
  }
  return { noVideoTrack: true };
}

/** Duration in seconds from the movie header. */
function readDuration(view, moov) {
  const mvhd = findBox(view, moov.start, moov.end, "mvhd");
  if (!mvhd) return null;

  const version = view.getUint8(mvhd.start);
  if (version === 1) {
    const timescale = view.getUint32(mvhd.start + 20);
    const duration = view.getUint32(mvhd.start + 24) * 2 ** 32 + view.getUint32(mvhd.start + 28);
    return timescale ? duration / timescale : null;
  }
  const timescale = view.getUint32(mvhd.start + 12);
  const duration = view.getUint32(mvhd.start + 16);
  return timescale ? duration / timescale : null;
}

/**
 * Inspect a video file.
 *
 * @param {File|Blob} file
 * @returns {Promise<{ok: boolean, codec?: string, width?: number, height?: number,
 *                    aspect?: number, durationSeconds?: number, reason?: string}>}
 */
export async function inspectVideoFile(file) {
  const slice = file.slice(0, Math.min(HEADER_PROBE_BYTES, file.size));
  const buffer = await slice.arrayBuffer();
  const view = new DataView(buffer);

  if (view.byteLength < 16) {
    return { ok: false, reason: "文件太小，不像是视频。" };
  }

  const brand = String.fromCharCode(
    view.getUint8(4),
    view.getUint8(5),
    view.getUint8(6),
    view.getUint8(7)
  );
  if (brand !== "ftyp") {
    return { ok: false, reason: "这不是一个 MP4 文件。请上传 MP4 格式（H.264 编码）。" };
  }

  const entry = findVideoSampleEntry(view);
  if (entry.missingMoov) {
    // Not fatal by itself -- the moov box may sit at the end of an unfaststarted file --
    // but the AR page needs it early, so tell the user how to fix it rather than
    // failing later with no explanation.
    return {
      ok: false,
      needsFaststart: true,
      reason:
        "这个 MP4 的索引信息在文件末尾，浏览器无法边下边播。请用 ffmpeg 加 " +
        "`-movflags +faststart` 重新导出，或换一个视频。",
    };
  }
  if (entry.noVideoTrack) {
    return { ok: false, reason: "这个文件里没有视频轨道。" };
  }

  const moov = findBox(view, 0, view.byteLength, "moov");
  const heading = entry.codec;

  if (!PLAYABLE_CODECS.has(heading)) {
    const label = CODEC_LABELS[heading] ?? heading;
    return {
      ok: false,
      codec: heading,
      reason:
        `${label} 视频在部分手机浏览器上无法播放（尤其是安卓 Chrome），` +
        `在 AR 里会表现为黑屏。请导出为 H.264（MP4）后重新上传。`,
    };
  }

  return {
    ok: true,
    codec: heading,
    width: entry.width,
    height: entry.height,
    aspect: entry.width / entry.height,
    durationSeconds: moov ? readDuration(view, moov) : null,
  };
}
