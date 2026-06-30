import assert from "node:assert/strict";
import test from "node:test";
import { AppServerPool, type AppServerEndpoint } from "../../src/app-server/pool.ts";
import { AppError } from "../../src/core/errors.ts";

class FakeEndpoint implements AppServerEndpoint {
  readonly id = "local";
  state: AppServerEndpoint["state"] = "ready";
  fail = false;
  nextTurn = 1;

  async request<T>(method: string): Promise<T> {
    if (this.fail) throw new Error("transport failed");
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurn++}` } } as T;
    }
    return {} as T;
  }
}

test("turn permits remain reserved until terminal completion", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });

  const first = await pool.startTurn("local", { threadId: "t1", input: [] });
  assert.equal(first.turn.id, "turn-1");
  await assert.rejects(
    pool.startTurn("local", { threadId: "t2", input: [] }),
    (error: unknown) => error instanceof AppError && error.code === "CAPACITY_EXCEEDED",
  );

  pool.markTurnTerminal("local", "t1", "turn-1");
  assert.equal((await pool.startTurn("local", { threadId: "t2", input: [] })).turn.id, "turn-2");
});

test("failed starts and endpoint loss release capacity", async () => {
  const endpoint = new FakeEndpoint();
  const pool = new AppServerPool([endpoint], { maxConcurrentTurns: 1 });
  endpoint.fail = true;
  await assert.rejects(pool.startTurn("local", { threadId: "t1", input: [] }));
  endpoint.fail = false;
  await pool.startTurn("local", { threadId: "t1", input: [] });
  pool.markEndpointUnavailable("local");
  endpoint.state = "ready";
  await pool.startTurn("local", { threadId: "t2", input: [] });
});

