import assert from "node:assert/strict";
import test from "node:test";
import { ThreadGate } from "../../src/sessions/thread-gate.ts";

test("serializes the same native thread while allowing different threads to proceed", async () => {
  const gate = new ThreadGate();
  const order: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });

  const first = gate.run("local", "t1", async () => { entered(); await barrier; order.push("first"); });
  await firstEntered;
  const second = gate.run("local", "t1", async () => { order.push("second"); });
  const independent = gate.run("local", "t2", async () => { order.push("independent"); });
  await independent;
  assert.deepEqual(order, ["independent"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["independent", "first", "second"]);
});

test("a rejected action releases only its own queue position", async () => {
  const gate = new ThreadGate();
  await assert.rejects(gate.run("local", "t1", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await gate.run("local", "t1", async () => "continued"), "continued");
});
