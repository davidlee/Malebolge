import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  contentText,
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type Model,
  normalizeContext,
  type ProviderStreams,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { type Conversation, MemoryStorage } from "@earendil-works/pi-durable";
import { onTestFinished, describe, expect, it, vi } from "vitest";
import { context } from "../src/context.ts";
import { isRecord, type JsonRecord } from "../src/json.ts";
import {
  creationModel,
  GATEWAY_PROVIDER,
  gatewayProvider,
  loadGatewayModels,
  modelCatalog,
  MODEL_STREAM_DEADLINE_MS,
  parseGatewayCatalog,
  parseModel,
  refOf,
  UnknownModel,
  withStreamDeadline,
} from "../src/models.ts";
import { registryOf } from "../src/registry.ts";
import { openSession } from "../src/session.ts";
import { tempDir } from "./fixtures.ts";
import { closing, nodeEnv } from "./harness-fixture.ts";
import { catalogOf, FLASH_REF, IMAGE_REF, SLASHED_REF, slashedModels } from "./model-fixture.ts";

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

/** `handler` served on a loopback port until the test ends; the base URL a catalog names. */
async function localGateway(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        // A stalled response would otherwise hold `close` open.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error("local gateway has no port");
  }
  return `http://127.0.0.1:${address.port.toString()}/v1`;
}

/** A local server answering one chat completion; records each request's headers. */
async function fakeGateway(): Promise<{ baseUrl: string; authorizations: string[] }> {
  const authorizations: string[] = [];
  const baseUrl = await localGateway((request, response) => {
    authorizations.push(
      `${request.method ?? ""} ${request.url ?? ""} ${request.headers.authorization ?? ""}`,
    );
    request.resume();
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "nope" } }));
  });
  return { baseUrl, authorizations };
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

/** One OpenAI-compatible chat-completion chunk, as an SSE event. */
function sseChunk(delta: JsonRecord, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** What a stalling gateway saw. */
interface StallStats {
  requests: number;
  /** The client aborted a request before its response ended. */
  clientClosed: boolean;
}

/**
 * How a stalling gateway answers: never sending headers ("silent"), sending
 * headers and one chunk then nothing ("stall"), or completing ("finish").
 */
type GatewayMode = "silent" | "stall" | "finish";

/** A local gateway answering every request per `mode`. */
async function stallingGateway(mode: GatewayMode): Promise<{ baseUrl: string; stats: StallStats }> {
  const stats: StallStats = { requests: 0, clientClosed: false };
  const baseUrl = await localGateway((request, response) => {
    stats.requests += 1;
    request.resume();
    response.on("close", () => {
      if (!response.writableEnded) {
        stats.clientClosed = true;
      }
    });
    if (mode === "silent") {
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseChunk({ role: "assistant", content: "hel" }, null));
    if (mode === "finish") {
      response.write(sseChunk({ content: "lo" }, "stop"));
      response.write("data: [DONE]\n\n");
      response.end();
    }
  });
  return { baseUrl, stats };
}

/** A minimal assistant message for a request the caller aborted. */
function abortedMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "gateway",
    model: "deepseek-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

describe("model stream deadline (withStreamDeadline; RV-062 F-13 as amended by F-16)", () => {
  /** Catalog and key files pointed at `baseUrl`, loaded with `deadlineMs` as both daemon profiles and the runner do. */
  async function gatewayModels(baseUrl: string, deadlineMs: number): Promise<Models> {
    const tmp = await tempDir();
    onTestFinished(tmp.cleanup);
    const catalogPath = join(tmp.dir, "gateway-models.json");
    const keyPath = join(tmp.dir, "key");
    await writeFile(catalogPath, editedCatalog(setting("baseUrl", baseUrl)));
    await writeFile(keyPath, "sk-deadline\n");
    return loadGatewayModels(catalogPath, keyPath, deadlineMs);
  }

  /** A session on `models` whose root runs the fixture's model; its harness closes when the test ends. */
  async function openGatewaySession(models: Models): Promise<Conversation> {
    const session = await openSession(new MemoryStorage(), {
      models,
      registry: registryOf([]),
      agent: { model: { provider: GATEWAY_PROVIDER, modelId: "deepseek-flash" } },
      profile: "room",
      log: () => undefined,
      env: nodeEnv,
    });
    closing(session.harness);
    return session.root;
  }

  /** The fixture's model, from the catalog alone, refusing absence. */
  function fixtureModel(): Model<Api> {
    const models = createModels();
    models.setProvider(gatewayProvider(parseGatewayCatalog(GATEWAY_CATALOG_TEXT), "k"));
    const model = models.getModel(GATEWAY_PROVIDER, "deepseek-flash");
    if (model === undefined) {
      throw new Error("no model");
    }
    return model;
  }

  /** A ProviderStreams whose streams never emit, recording the signal each call received. */
  function silentStreams(): { streams: ProviderStreams; signals: (AbortSignal | undefined)[] } {
    const signals: (AbortSignal | undefined)[] = [];
    const open = (
      _model: Model<Api>,
      _transcript: TranscriptContext,
      options?: StreamOptions,
    ): AssistantMessageEventStream => {
      signals.push(options?.signal);
      return createAssistantMessageEventStream();
    };
    return { streams: { stream: open, streamSimple: open }, signals };
  }

  /** A ProviderStreams that answers a caller abort with pi-ai's aborted error event. */
  function abortingStreams(): ProviderStreams {
    const open = (
      _model: Model<Api>,
      _transcript: TranscriptContext,
      options?: StreamOptions,
    ): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        stream.push({ type: "error", reason: "aborted", error: abortedMessage() });
      });
      return stream;
    };
    return { stream: open, streamSimple: open };
  }

  it.each<[string, GatewayMode]>([
    ["sends headers and one chunk, then never ends", "stall"],
    ["never sends headers", "silent"],
  ])(
    "a response that %s fails its run with model_error after exactly one model request, its input unanswered",
    { timeout: 10_000 },
    async (_label, mode) => {
      const gateway = await stallingGateway(mode);
      // Long enough for the request to reach the server under a loaded test run.
      const root = await openGatewaySession(await gatewayModels(gateway.baseUrl, 1_000));
      const submission = await root.submit(
        { type: "input", content: "hi", requestId: "stall" },
        context,
      );
      const settled = await submission.wait(context);
      expect(settled).toMatchObject({
        status: "unanswered",
        reason: "model_error",
        detail: "model stream exceeded 1000ms",
      });
      // No retry: the expiry's wording is not one pi-ai deems transient.
      expect(gateway.stats.requests).toBe(1);
      // The inner request's signal was aborted: the client hangs up mid-response.
      await vi.waitFor(() => {
        expect(gateway.stats.clientClosed).toBe(true);
      });
    },
  );

  it("leaves a stream that finishes inside the deadline unaffected", {
    timeout: 10_000,
  }, async () => {
    const gateway = await stallingGateway("finish");
    const root = await openGatewaySession(await gatewayModels(gateway.baseUrl, 5_000));
    const submission = await root.submit(
      { type: "input", content: "hi", requestId: "finish" },
      context,
    );
    const settled = await submission.wait(context);
    expect(settled).toMatchObject({ status: "done" });
    expect(gateway.stats.requests).toBe(1);
    expect(gateway.stats.clientClosed).toBe(false);
    const page = await root.entries({}, 50, undefined, context);
    const assistants = page.items
      .flatMap((entry) => [...(entry.model ?? [])])
      .filter((message) => message.role === "assistant");
    const last = assistants.at(-1);
    if (last === undefined) {
      throw new Error("no assistant message");
    }
    expect(contentText(last.content)).toBe("hello");
  });

  it("ends a request at 2h from its start, aborting it, in wording pi-ai never retries", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { streams, signals } = silentStreams();
    const outer = withStreamDeadline(streams, MODEL_STREAM_DEADLINE_MS).stream(
      fixtureModel(),
      normalizeContext({ messages: [] }),
    );
    let settled = false;
    const result = outer.result().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    expect(signals.map((signal) => signal?.aborted)).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1);
    // Asserted before awaiting, so a wrapper that never expires fails rather than hangs.
    expect(settled).toBe(true);
    const message = await result;
    expect(message).toMatchObject({
      stopReason: "error",
      errorMessage: "model stream exceeded 2h",
    });
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(signals.map((signal) => signal?.aborted)).toEqual([true]);
  });

  it("passes a caller abort through as aborted", async () => {
    const controller = new AbortController();
    const result = withStreamDeadline(abortingStreams(), 5_000).streamSimple(
      fixtureModel(),
      normalizeContext({ messages: [] }),
      { signal: controller.signal },
    );
    controller.abort();
    expect((await result.result()).stopReason).toBe("aborted");
  });
});

