import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.ts";

const base = { HOME: "/h", XDG_RUNTIME_DIR: "/run/u" };

describe("resolveConfig", () => {
  it("defaults to SATAN's roots and sockets", () => {
    expect(resolveConfig(base, "/cwd")).toEqual({
      corpusRoot: "/h/satan-corpus",
      storagePath: "/h/.local/state/satan/durable/session.sqlite",
      mcpSocket: "/run/u/satan/mcp/mcp.sock",
      daemonSocket: "/run/u/satan/durable.sock",
      model: { provider: "deepseek", modelId: "deepseek-flash" },
      modelsStorePath: "/h/.pi/agent/models-store.json",
      cwd: "/cwd",
    });
  });

  it("honours XDG_STATE_HOME and explicit overrides", () => {
    const config = resolveConfig(
      {
        ...base,
        XDG_STATE_HOME: "/state",
        SATAN_CORPUS_ROOT: "/corpus",
        SATAN_MCP_SOCKET: "/mcp.sock",
        PANDAEMONIUM_SOCKET: "/d.sock",
        PANDAEMONIUM_MODEL: "openai/gpt-6-sol",
      },
      "/cwd",
    );
    expect(config).toMatchObject({
      corpusRoot: "/corpus",
      storagePath: "/state/satan/durable/session.sqlite",
      mcpSocket: "/mcp.sock",
      daemonSocket: "/d.sock",
      model: { provider: "openai", modelId: "gpt-6-sol" },
    });
  });

  it("rejects a model without a provider prefix", () => {
    expect(() => resolveConfig({ ...base, PANDAEMONIUM_MODEL: "bare" }, "/cwd")).toThrow(
      /provider\/model/,
    );
  });
});
