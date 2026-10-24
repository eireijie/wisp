import { describe, expect, it } from "vitest";
import { HarnessCatalogSchema, MAX_MODEL_ID_LENGTH } from "../src/protocol.ts";

describe("catalog model ids", () => {
  const catalog = { harness: "custom", version: null, efforts: [], models: [] };

  it("accepts model ids up to the shared limit", () => {
    for (const id of ["fable", "opus", "sonnet", "haiku", "gpt-6-astra", "m".repeat(MAX_MODEL_ID_LENGTH)]) {
      expect(HarnessCatalogSchema.safeParse({ ...catalog, models: [{ id, label: "Model" }], defaultModel: id }).success).toBe(true);
    }
  });

  it("rejects overlong catalog entries and defaults", () => {
    const id = "m".repeat(MAX_MODEL_ID_LENGTH + 1);
    expect(HarnessCatalogSchema.safeParse({ ...catalog, models: [{ id, label: "Model" }] }).success).toBe(false);
    expect(HarnessCatalogSchema.safeParse({ ...catalog, defaultModel: id }).success).toBe(false);
  });
});