describe("model catalog port (modelCatalog, refOf, creationModel)", () => {
  it("VT-1: require parses a slashed ref, and refuses one the catalog lacks or cannot parse", () => {
    const catalog = modelCatalog(slashedModels());
    expect(catalog.require(SLASHED_REF)).toEqual({
      provider: "gateway",
      modelId: "openai-david/gpt-6.1-terra",
    });
    expect(() => catalog.require("gateway/nope")).toThrow(UnknownModel);
    expect(() => catalog.require("gateway/nope")).toThrow("unknown model gateway/nope");
    expect(() => catalog.require("noslash")).toThrow(UnknownModel);
    expect(() => catalog.require("noslash")).toThrow(/noslash/);
  });

  it("VT-2: refs lists every chat ref sorted, no non-chat model; refOf inverts parseModel", () => {
    const models = slashedModels();
    // Not vacuous: the catalog does hold the image model, as a non-chat type.
    expect(models.getModelsOfType("image").map((model) => model.id)).toEqual([
      parseModel(IMAGE_REF).modelId,
    ]);
    const refs = modelCatalog(models).refs();
    expect(refs).toEqual([FLASH_REF, SLASHED_REF]);
    expect(refs).not.toContain(IMAGE_REF);
    expect(refOf(parseModel(SLASHED_REF))).toBe(SLASHED_REF);
  });

  it("VT-3: creationModel takes a known topic, refuses an unknown one, and trusts the fallback unchecked", () => {
    const { require } = catalogOf(SLASHED_REF, FLASH_REF);
    const fallback = parseModel(SLASHED_REF);
    expect(creationModel({ topic: FLASH_REF, fallback }, require)).toEqual(parseModel(FLASH_REF));
    expect(() => creationModel({ topic: "gateway/absent", fallback }, require)).toThrow(
      UnknownModel,
    );
    const refuse = (ref: string): never => {
      throw new Error(`require was called for ${ref}`);
    };
    expect(creationModel({ fallback }, refuse)).toBe(fallback);
  });
});
