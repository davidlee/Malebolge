import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonModels, readModelsStore, withMissingModels } from "../src/models.ts";
import { tempDir } from "./fixtures.ts";

const model = (id: string) => ({ id, provider: "p", api: "openai-completions" }) as Model<Api>;
const provider = {
  id: "p",
  name: "P",
  auth: {},
  getModels: () => [model("known")],
} as unknown as Provider;

describe("withMissingModels", () => {
  it("adds models the catalog lacks, keeping the catalog's own", () => {
    const extended = withMissingModels(provider, [model("known"), model("new")]);
    expect(extended.getModels().map((m) => m.id)).toEqual(["known", "new"]);
    expect(extended.getAllModels?.().map((m) => m.id)).toEqual(["known", "new"]);
  });

  it("returns the provider itself when nothing is missing", () => {
    expect(withMissingModels(provider, [model("known")])).toBe(provider);
  });
});

describe("readModelsStore", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(() => cleanup?.());

  it("maps provider ids to their stored models", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const path = join(tmp.dir, "models-store.json");
    await writeFile(path, JSON.stringify({ p: { models: [model("new")] }, q: {} }));
    expect(readModelsStore(path)).toEqual({ p: [model("new")], q: [] });
  });

  it("is empty when the store does not exist", () => {
    expect(readModelsStore("/nonexistent/models-store.json")).toEqual({});
  });
});

describe("createDaemonModels", () => {
  it("resolves a stored model the built-in catalog lacks", () => {
    const stored = { deepseek: [{ ...model("deepseek-from-store"), provider: "deepseek" }] };
    const models = createDaemonModels(stored);
    expect(models.getModelOfType("chat", "deepseek", "deepseek-from-store")?.id).toBe(
      "deepseek-from-store",
    );
    expect(models.getModelOfType("chat", "deepseek", "deepseek-v4-pro")).toBeDefined();
  });
});
