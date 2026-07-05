import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

test("runs an argv-only process and bounds captured output", async () => {
  const result = await runBoundedProcess(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 1_000, maxOutputBytes: 16 });
  assert.equal(result.stdout.toString(), "ok");
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100))"], { timeoutMs: 1_000, maxOutputBytes: 16 }),
    /output limit/u,
  );
});

test("times out without returning child output in the error", async () => {
  await assert.rejects(
    runBoundedProcess(process.execPath, ["-e", "process.stderr.write('SECRET'); setTimeout(() => {}, 10000)"], { timeoutMs: 10, maxOutputBytes: 1024 }),
    (error: unknown) => error instanceof Error && /timed out/u.test(error.message) && !error.message.includes("SECRET"),
  );
});
