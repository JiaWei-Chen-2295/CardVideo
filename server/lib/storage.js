// Media storage behind one small interface, with two implementations:
//
//   disk  -- local development. Stores bytes under data/media and serves them from
//            the Node process. Zero cloud credentials needed, so the whole pipeline
//            (compile -> upload -> share -> view) runs on a laptop.
//   r2    -- production. Cloudflare R2 is S3-compatible, so we hand out presigned PUT
//            URLs and the browser uploads straight to R2. This is not optional:
//            Vercel caps request bodies at 4.5MB, so a video can never pass through
//            the function (DESIGN.md §3.3 and the note in §6.1).
//
// The presigned PUT *is* the upload-security boundary -- anyone holding one ticket can
// write exactly one object under one key. Tickets are short-lived and scoped.

import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { HttpError } from "./config.js";

/**
 * Extensions that may appear in an object key.
 *
 * There is no `json` here. Metadata moved to a database, and nothing else writes JSON to the bucket
 * -- keeping the allow-list to media means a crafted key has no interesting target even if a future
 * change forgets to validate one.
 */
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "mp4", "m4v", "webm", "mind"]);

const CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mind: "application/octet-stream",
};

export const contentTypeForExt = (ext) => CONTENT_TYPES[ext] ?? "application/octet-stream";

/**
 * Reject anything that could escape the storage root. Keys are always built by the server
 * (`cards/<id>/<name>.<ext>`), but the client round-trips them, so treat them as untrusted input
 * on every read.
 */
export function assertSafeKey(key) {
  const value = String(key ?? "");
  if (!value || value.length > 200) throw new HttpError(400, "invalid object key");
  if (value.includes("..") || value.startsWith("/") || value.includes("\\")) {
    throw new HttpError(400, "invalid object key");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z/_\-.]*$/.test(value)) throw new HttpError(400, "invalid object key");
  const ext = value.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXT.has(ext)) throw new HttpError(400, `unsupported file type: ${ext}`);
  return value;
}

/** Object key for a card asset. Kept in one place so disk and R2 layout never diverge. */
export function cardKey(cardId, kind, ext) {
  return assertSafeKey(`cards/${cardId}/${kind}.${String(ext).toLowerCase()}`);
}

// ------------------------------------------------------------------ disk adapter

