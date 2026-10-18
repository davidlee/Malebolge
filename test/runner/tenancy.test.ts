// The job in the room: what the harness's env factory and the guard see of
// it, by conversation id, and only while it is there.

import { type ConversationId, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { context } from "../../src/context.ts";
import { conversationText } from "../../src/runner/durable-ids.ts";
import { roomTenancy, type Tenant } from "../../src/runner/tenancy.ts";
import { openFauxHarness } from "../harness-fixture.ts";
import { closeHarness } from "./runner-fixture.ts";

/** Two real conversation ids. */
async function twoConversations(): Promise<[ConversationId, ConversationId]> {
  const { harness } = await openFauxHarness(new MemoryStorage(), { resume: false });
  try {
    const create = async (): Promise<ConversationId> =>
      (await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id;
    return [await create(), await create()];
  } finally {
    await closeHarness(harness);
  }
}

const tenantOf = (jobId: string, conversation: ConversationId): Tenant => ({
  id: jobId,
  conversationId: conversationText(conversation),
  allowedPaths: ["src/"],
  root: "/work/repos/satan",
  env: new NodeExecutionEnv({ cwd: "/tmp" }),
  meter: {
    conversation,
    ceilings: { model_requests: 1, cost_usd: 1, tokens: 1, active_wall_clock_s: 1 },
    softThreshold: 0.8,
    refused: () => undefined,
    warnDue: () => undefined,
  },
});

describe("roomTenancy", () => {
  it("gives the tenant's env and guarded facts to its own conversation only", async () => {
    const [mine, other] = await twoConversations();
    const tenancy = roomTenancy();
    const tenant = tenantOf("pj-1", mine);

    tenancy.enter(tenant);

    expect(tenancy.env({ conversationId: mine })).toBe(tenant.env);
    expect(tenancy.env({ conversationId: other })).toBeUndefined();
    expect(tenancy.guarded(conversationText(mine))).toEqual({
      id: "pj-1",
      allowedPaths: ["src/"],
      root: "/work/repos/satan",
    });
    expect(tenancy.guarded(conversationText(other))).toBeUndefined();
  });

  it("is empty once the tenant leaves; another job's leave changes nothing", async () => {
    const [mine] = await twoConversations();
    const tenancy = roomTenancy();
    tenancy.enter(tenantOf("pj-1", mine));

    tenancy.leave("pj-2");
    expect(tenancy.env({ conversationId: mine })).toBeDefined();
    tenancy.leave("pj-1");

    expect(tenancy.env({ conversationId: mine })).toBeUndefined();
    expect(tenancy.guarded(conversationText(mine))).toBeUndefined();
  });

  it("seats one tenant for the model gate, whatever the conversation", async () => {
    const [mine] = await twoConversations();
    const tenancy = roomTenancy();
    expect(tenancy.seated()).toBeUndefined();
    const tenant = tenantOf("pj-1", mine);

    tenancy.enter(tenant);
    expect(tenancy.seated()).toBe(tenant);
    tenancy.leave("pj-1");

    expect(tenancy.seated()).toBeUndefined();
  });
});
