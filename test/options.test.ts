import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseModelRoutingOptions } from "../src/options.js";

test("parseModelRoutingOptions validates model windows and targets", () => {
  assert.deepEqual(
    parseModelRoutingOptions({
      timezone: "UTC",
      models: {
        shared_model: {
          windows: [{ start: "18:00", end: "21:00" }],
          within: { provider: "devmate", model: "shared_model" },
          beyond: { provider: "gateway", model: "shared_model" },
        },
      },
    }),
    {
      timezone: "UTC",
      models: {
        shared_model: {
          windows: [{ start: "18:00", end: "21:00" }],
          within: { provider: "devmate", model: "shared_model" },
          beyond: { provider: "gateway", model: "shared_model" },
        },
      },
    },
  );
  assert.throws(
    () =>
      parseModelRoutingOptions({
        models: {
          shared_model: {
            windows: [{ start: "18:00", end: "18:00" }],
            within: { provider: "devmate", model: "shared_model" },
            beyond: { provider: "gateway", model: "shared_model" },
          },
        },
      }),
    /start and end must differ/,
  );
});
