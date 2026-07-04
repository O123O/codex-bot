import assert from "node:assert/strict";
import test from "node:test";
import { runRedactedWeixinAcceptance } from "./weixin-live-harness.ts";

const enabled = process.env.QIYAN_WEIXIN_LIVE === "1";

test("live personal WeChat owner round trip", { skip: !enabled }, async () => {
  const result = await runRedactedWeixinAcceptance();
  assert.equal(result.authorizationIdentitiesDistinct, true);
  assert.deepEqual(result.inboundKinds, ["text", "image", "file", "voice_transcription", "unsupported_video"]);
  assert.deepEqual(result.outboundKinds, ["text_3999", "text_4000", "text_4001", "image", "file"]);
  assert.equal(result.unauthorizedInputCount, 0);
  assert.equal(result.crossAdapterContinuation, true);
  assert.equal(result.restartCursorRecovered, true);
  assert.equal(result.duplicateAssistantInputs, 0);
  assert.equal(result.secretLeakCount, 0);
});
