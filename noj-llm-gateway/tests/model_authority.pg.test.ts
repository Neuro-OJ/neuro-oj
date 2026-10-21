import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { createDb } from "../src/db.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createProvider, updateProvider } from "../src/providers.ts";
import {
  deleteDomainModelAlias,
  listDomainModelAliases,
  ModelAuthorityError,
  readDomainModelSettings,
  resolveDomainModelSelection,
  updateDomainModelSettings,
  upsertDomainModelAlias,
} from "../src/model-authority.ts";
import { testConfig } from "./helpers.ts";
import { gatewayTestDatabaseUrl as databaseUrl } from "./integration-env.ts";

Deno.test({
  name: "模型权威：Gateway 独立持久化、revision 与 Provider 组合解析",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const admin = createDb(databaseUrl);
    const schema = `gw_model_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    const db = createDb(url.toString());
    try {
      await runMigrations(url.toString());
      const providerA = await createProvider(
        db,
        {
          name: "a",
          base_url: "https://api.openai.com",
          api_key: "sk-provider-a",
        },
        testConfig.storeKey,
        "domain-a",
      );
      const providerB = await createProvider(
        db,
        {
          name: "b",
          base_url: "https://api.openai.com",
          api_key: "sk-provider-b",
        },
        testConfig.storeKey,
        "domain-a",
      );

      const empty = await readDomainModelSettings(db, "domain-a");
      assertEquals(empty.revision, 0);
      const settings = await updateDomainModelSettings(
        db,
        "domain-a",
        { provider_id: providerA.id, model: "default-model" },
        0,
        "actor-a",
      );
      assertEquals(settings.revision, 1);
      await assertRejects(
        () =>
          updateDomainModelSettings(
            db,
            "domain-a",
            { provider_id: providerB.id, model: "stale" },
            0,
            "actor-b",
          ),
        ModelAuthorityError,
        "revision_conflict",
      );

      const alias = await upsertDomainModelAlias(
        db,
        "domain-a",
        "fast",
        { provider_id: providerA.id, model: "fast-model", description: "快" },
        0,
        "actor-a",
      );
      assertEquals(alias.revision, 1);
      assertEquals(
        (await listDomainModelAliases(db, "domain-a")).map((row) => row.alias),
        [
          "fast",
        ],
      );
      assertEquals(
        await resolveDomainModelSelection(db, "domain-a", ["default", "fast"]),
        {
          provider_id: providerA.id,
          models: [
            { alias: "default", model: "default-model" },
            { alias: "fast", model: "fast-model" },
          ],
        },
      );

      await assertRejects(
        () =>
          upsertDomainModelAlias(
            db,
            "domain-a",
            "fast",
            { provider_id: providerA.id, model: "new-model" },
            0,
            "actor-a",
          ),
        ModelAuthorityError,
        "revision_conflict",
      );
      await assertRejects(
        () =>
          upsertDomainModelAlias(
            db,
            "domain-a",
            "other",
            { provider_id: providerB.id, model: "other-model" },
            0,
            "actor-a",
          ).then(() =>
            resolveDomainModelSelection(db, "domain-a", ["fast", "other"])
          ),
        ModelAuthorityError,
        "mixed_provider",
      );

      await updateProvider(
        db,
        providerA.id,
        { enabled: false },
        testConfig.storeKey,
        "domain-a",
        providerA.revision,
      );
      await assertRejects(
        () => resolveDomainModelSelection(db, "domain-a", ["default"]),
        ModelAuthorityError,
        "provider_not_found",
      );
      assertEquals(
        await deleteDomainModelAlias(db, "domain-a", "fast", 1),
        true,
      );
      assertEquals(
        await deleteDomainModelAlias(db, "domain-a", "fast", 1),
        false,
      );
    } finally {
      await db.end();
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
});
