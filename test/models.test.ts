import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { onTestFinished, describe, expect, it } from "vitest";
import { isRecord, type JsonRecord } from "../src/json.ts";
import {
  GATEWAY_PROVIDER,
  gatewayProvider,
  loadGatewayModels,
  parseGatewayCatalog,
} from "../src/models.ts";
import { tempDir } from "./fixtures.ts";

/** The catalog as `piGatewayConfig` renders it (see test/gateway-catalog.json). */
const GATEWAY_CATALOG_TEXT = readFileSync(
  new URL("./gateway-catalog.json", import.meta.url),
  "utf8",
);

/** The fixture's single provider entry, as parsed JSON. */
function fixtureEntry(): JsonRecord {
  const doc: unknown = JSON.parse(GATEWAY_CATALOG_TEXT);
  const providers = isRecord(doc) ? doc["providers"] : undefined;
  const entry = isRecord(providers) ? providers["llm-gateway"] : undefined;
  if (!isRecord(entry)) {
    throw new Error("fixture has no llm-gateway provider");
  }
  return entry;
}

/** An edit of a JSON table: the table it becomes. */
type Edit = (record: JsonRecord) => JsonRecord;

/** The fixture with its provider entry edited by `edit`, as catalog text. */
const editedCatalog = (edit: Edit): string =>
  JSON.stringify({ providers: { "llm-gateway": edit(fixtureEntry()) } });

/** The fixture with its model edited by `edit`, as catalog text. */
const withModel = (edit: Edit): string =>
  editedCatalog((entry) => {
    const models: unknown = entry["models"];
    const first: unknown = Array.isArray(models) ? models[0] : undefined;
    if (!isRecord(first)) {
      throw new Error("fixture has no model");
    }
    return { ...entry, models: [edit(first)] };
  });

/** An edit dropping `key`. */
const dropping =
  (key: string): Edit =>
  (record) =>
    Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

/** An edit setting `key` to `value`. */
const setting =
  (key: string, value: unknown): Edit =>
  (record) => ({ ...record, [key]: value });

describe("gateway provider (parseGatewayCatalog)", () => {
  const catalog = parseGatewayCatalog(GATEWAY_CATALOG_TEXT);
  const models = createModels();
  models.setProvider(gatewayProvider(catalog, "k"));

  it("offers the catalog's models under provider gateway, with the catalog's baseUrl and cost", () => {
    const model = models.getModel(GATEWAY_PROVIDER, "deepseek-flash");
    expect(model).toMatchObject({
      provider: "gateway",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:4000/v1",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      thinkingLevelMap: { minimal: null, low: "low", max: "max" },
      compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
    });
  });

  it("holds only the gateway's own models: no built-in provider", () => {
    expect(models.getProviders().map((p) => p.id)).toEqual(["gateway"]);
  });

  it.each([
    ["not JSON", "{", /JSON/],
    ["not an object", "[]", /exactly one provider/],
    ["zero providers", JSON.stringify({ providers: {} }), /exactly one provider/],
    [
      "two providers",
      JSON.stringify({ providers: { a: fixtureEntry(), b: fixtureEntry() } }),
      /exactly one provider/,
    ],
    ["a non-openai-completions api", editedCatalog(setting("api", "anthropic-messages")), /api/],
    ["a missing baseUrl", editedCatalog(dropping("baseUrl")), /baseUrl/],
    ["a model missing id", withModel(dropping("id")), /id/],
    ["a model missing contextWindow", withModel(dropping("contextWindow")), /contextWindow/],
    ["a model missing maxTokens", withModel(dropping("maxTokens")), /maxTokens/],
    ["a model missing cost", withModel(dropping("cost")), /cost/],
    [
      "a cost missing output",
      withModel(setting("cost", { input: 1, cacheRead: 0, cacheWrite: 0 })),
      /cost.*output/,
    ],
  ])("refuses %s", (_label, text, message) => {
    expect(() => parseGatewayCatalog(text)).toThrow(message);
  });
});

const isAddressInfo = (value: string | AddressInfo | null): value is AddressInfo =>
  typeof value === "object" && value !== null;

