import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageApi, ImageModel, Model } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonModels, readModelsStore, withMissingModels } from "../src/models.ts";
import { tempDir } from "./fixtures.ts";

/** A real (faux) catalog for provider "p", offering `ids`. */
const catalog = (...ids: string[]): ReturnType<typeof fauxProvider> =>
  fauxProvider({ provider: "p", models: ids.map((id) => ({ id })) });
const provider = catalog("known").provider;
const model = (id: string): Model<string> => catalog(id).getModel();
const imageModel = (id: string): ImageModel<ImageApi> => ({
  ...model(id),
  api: "openrouter-images",
  type: "image",
  output: ["image"],
});

describe("withMissingModels", () => {
  it("adds models the catalog lacks, keeping the catalog's own", () => {
    const extended = withMissingModels(provider, [model("known"), model("new")]);
    expect(extended.getModels().map((m) => m.id)).toEqual(["known", "new"]);
    expect(extended.getAllModels?.().map((m) => m.id)).toEqual(["known", "new"]);
  });

  it("offers a missing non-chat model among all models only, not as a chat model", () => {
    const extended = withMissingModels(provider, [imageModel("picture")]);
    expect(extended.getModels().map((m) => m.id)).toEqual(["known"]);
    expect(extended.getAllModels?.().map((m) => m.id)).toEqual(["known", "picture"]);
  });

  it("returns the provider itself when nothing is missing", () => {
    expect(withMissingModels(provider, [model("known")])).toBe(provider);
  });
});

describe("readModelsStore", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  it("maps provider ids to their stored models", async () => {
    const tmp = await tempDir();
    cleanup = tmp.cleanup;
    const path = join(tmp.dir, "models-store.json");
    const stored = model("new");
    await writeFile(path, JSON.stringify({ p: { models: [stored] }, q: {} }));
    expect(readModelsStore(path)).toEqual({ p: [stored], q: [] });
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
