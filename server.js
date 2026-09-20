// Vercel entry point.
//
// WHY THIS FILE EXISTS
// Vercel detects an Express application by looking for a file that imports `express` at one of a
// fixed set of locations -- `app|index|server.{js,mjs,cjs,...}` in the repository ROOT or under
// `src/`. This project's server lives at `server/index.js`, which is in neither: `server/` is not a
// directory Vercel scans.
//
// The result of that mismatch is a deployment that builds successfully and then returns 404 for
// every route, with nothing in the build log explaining why.
//
// This file is a pure re-export, not a second implementation: the app is constructed once, in
// `server/index.js`, exactly as it is when running locally. There is no duplicated wiring to drift
// out of sync.
//
// `server/index.js` deliberately does not call `listen()` when `VERCEL` is set -- the platform owns
// the port -- so importing it here has no side effects beyond building the app.

export { default } from "./server/index.js";
