// The process-wide Chord context. Work here is never cancelled from above;
// shutdown goes through `Harness.close`.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export const context = BACKGROUND_CONTEXT;
