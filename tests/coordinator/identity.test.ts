import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatStartupError } from "../../src/cli.ts";
import { resumeCoordinatorIdentity } from "../../src/coordinator/identity.ts";
import { AppError } from "../../src/core/errors.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";

test("a legacy local coordinator mapping migrates atomically after exact resume verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinator-identity-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "local", thread_id: "legacy-thread", project_dir: dir },
    sessions: {},
  });
  const calls: Array<{ method: string; params: any }> = [];
  const endpoint = {
    id: "coordinator-local",
    request: async <T>(method: string, params: any) => {
      calls.push({ method, params });
      return { thread: { id: "legacy-thread", cwd: dir, status: { type: "idle" } } } as T;
    },
  };
  const resumed = await resumeCoordinatorIdentity({ registry, endpoint, legacyEndpointId: "local", coordinatorDir: dir, sandboxMode: "workspace-write", config: {} });
  assert.deepEqual(resumed, { threadId: "legacy-thread", nativeStatus: "idle" });
  assert.equal(calls[0]?.method, "thread/resume");
  assert.equal(calls[0]?.params.threadId, "legacy-thread");
  assert.equal(JSON.parse(await readFile(path, "utf8")).coordinator.endpoint, "coordinator-local");
  assert.equal(JSON.parse(await readFile(`${path}.last-good`, "utf8")).coordinator.endpoint, "coordinator-local");
});

test("legacy coordinator migration does not rewrite identity when resumed cwd differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coordinator-identity-bad-"));
  const other = await mkdtemp(join(tmpdir(), "coordinator-identity-other-"));
  const path = join(dir, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "local", thread_id: "legacy-thread", project_dir: dir },
    sessions: {},
  });
  await assert.rejects(resumeCoordinatorIdentity({
    registry,
    endpoint: {
      id: "coordinator-local",
      request: async <T>() => ({ thread: { id: "legacy-thread", cwd: other, status: { type: "idle" } } } as T),
    },
    legacyEndpointId: "local",
    coordinatorDir: dir,
    sandboxMode: "workspace-write",
    config: {},
  }), /working directory/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).coordinator.endpoint, "local");
});

test("configured coordinator directory mismatch is a safe startup error before app-server access", async () => {
  const registered = await mkdtemp(join(tmpdir(), "coordinator-identity-registered-"));
  const configured = await mkdtemp(join(tmpdir(), "coordinator-identity-configured-"));
  const path = join(registered, "sessions.json");
  const registry = await SessionRegistry.open(path, {
    version: 1,
    coordinator: { endpoint: "coordinator-local", thread_id: "thread", project_dir: registered },
    sessions: {},
  });
  let requests = 0;
  let failure: unknown;
  try {
    await resumeCoordinatorIdentity({
      registry,
      endpoint: { id: "coordinator-local", request: async <T>() => { requests += 1; return {} as T; } },
      legacyEndpointId: "local",
      coordinatorDir: configured,
      sandboxMode: "workspace-write",
      config: {},
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AppError);
  assert.equal(failure.code, "CONFIGURATION_ERROR");
  assert.match(formatStartupError(failure), new RegExp(configured.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.equal(requests, 0);
});
