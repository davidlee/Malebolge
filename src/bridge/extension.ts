// The bridge extension (SL-009 design sec-6, sec-8): PHASE-06 fills it with the
// `bridge_post` tool and `BRIDGE_SECTION`. For now it is the name the catalogue
// installs and nothing else, so a room conversation can be created on the bridge
// toolset before its tools exist.

import { defineExtension, type Extension } from "@earendil-works/pi-durable";

export const bridgeExtension: Extension = defineExtension({ name: "bridge" });
