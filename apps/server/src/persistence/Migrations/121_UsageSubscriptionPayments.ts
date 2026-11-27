import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE usage_subscription_payments (
    provider_month TEXT PRIMARY KEY, cents INTEGER NOT NULL CHECK(cents>=0), updated_at TEXT NOT NULL
 )`;
});
