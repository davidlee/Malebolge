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
      model: { provider: "gateway", modelId: "deepseek-flash" },
      gatewayCatalog: "/h/.config/malebolge/gateway-models.json",
      gatewayKeyFile: "/h/.config/llm-gateway/keys/malebolge",
      skillDirs: [],
      cwd: "/cwd",
    });
  });

  it.each([
    ["", []],
    ["a::b:", ["a", "b"]],
    ["/s/one:/s/two", ["/s/one", "/s/two"]],
  ])(
    "splits MALEBOLGE_SKILLS %j on ':' into skillDirs %j, dropping empty segments",
    (value, dirs) => {
      expect(resolveConfig({ ...base, MALEBOLGE_SKILLS: value }, "/cwd").skillDirs).toEqual(dirs);
    },
  );

  it("honours XDG_STATE_HOME and explicit overrides", () => {
    const config = resolveConfig(
      {
        ...base,
        XDG_STATE_HOME: "/state",
        SATAN_CORPUS_ROOT: "/corpus",
        SATAN_MCP_SOCKET: "/mcp.sock",
        MALEBOLGE_SOCKET: "/d.sock",
        MALEBOLGE_MODEL: "openai/gpt-6-sol",
        MALEBOLGE_GATEWAY_CATALOG: "/etc/catalog.json",
        MALEBOLGE_GATEWAY_KEY_FILE: "/run/key",
      },
      "/cwd",
    );
    expect(config).toMatchObject({
      corpusRoot: "/corpus",
      storagePath: "/state/satan/durable/session.sqlite",
      mcpSocket: "/mcp.sock",
      daemonSocket: "/d.sock",
      model: { provider: "openai", modelId: "gpt-6-sol" },
      gatewayCatalog: "/etc/catalog.json",
      gatewayKeyFile: "/run/key",
    });
  });

  it("rejects a model without a provider prefix", () => {
    expect(() => resolveConfig({ ...base, MALEBOLGE_MODEL: "bare" }, "/cwd")).toThrow(
      /provider\/model/,
    );
  });
});
