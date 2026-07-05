import assert from "node:assert/strict";
import test from "node:test";
import { buildSshArgs, parseSshConfig, planSshConnection } from "../../src/endpoints/ssh-config.ts";

const parsed = `hostname host.example\nuser xin\nport 2222\ncontrolmaster no\ncontrolpath none\n`;

test("parses effective SSH configuration and pins the final destination", () => {
  const effective = parseSshConfig(parsed);
  const plan = planSshConnection("devbox", effective, "/run/user/1000/qiyan");
  assert.deepEqual(plan.destination, { hostname: "host.example", user: "xin", port: 2222 });
  assert.equal(plan.ownsControlMaster, true);
  assert.match(plan.controlPath!, /\/ssh\/[a-f0-9]{24}$/u);
  const args = buildSshArgs(plan, ["-N"]);
  assert.deepEqual(args.slice(0, 6), ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]);
  assert.ok(args.includes("HostName=host.example"));
  assert.ok(args.includes("xin"));
  assert.ok(args.includes("2222"));
  assert.equal(args.at(-1), "devbox");
});

test("honors a usable user ControlMaster without taking ownership", () => {
  const effective = parseSshConfig(`${parsed}controlmaster auto\ncontrolpath /tmp/user-master\n`);
  const plan = planSshConnection("devbox", effective, "/private/runtime");
  assert.equal(plan.ownsControlMaster, false);
  assert.equal(plan.controlPath, "/tmp/user-master");
  assert.doesNotMatch(buildSshArgs(plan, [] ).join(" "), /ControlPersist/u);
});

test("rejects malformed effective configuration and unsafe aliases", () => {
  assert.throws(() => parseSshConfig("hostname x\nuser y\nport nope\n"), /port/u);
  assert.throws(() => planSshConnection("bad alias", parseSshConfig(parsed), "/private/runtime"), /endpoint alias/u);
});
