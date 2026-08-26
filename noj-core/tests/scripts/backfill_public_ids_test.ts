import { backfillAll } from "../../scripts/backfill-public-ids.ts";
import { closeDbForShutdown } from "../../src/db/connection.ts";

const hasDb = !!Deno.env.get("DATABASE_URL");

Deno.test({
  name: "backfill-public-ids: 幂等回填不抛错",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    try {
      await backfillAll();
    } finally {
      await closeDbForShutdown();
    }
  },
});
