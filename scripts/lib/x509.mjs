// Minimal ASN.1 DER encoder + X.509 self-signed certificate issuance, in pure Node.
//
// WHY THIS EXISTS
// Testing this app needs a phone, and a phone is not on localhost. The camera API requires a
// secure context, so the dev server has to speak HTTPS -- but nothing available here can issue
// a certificate:
//   - Node's X.509 support is VERIFY-ONLY (crypto.X509Certificate parses, it never signs);
//   - openssl is not installed on this machine, and neither is Git (which bundles it);
//   - mkcert would need its CA trusted on the phone, and a tunnel service puts the media on
//     the public internet and needs an account.
//
// Issuing the certificate ourselves removes all of those dependencies. It is ~200 lines of DER
// encoding for the one shape we need -- a self-signed leaf with an RSA key and a SAN list --
// and it produces standard PEM that Node's https server accepts directly.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  X509Certificate,
} from "node:crypto";

// --------------------------------------------------------------- DER primitives

/** Encode a DER length field. */
function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Tag-length-value. */
function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const SEQ = (parts) => tlv(0x30, Buffer.concat(parts));
const SET = (parts) => tlv(0x31, Buffer.concat(parts));
const NULL = () => tlv(0x05, Buffer.alloc(0));
const BOOL = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const OCTET_STRING = (buf) => tlv(0x04, buf);

/** OBJECT IDENTIFIER from dotted string. */
function OID(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    let value = part >>> 7;
    while (value > 0) {
      stack.unshift((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTF8String. */
const UTF8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));

/** PrintableString for things like country codes. */
const PRINTABLE = (text) => tlv(0x13, Buffer.from(text, "ascii"));

/** INTEGER from a non-negative number or big-endian Buffer. */
function INTEGER(value) {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = value;
  } else {
    const out = [];
    let v = BigInt(value);
    while (v > 0n) {
      out.unshift(Number(v & 0xffn));
      v >>= 8n;
    }
    bytes = Buffer.from(out.length ? out : [0]);
  }
  // DER integers are signed: prepend 0x00 when the high bit is set.
  if (bytes.length && bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}

/** UTCTime, valid for years 1950-2049. */
function UTCTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/** BIT STRING from raw bytes (unused bits = 0). */
const BIT_STRING = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));

/** Context-specific primitive/constructed tags, used by GeneralName and extensions. */
const ctx = (constructed, index, content) =>
  tlv((constructed ? 0xa0 : 0x80) | index, content);

// --------------------------------------------------------------------- X.509

/**
 * Build a self-signed X.509 certificate.
 *
 * @param {object} options
 * @param {import("node:crypto").KeyObject} options.privateKey
 * @param {string[]} options.names  DNS names and IP addresses to put in subjectAltName
 * @param {number} [options.days]
 * @param {string} [options.commonName]
 * @returns {{certificatePem: string, privateKeyPem: string}}
 */
export function createSelfSignedCertificate({ privateKey, names, days = 825, commonName }) {
  const publicKey = createPublicKey(privateKey);

  // The subjectPublicKeyInfo must be re-encoded as DER: Node exposes it as PEM.
  const spkiDer = publicKey.export({ type: "spki", format: "der" });

  const san = names.map((name) =>
    // iPAddress is context tag 7 (primitive), dNSName is tag 2 (primitive).
    /^[0-9.]+$/.test(name)
      ? ctx(false, 7, Buffer.from(name.split(".").map(Number)))
      : ctx(false, 2, Buffer.from(name, "ascii"))
  );

  const serial = INTEGER(Buffer.from([0x01, ...Array.from({ length: 15 }, () => Math.floor(Math.random() * 256))]));

  const name = SEQ([
    SET([SEQ([OID("2.5.4.3"), UTF8(commonName ?? names[0] ?? "CardVideo dev")])]),
    SET([SEQ([OID("2.5.4.10"), UTF8("CardVideo development")])]),
  ]);

  const now = new Date();
  const validity = SEQ([
    UTCTime(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    UTCTime(new Date(now.getTime() + days * 24 * 60 * 60 * 1000)),
  ]);

  const extensions = ctx(
    true,
    3,
    SEQ([
      // basicConstraints: critical CA:TRUE. Marked as a CA so a phone that is told to trust it
      // treats it as a trust anchor for its own leaf, which is how self-signed dev certs work.
      SEQ([OID("2.5.29.19"), BOOL(true), OCTET_STRING(SEQ([BOOL(true)]))]),
      // keyUsage: digitalSignature | keyEncipherment | keyCertSign
      SEQ([
        OID("2.5.29.15"),
        BOOL(true),
        OCTET_STRING(BIT_STRING(Buffer.from([0x86]))),
      ]),
      // extendedKeyUsage: serverAuth
      SEQ([OID("2.5.29.37"), OCTET_STRING(SEQ([OID("1.3.6.1.5.5.7.3.1")]))]),
      // subjectAltName: the only part that actually matters to a browser.
      SEQ([OID("2.5.29.17"), OCTET_STRING(SEQ(san))]),
    ])
  );

  const tbsCertificate = SEQ([
    ctx(true, 0, INTEGER(2)), // version v3
    serial,
    SEQ([OID("1.2.840.113549.1.1.11"), NULL()]), // sha256WithRSAEncryption
    name, // issuer
    validity,
    name, // subject (self-signed)
    spkiDer,
    extensions,
  ]);

  const signature = cryptoSign("sha256", tbsCertificate, privateKey);

  const certificate = SEQ([
    tbsCertificate,
    SEQ([OID("1.2.840.113549.1.1.11"), NULL()]),
    BIT_STRING(signature),
  ]);

  return {
    certificatePem: toPem("CERTIFICATE", certificate),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** Wrap DER in PEM armour with 64-character lines. */
function toPem(label, der) {
  const base64 = der.toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Generate a key pair and a matching self-signed certificate in one step. */
export function generateDevCertificate(options) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const result = createSelfSignedCertificate({ privateKey, ...options });
  return result;
}

/**
 * Verify our own output with Node's certificate parser.
 *
 * Worth doing because a malformed certificate fails at TLS handshake time with an unhelpful
 * error, and hand-rolled DER is exactly the kind of code that is subtly wrong.
 */
export function inspectCertificate(certificatePem) {
  const certificate = new X509Certificate(certificatePem);
  return {
    subject: certificate.subject,
    subjectAltName: certificate.subjectAltName,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    fingerprint: certificate.fingerprint256,
    // A self-signed certificate verifies against its OWN embedded public key, so this checks
    // that the signature and the subjectPublicKeyInfo actually agree.
    selfSigned: certificate.verify(certificate.publicKey),
  };
}
