// Provide a usable TLS certificate for phone testing on the LAN, with no external tools.
//
// WHY HTTPS IS MANDATORY HERE
// The camera API is gated behind a secure context: on plain http over a LAN address,
// `navigator.mediaDevices` is undefined and the AR page cannot start at all. localhost is the
// only origin exempt from that rule, which is precisely the origin a phone is not.
//
// WHY THE CERTIFICATE IS ISSUED IN-PROCESS
// Nothing available on a stock machine can issue one: Node's X.509 support only verifies,
// openssl is frequently absent (it is not installed here), mkcert additionally needs its CA
// trusted on the phone, and a tunnel needs an account and puts the media on the public
// internet. Since Node CAN generate RSA keys and sign arbitrary bytes, the certificate is
// assembled from DER primitives in scripts/lib/x509.mjs instead.
//
// The certificate is self-signed, so a phone shows a warning once. That is the whole cost.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { generateDevCertificate } from "./lib/x509.mjs";
import { certAddresses } from "./lib/lan.mjs";

const CERT_FILE = "dev-cert.pem";
const KEY_FILE = "dev-key.pem";

/**
 * Names the certificate must be valid for.
 *
 * `<ip>.nip.io` aliases are included so the certificate keeps working when a DHCP lease moves
 * to a different subnet: nip.io resolves any embedded IP back to that address, and
 * regenerating a hand-trusted certificate on every network change would cost more than the
 * one-time warning it already costs.
 */
function certNames() {
  const names = new Set(["localhost"]);
  for (const address of certAddresses()) {
    names.add(address);
    if (address !== "127.0.0.1") names.add(`${address}.nip.io`);
  }
  return [...names];
}

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Return `{key, cert}` buffers for the HTTPS server, generating the pair when needed.
 *
 * @returns {Promise<{key: Buffer, cert: Buffer} | null>} null means "could not provide TLS",
 *          in which case the caller should fall back to plain http and say so clearly.
 */
export async function ensureDevCertificate({ dataDir }) {
  const certPath = join(dataDir, CERT_FILE);
  const keyPath = join(dataDir, KEY_FILE);

  if ((await exists(certPath)) && (await exists(keyPath))) {
    try {
      // Reuse only if the existing certificate still covers THIS machine's addresses; a
      // certificate issued on a previous network is useless and the failure (browser warning
      // about a name mismatch) is confusing rather than obvious.
      const cert = new X509Certificate(await readFile(certPath, "utf8"));
      const san = cert.subjectAltName ?? "";
      const covered = certNames().every((name) => san.includes(name));
      const valid = new Date(cert.validTo) > new Date();

      if (covered && valid) {
        console.log(`[tls] reusing data/${CERT_FILE}`);
        return { key: await readFile(keyPath), cert: await readFile(certPath, "utf8") };
      }
      console.log(
        `[tls] regenerating the certificate (${!valid ? "expired" : "network addresses changed"})`
      );
    } catch (err) {
      console.warn(`[tls] existing certificate unreadable (${err.message}); regenerating`);
    }
  }

  try {
    const names = certNames();
    const { certificatePem, privateKeyPem } = generateDevCertificate({
      names,
      commonName: names.includes("localhost") ? "localhost" : names[0],
    });

    // Verify before writing: a malformed certificate fails later as an opaque TLS handshake
    // error, and hand-rolled DER is exactly the kind of code that is subtly wrong.
    const parsed = new X509Certificate(certificatePem);
    const san = parsed.subjectAltName ?? "";
    const missing = names.filter((name) => !san.includes(name));
    if (missing.length) throw new Error(`generated certificate is missing SANs: ${missing.join(", ")}`);

    await mkdir(dataDir, { recursive: true });
    await writeFile(certPath, certificatePem);
    await writeFile(keyPath, privateKeyPem, { mode: 0o600 });

    console.log(
      `[tls] issued a self-signed certificate for ${names.length} name(s), ` +
        `valid until ${parsed.validTo}`
    );
    return { key: privateKeyPem, cert: certificatePem };
  } catch (err) {
    console.error(
      `\n[tls] Could not create a certificate: ${err.message}\n` +
        `      Falling back to plain http. The site will work, but a phone will NOT be\n` +
        `      granted camera access, so the AR page cannot run.\n` +
        `      Alternative: expose the dev server through a tunnel that terminates HTTPS:\n` +
        `        npx localtunnel --port 3000\n` +
        `        cloudflared tunnel --url http://localhost:3000\n`
    );
    return null;
  }
}

// `node scripts/dev-cert.mjs` pre-generates the certificate.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/dev-cert.mjs")) {
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
  const result = await ensureDevCertificate({ dataDir });
  if (result) {
    console.log("\nCertificate ready. Serve it with:  npm run dev:https");
  } else {
    process.exitCode = 1;
  }
}
