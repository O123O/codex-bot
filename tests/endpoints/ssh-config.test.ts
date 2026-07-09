import assert from "node:assert/strict";
import test from "node:test";
import {
  SshGenerationPlanner,
  buildControlMasterExitArgs,
  buildSshArgs,
  buildSshStreamForwardArgs,
  parseSshConfig,
  planSshConnection,
} from "../../src/endpoints/ssh-config.ts";

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
  assert.throws(() => buildControlMasterExitArgs(plan), /user-owned/u);
});

test("stream-local forwarding owns a dedicated non-multiplexed SSH process", () => {
  const plan = planSshConnection("devbox", parseSshConfig(`${parsed}controlmaster auto\ncontrolpath /tmp/user-master\n`), "/private/runtime");
  const args = buildSshStreamForwardArgs(plan, "/private/qiyan/f-01234567.sock", "/tmp/qiyan-1000/abcdef/app-server.sock");
  const rendered = args.join(" ");
  assert.match(rendered, /-N -T -n/u);
  for (const option of [
    "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "ExitOnForwardFailure=yes",
    "ForkAfterAuthentication=no", "StreamLocalBindUnlink=no", "StreamLocalBindMask=0177",
  ]) assert.ok(args.includes(option), option);
  assert.doesNotMatch(rendered, /user-master|ControlMaster=auto|ControlPersist=60/u);
  assert.ok(args.includes("/private/qiyan/f-01234567.sock:/tmp/qiyan-1000/abcdef/app-server.sock"));
  assert.equal(args.at(-1), "devbox");
});

test("rejects malformed effective configuration and unsafe aliases", () => {
  assert.throws(() => parseSshConfig("hostname x\nuser y\nport nope\n"), /port/u);
  assert.throws(() => planSshConnection("bad alias", parseSshConfig(parsed), "/private/runtime"), /endpoint alias/u);
});

test("falls back to an owned master when the effective ControlPath is unsafe", () => {
  for (const controlPath of ["relative/socket", "/tmp/bad\npath", `/tmp/${"x".repeat(110)}`]) {
    const plan = planSshConnection("devbox", { ...parseSshConfig(parsed), controlMaster: "auto", controlPath }, "/private/runtime");
    assert.equal(plan.ownsControlMaster, true);
    assert.ok(buildControlMasterExitArgs(plan).includes("exit"));
  }
});

test("interactive ControlMaster modes use QiYan's noninteractive fallback", () => {
  for (const controlMaster of ["ask", "autoask"]) {
    const plan = planSshConnection("devbox", { ...parseSshConfig(parsed), controlMaster, controlPath: "/tmp/user-master" }, "/private/runtime");
    assert.equal(plan.ownsControlMaster, true);
  }
});

test("re-resolves SSH configuration and checks the durable binding on every generation", async () => {
  let hostname = "host-one";
  const checked: Array<{ endpointId: string; hostname: string; references: boolean }> = [];
  const planner = new SshGenerationPlanner({
    sshBinary: "ssh",
    runtimeDir: "/private/runtime",
    hasReferences: (endpointId) => endpointId === "devbox",
    checkExisting: (endpointId, destination, references) => { checked.push({ endpointId, hostname: destination.hostname, references }); },
    run: async (command, args) => {
      assert.equal(command, "ssh");
      assert.deepEqual(args, ["-G", "devbox"]);
      return { stdout: Buffer.from(`hostname ${hostname}\nuser xin\nport 22\ncontrolmaster no\ncontrolpath none\n`), stderr: Buffer.alloc(0) };
    },
  });
  const first = await planner.createGeneration("devbox");
  hostname = "host-two";
  const second = await planner.createGeneration("devbox");
  assert.equal(first.pendingBinding.destination.hostname, "host-one");
  assert.equal(second.pendingBinding.destination.hostname, "host-two");
  assert.deepEqual(checked, [
    { endpointId: "devbox", hostname: "host-one", references: true },
    { endpointId: "devbox", hostname: "host-two", references: true },
  ]);
});
