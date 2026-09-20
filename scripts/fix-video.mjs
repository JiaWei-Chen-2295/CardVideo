// Make a video file playable in browsers, without re-encoding the video.
//
// WHY THIS IS NEEDED
// A real file was rejected by the browser with
//
//     MediaError code 4: PipelineStatus::DEMUXER_ERROR_DETECTED_AAC
//
// despite having textbook parameters: H.264 High, AAC-LC, 44.1kHz stereo, faststart, standard
// box layout. The video stream was fine -- the AUDIO track's container framing was not, which
// happens with files exported by some mobile apps. Desktop players tolerate it; Chromium's
// demuxer does not, and it rejects the entire file, video included, so the AR screen goes black.
//
// THE FIX
// Re-encode ONLY the audio into a clean AAC track and copy the video bit-for-bit. Video is where
// the size and the quality are, so copying it keeps the output identical where it matters and
// makes the operation take seconds rather than minutes.
//
//   node scripts/fix-video.mjs <input> [output]
//
// Requires ffmpeg on PATH. Without ffmpeg there is no way to do this: repairing a media container
// is not something that can be hand-rolled.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const input = process.argv[2];
const output = process.argv[3];

if (!input) {
  console.error("usage: node scripts/fix-video.mjs <input.mp4> [output.mp4]");
  process.exit(2);
}
if (!existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(2);
}

const haveFfmpeg = (() => {
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
})();

if (!haveFfmpeg) {
  console.error(
    "\nffmpeg was not found on PATH.\n\n" +
      "Repairing a media container needs a real muxer, so this cannot be done without ffmpeg.\n" +
      "Install it, or use a GUI tool that re-exports the file:\n" +
      "  - 剪映 / CapCut: export as MP4 (H.264)\n" +
      "  - HandBrake: preset 'Fast 1080p30', container MP4, Web Optimized on\n" +
      "  - QuickTime Player: File > Export As > 1080p\n"
  );
  process.exit(1);
}

const outPath =
  output ?? join(process.cwd(), `${basename(input, extname(input))}-fixed.mp4`);

console.log(`in   ${input}`);
console.log(`out  ${outPath}`);

// Stream mapping is explicit so an unexpected extra track cannot derail the output:
//   -map 0:v:0 first video track, copied untouched
//   -map 0:a:0 first audio track, re-encoded to AAC-LC
//   -sn -dn drop subtitles and data tracks, which browsers ignore or choke on
const args = [
  "-y",
  "-v", "warning",
  "-i", input,
  "-map", "0:v:0",
  "-map", "0:a:0?",
  "-c:v", "copy",
  "-c:a", "aac",
  "-b:a", "128k",
  "-ar", "44100",
  "-ac", "2",
  "-sn",
  "-dn",
  // faststart moves the index to the front, which the AR viewer needs for progressive playback.
  "-movflags", "+faststart",
  outPath,
];

const started = Date.now();
const run = spawnSync("ffmpeg", args, { encoding: "utf8" });

if (run.status !== 0) {
  console.error("\nffmpeg failed:");
  console.error(run.stderr?.split("\n").slice(-12).join("\n") ?? "(no stderr)");
  process.exit(1);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const size = statSync(outPath).size;
console.log(`\ndone in ${seconds}s, ${(size / 1024 / 1024).toFixed(1)} MB`);

// Verify the result rather than trusting the exit code: confirm the streams and the box order.
const probe = spawnSync(
  "ffprobe",
  [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,profile",
    "-of", "csv=p=0",
    outPath,
  ],
  { encoding: "utf8" }
);
if (probe.status === 0) {
  console.log("\nstreams in the output:");
  for (const line of probe.stdout.trim().split("\n")) console.log(`  ${line}`);
}
console.log(`\nNow use this file for the card / self-check: ${outPath}`);
