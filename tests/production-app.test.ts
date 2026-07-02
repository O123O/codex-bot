import assert from "node:assert/strict";
import test from "node:test";
import { isUncertainAssistantTransportFailure } from "../src/production-app.ts";
import { AppError } from "../src/core/errors.ts";

test("assistant uncertainty is preserved even while the endpoint still reports ready", () => {
  assert.equal(isUncertainAssistantTransportFailure(new AppError("OPERATION_UNCERTAIN", "shutdown"), "ready"), true);
  assert.equal(isUncertainAssistantTransportFailure(new Error("ordinary failure"), "ready"), false);
  assert.equal(isUncertainAssistantTransportFailure(new Error("transport failed"), "unavailable"), true);
});