export function createDiskStorage({ root, publicPrefix = "/media/" }) {
  const mediaRoot = join(root, "media");

  const resolve = (key, options) => {
    const safe = assertSafeKey(key, options);
    const full = normalize(join(mediaRoot, safe));
    // Defence in depth: normalize() can still escape if the key was crafted.
    if (!full.startsWith(mediaRoot + sep) && full !== mediaRoot) {
      throw new HttpError(400, "invalid object key");
    }
    return full;
  };

  return {
    kind: "disk",

    publicUrl: (key) => publicPrefix + assertSafeKey(key),

    /**
     * No presigning locally. The browser PUTs to our own endpoint instead, which keeps
     * the client code identical in shape (one URL, one PUT) even though the mechanism
     * differs from R2.
     */
    async createUploadTicket(key, { contentType } = {}) {
      const safe = assertSafeKey(key);
      return {
        key: safe,
        uploadUrl: `/api/local-upload/${safe}`,
        method: "PUT",
        headers: { "content-type": contentType ?? contentTypeForExt(safe.split(".").pop()) },
      };
    },

    async putObject(key, bytes) {
      const full = resolve(key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, bytes);
      return { key, size: bytes.length };
    },

    async getObject(key) {
      const full = resolve(key);
      try {
        const [bytes, info] = await Promise.all([readFile(full), stat(full)]);
        return { bytes, size: info.size };
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    async deleteObject(key) {
      try {
        await unlink(resolve(key));
        return true;
      } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
      }
    },
  };
}

// ------------------------------------------------------------------ s3 adapter

/**
 * Any S3-compatible object store.
 *
 * Covers Tencent COS, Qiniu Kodo, Alibaba OSS and Cloudflare R2 with one implementation, because
 * they all speak the S3 API. The provider is chosen by configuration, not by code:
 *
 *   COS   S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com   S3_REGION=ap-guangzhou
 *   Qiniu S3_ENDPOINT=https://s3-cn-east-1.qiniucs.com        S3_REGION=cn-east-1
 *   OSS   S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com    S3_REGION=cn-hangzhou
 *   R2    S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com  S3_REGION=auto
 *
 * WHY NOT A PROVIDER-SPECIFIC SDK: this project needs exactly four operations -- presign a PUT,
 * resolve a read URL, delete, and read/write a small metadata object. Every provider offers those
 * over S3, so one adapter replaces four SDKs and their credential formats.
 *
 * WHY R2 WAS ORIGINALLY CHOSEN AND WHY IT CHANGED: R2 charges nothing for egress, which matters
 * because every view downloads a whole video. It also demands a foreign-currency card, which is a
 * hard blocker in mainland China. COS accepts Alipay and gives new accounts 50GB of storage plus
 * 10GB/month of egress for six months, then charges about CNY 0.5/GB for egress. So the trade is
 * explicit: a payment method that works, in exchange for bandwidth that is no longer free.
 */
export async function createS3Storage({
  endpoint,
  region,
  accessKeyId,
  secretAccessKey,
  bucket,
  publicBaseUrl = "",
  forcePathStyle = false,
  uploadUrlTtlSeconds = 900,
  downloadUrlTtlSeconds = 3600,
  label = "s3",
}) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import(
    "@aws-sdk/client-s3"
  );
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const client = new S3Client({
    region,
    endpoint,
    // COS and OSS expect virtual-hosted-style addressing by default; a bucket created before
    // 2024 or behind a proxy may need path style, so it stays switchable.
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });

  const base = publicBaseUrl.replace(/\/+$/, "");

  return {
    kind: label,

    /**
     * Public URL, or null when none is configured.
     *
     * Deliberately NOT derived from the endpoint. Deriving `https://<bucket>.<endpoint-host>` looked
     * obviously correct and matched the address the provider console displays, but it was verified
     * against Qiniu and does not work: its S3-compatible endpoint answers every anonymous request
     * with
     *
     *     <Code>NotSupportAnonymous</Code><Message>request must have signature info</Message>
     *
     * -- even for an object in a public bucket. The shape of the URL being right said nothing about
     * whether the server would serve it, which is why this now requires an explicitly configured
     * domain instead of inferring one.
     */
    publicUrl: (key) => (base ? `${base}/${assertSafeKey(key)}` : null),

    async createUploadTicket(key, { contentType } = {}) {
      const safe = assertSafeKey(key);
      const type = contentType ?? contentTypeForExt(safe.split(".").pop());
      const uploadUrl = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: safe, ContentType: type }),
        { expiresIn: uploadUrlTtlSeconds }
      );
      return { key: safe, uploadUrl, method: "PUT", headers: { "content-type": type } };
    },

    /**
     * Resolve a readable URL.
     *
     * With a bound domain (`S3_PUBLIC_BASE_URL`) this is a plain public URL: cacheable by a CDN and,
     * on Qiniu/COS, billed as cheap back-to-origin traffic rather than expensive direct egress.
     *
     * Without one, a presigned GET is minted. That works everywhere but costs more and cannot be
     * cached, which is the reason binding a domain is worth doing before this scales.
     */
    async readUrl(key) {
      const safe = assertSafeKey(key);
      if (base) return `${base}/${safe}`;
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: safe }), {
        expiresIn: downloadUrlTtlSeconds,
      });
    },

    async deleteObject(key) {
      const safe = assertSafeKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: safe }));
      return true;
    },
  };
}

// ----------------------------------------------------------------------- factory

/**
 * Pick an adapter from the environment.
 *
 * `S3_BUCKET` is the switch: present means object storage, absent means local disk. That is what
 * lets `npm start` work with no credentials at all.
 */
export async function createStorage({ dataDir }) {
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;

  const configured = [endpoint, accessKeyId, secretAccessKey, bucket].filter(Boolean).length;
  if (configured === 0) {
    console.log("[storage] object storage not configured -> using local disk at data/media");
    return createDiskStorage({ root: dataDir });
  }
  if (configured < 4) {
    throw new Error(
      "Object storage is partially configured. Set all of S3_ENDPOINT, S3_ACCESS_KEY_ID, " +
        "S3_SECRET_ACCESS_KEY, S3_BUCKET, or none of them to use local disk."
    );
  }

  console.log(`[storage] using S3-compatible storage at ${endpoint} (bucket "${bucket}")`);
  return createS3Storage({
    endpoint,
    region: process.env.S3_REGION ?? "auto",
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL ?? "",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
    label: process.env.S3_PROVIDER ?? "s3",
  });
}
