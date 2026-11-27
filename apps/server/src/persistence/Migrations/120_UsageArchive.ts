import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_archive (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL,
    read_at TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE (origin, day, source)
  )`;
  yield* sql`CREATE INDEX usage_archive_day_idx ON usage_archive(day)`;
  yield* sql`CREATE TABLE usage_archive_sync (
    origin TEXT PRIMARY KEY, label TEXT NOT NULL, read_at TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, full_at TEXT, retry_at TEXT
  )`;
});
