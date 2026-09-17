import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isRetryableStreamFailure } from "../src/auto-continue.js";

test("recognizes incomplete streams by their stable classification", () => {
  assert.equal(
    isRetryableStreamFailure({
      type: "AI.Error.InvalidProviderOutput",
      message: "OpenAI Chat stream ended without finish_reason",
      classification: "incomplete-stream",
    }),
    true,
  );
});

test("recognizes incomplete streams from the provider error message", () => {
  assert.equal(
    isRetryableStreamFailure({
      type: "AI.Error.InvalidProviderOutput",
      message: "OpenAI Chat stream ended without finish_reason",
    }),
    true,
  );
});

test("does not retry unrelated invalid provider output", () => {
  assert.equal(
    isRetryableStreamFailure({
      type: "AI.Error.InvalidProviderOutput",
      message: "The provider returned an unsupported response",
      classification: "invalid-response",
    }),
    false,
  );
});

test("does not retry authentication failures", () => {
  assert.equal(
    isRetryableStreamFailure({
      type: "AI.Error.Authentication",
      message: "The provider rejected the credentials",
      status: 401,
    }),
    false,
  );
});
