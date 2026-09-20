// Start the dev server over HTTPS, for testing from a phone on the LAN.
//
// This wrapper exists because `HTTPS=1 node server/index.js` is not portable: on Windows
// cmd/PowerShell that syntax is a syntax error, and setting env vars portably would mean
// adding cross-env as a dependency for one line. Setting it in-process is simpler and works
// the same on every platform.
//
// Why HTTPS at all: the camera API requires a secure context, and a phone reaching this
// machine over the LAN is not on localhost. See scripts/dev-cert.mjs.

process.env.HTTPS = "1";

await import("../server/index.js");