/** A local server answering one chat completion; records each request's headers. */
async function fakeGateway(): Promise<{ baseUrl: string; authorizations: string[] }> {
  const authorizations: string[] = [];
  const server = createServer((request, response) => {
    authorizations.push(
      `${request.method ?? ""} ${request.url ?? ""} ${request.headers.authorization ?? ""}`,
    );
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "nope" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error("fake gateway has no port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port.toString()}/v1`, authorizations };
}

describe("gateway provider requests", () => {
  async function request(key: string): Promise<string[]> {
    const { baseUrl, authorizations } = await fakeGateway();
    const catalog = parseGatewayCatalog(editedCatalog(setting("baseUrl", baseUrl)));
    const models = createModels();
    models.setProvider(gatewayProvider(catalog, key));
    const model = models.getModel(GATEWAY_PROVIDER, "deepseek-flash");
    if (model === undefined) {
      throw new Error("no model");
    }
    await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    return authorizations;
  }

  it("sends the key as an Authorization bearer to the catalog's baseUrl", async () => {
    expect(await request("sk-distinct-key")).toEqual([
      "POST /v1/chat/completions Bearer sk-distinct-key",
    ]);
  });

  it("keeps the key out of process.env, and gives its ApiKeyAuth no login", async () => {
    const key = "sk-never-in-env-4711";
    await request(key);
    expect(Object.values(process.env).some((value) => value?.includes(key) === true)).toBe(false);
    const { apiKey } = gatewayProvider(parseGatewayCatalog(GATEWAY_CATALOG_TEXT), key).auth;
    expect(apiKey).toBeDefined();
    expect(apiKey).not.toHaveProperty("login");
  });
});

describe("loadGatewayModels (the daemon's and the runner's shared loader)", () => {
  /** A catalog file (the fixture, pointed at `baseUrl`) and a key file holding `key`, in a temp dir. */
  async function files(
    key: string,
    baseUrl = "http://127.0.0.1:4000/v1",
  ): Promise<{ catalogPath: string; keyPath: string }> {
    const tmp = await tempDir();
    onTestFinished(tmp.cleanup);
    const catalogPath = join(tmp.dir, "gateway-models.json");
    const keyPath = join(tmp.dir, "key");
    await writeFile(catalogPath, editedCatalog(setting("baseUrl", baseUrl)));
    await writeFile(keyPath, key);
    return { catalogPath, keyPath };
  }

  it("holds the gateway provider alone, models carrying the catalog's baseUrl", async () => {
    const { catalogPath, keyPath } = await files("k\n");
    const models = await loadGatewayModels(catalogPath, keyPath);
    expect(models.getProviders().map((p) => p.id)).toEqual(["gateway"]);
    expect(models.getModel(GATEWAY_PROVIDER, "deepseek-flash")?.baseUrl).toBe(
      "http://127.0.0.1:4000/v1",
    );
  });

  it("authenticates with the key file's text, less one trailing newline, and leaves process.env alone", async () => {
    const key = "sk-from-file-4711";
    const gateway = await fakeGateway();
    const { catalogPath, keyPath } = await files(`${key}\n`, gateway.baseUrl);
    const models = await loadGatewayModels(catalogPath, keyPath);
    const model = models.getModel(GATEWAY_PROVIDER, "deepseek-flash");
    if (model === undefined) {
      throw new Error("no model");
    }
    await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
    expect(gateway.authorizations).toEqual([`POST /v1/chat/completions Bearer ${key}`]);
    expect(Object.values(process.env).some((value) => value?.includes(key) === true)).toBe(false);
  });

  type Files = Awaited<ReturnType<typeof files>>;
  type Breakage = (f: Files) => Promise<void>;
  const key = "sk-secret-never-in-a-message";
  const cases: [string, Breakage, string][] = [
    ["a missing key file", (f): Promise<void> => rm(f.keyPath), "gateway credential"],
    ["an empty key file", (f): Promise<void> => writeFile(f.keyPath, "\n"), "file is empty"],
    ["a missing catalog", (f): Promise<void> => rm(f.catalogPath), "gateway catalog"],
    [
      "a malformed catalog",
      (f): Promise<void> => writeFile(f.catalogPath, '{"providers":{}}'),
      "gateway catalog",
    ],
  ];
  it.each(cases)(
    "refuses %s, naming the path and never the key",
    async (_label, breakage, where) => {
      const f = await files(key);
      await breakage(f);
      const refusal = await loadGatewayModels(f.catalogPath, f.keyPath).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (!(refusal instanceof Error)) {
        throw new Error("expected a refusal");
      }
      expect(refusal.message).toContain(where);
      expect(refusal.message).toMatch(/gateway-models\.json|\/key/);
      expect(refusal.message).not.toContain(key);
    },
  );
});
