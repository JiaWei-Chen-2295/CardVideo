// Card metadata store, behind one interface with two implementations:
//
//   turso    -- production. libSQL over HTTP, which is what makes it usable from Vercel functions:
//               no persistent connection, no local file.
//   json     -- local development. A file under data/ so cards survive a restart, loaded into
//               memory for reads. Keeps `npm start` working with zero configuration.
//
// WHY A DATABASE RATHER THAN STORING RECORDS IN THE OBJECT BUCKET
// Media and metadata could share one provider -- a card record is only ~300 bytes and is written
// once, so object storage would work. It was tried and then reverted for two concrete reasons:
//
//   1. LISTING. "All cards for this owner" is one SQL query here and impossible in object storage
//      without hand-maintaining an index object. Any future feature that needs a list -- a
//      management page, play counts, cleanup of abandoned uploads -- requires a database.
//   2. SEPARATION OF QUOTA. The object store's free tier is consumed by media traffic, which is
//      what this product actually spends. Metadata reads should not compete with that, and Turso's
//      free tier (500M row reads/month) is effectively unbounded at this scale.
//
// Records hold *object keys*, never URLs. Resolving keys to URLs is the API's job, because object
// storage may need to mint a presigned URL per read while local disk does not.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./config.js";

const COLUMNS = {
  id: "id",
  ownerToken: "owner_token",
  title: "title",
  createdAt: "created_at",
  photoKey: "photo_key",
  videoKey: "video_key",
  mindKey: "mind_key",
  videoAspect: "video_aspect",
  trackingPoints: "tracking_points",
};

/** Map a DB row (snake_case) to the app shape (camelCase). */
const fromRow = (row) =>
  row
    ? {
        id: row.id,
        ownerToken: row.owner_token,
        title: row.title ?? "",
        createdAt: Number(row.created_at),
        photoKey: row.photo_key,
        videoKey: row.video_key,
        mindKey: row.mind_key,
        videoAspect: row.video_aspect == null ? null : Number(row.video_aspect),
        trackingPoints: row.tracking_points == null ? null : Number(row.tracking_points),
      }
    : null;

// -------------------------------------------------------------- json/disk store

async function createJsonStore({ dataDir }) {
  const file = join(dataDir, "cards.json");
  /** @type {Map<string, object>} */
  const cards = new Map();

  const load = async () => {
    try {
      const raw = await readFile(file, "utf8");
      for (const card of JSON.parse(raw)) cards.set(card.id, card);
      console.log(`[cards] loaded ${cards.size} card(s) from data/cards.json`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      console.log("[cards] no data/cards.json yet, starting empty");
    }
  };
  await load();

  const persist = async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify([...cards.values()], null, 2));
  };

  return {
    kind: "json",
    async createCard(card) {
      if (cards.has(card.id)) throw new HttpError(409, "card id collision, retry");
      cards.set(card.id, card);
      await persist();
      return card;
    },
    async getCard(id) {
      return cards.get(id) ?? null;
    },
    async deleteCard(id) {
      const existed = cards.delete(id);
      if (existed) await persist();
      return existed;
    },
  };
}

// ------------------------------------------------------------------ turso store

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  owner_token     TEXT NOT NULL,
  title           TEXT,
  created_at      INTEGER NOT NULL,
  photo_key       TEXT NOT NULL,
  video_key       TEXT NOT NULL,
  mind_key        TEXT NOT NULL,
  video_aspect    REAL,
  tracking_points INTEGER
)`;

async function createTursoStore({ url, authToken }) {
  const { connect } = await import("@tursodatabase/serverless");
  const conn = connect({ url, authToken });

  // `connect()` does not reach the network -- the first statement does. So the schema is created
  // eagerly here, which doubles as the connection check: a bad URL or token fails at startup with a
  // clear error instead of on the first card creation.
  await conn.exec(SCHEMA);
  console.log("[cards] connected to Turso and schema is present");

  // NOTE ON THE DRIVER API. In @tursodatabase/serverless 1.x, `Connection.prepare()` is ASYNC and
  // returns a Promise<Statement>, and the convenient single-round-trip helpers `conn.run/get/all`
  // take bind parameters as rest arguments. Code written against 0.x calls `.run()` on the promise
  // and fails with `conn.prepare(...).run is not a function` -- which is exactly what happened when
  // this implementation was restored from an earlier version. The helpers are used here because they
  // skip the extra `describe` round trip that `prepare()` performs.
  return {
    kind: "turso",

    async createCard(card) {
      await conn.run(
        `INSERT INTO cards (${COLUMNS.id}, ${COLUMNS.ownerToken}, ${COLUMNS.title},
           ${COLUMNS.createdAt}, ${COLUMNS.photoKey}, ${COLUMNS.videoKey}, ${COLUMNS.mindKey},
           ${COLUMNS.videoAspect}, ${COLUMNS.trackingPoints})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        card.id,
        card.ownerToken,
        card.title ?? "",
        card.createdAt,
        card.photoKey,
        card.videoKey,
        card.mindKey,
        card.videoAspect ?? null,
        card.trackingPoints ?? null
      );
      return card;
    },

    async getCard(id) {
      const row = await conn.get(`SELECT * FROM cards WHERE ${COLUMNS.id} = ?`, id);
      return fromRow(row);
    },

    async deleteCard(id) {
      const result = await conn.run(`DELETE FROM cards WHERE ${COLUMNS.id} = ?`, id);
      // Drivers differ on how they report affected rows; treat an absent count as success and let
      // the API decide whether a missing card is worth reporting.
      const affected = result?.rowsAffected;
      return affected == null ? true : Number(affected) > 0;
    },
  };
}

// --------------------------------------------------------------------- factory

/**
 * Pick a store from the environment.
 *
 * `TURSO_DATABASE_URL` is the switch: present means production. Absent means a JSON file under
 * `data/`, which keeps `npm start` working with zero setup -- but note that the two paths are NOT
 * the same code, so anything verified only locally is verified only against the JSON store. The
 * Turso path needs a real database to exercise.
 */
export async function createCardStore({ dataDir }) {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.log("[cards] TURSO_DATABASE_URL not set -> using data/cards.json");
    return createJsonStore({ dataDir });
  }
  if (!authToken) {
    throw new Error(
      "TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is missing. Both are required, or neither."
    );
  }

  return createTursoStore({ url, authToken });
}
