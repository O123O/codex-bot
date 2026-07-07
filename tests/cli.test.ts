import assert from "node:assert/strict";
import test from "node:test";
import { formatCliHelp, formatStartupError, parseCliArgs } from "../src/cli.ts";
import { AppError } from "../src/core/errors.ts";

test("parses an explicit assistant workdir", () => {
  assert.deepEqual(parseCliArgs([]), { command: "run" });
  assert.deepEqual(parseCliArgs(["--workdir", "./manager"]), { command: "run", assistantWorkdir: "./manager" });
  assert.deepEqual(parseCliArgs(["--home", "/srv/qiyan", "--workdir", "/srv/qiyan/work"]), {
    command: "run", qiyanHome: "/srv/qiyan", assistantWorkdir: "/srv/qiyan/work",
  });
  assert.deepEqual(parseCliArgs(["assistant-login"]), { command: "assistant-login" });
  assert.deepEqual(parseCliArgs(["assistant-login", "--home", "/srv/qiyan"]), { command: "assistant-login", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["weixin-login"]), { command: "weixin-login" });
  assert.deepEqual(parseCliArgs(["weixin-login", "--home", "/srv/qiyan"]), { command: "weixin-login", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["config-check", "--home", "/srv/qiyan"]), { command: "config-check", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["--version"]), { command: "version" });
  assert.deepEqual(parseCliArgs(["--update"]), { command: "update" });
});

test("parses top-level and command-specific help without accepting extra arguments", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { command: "help", topic: "root" });
  assert.deepEqual(parseCliArgs(["-h"]), { command: "help", topic: "root" });
  assert.deepEqual(parseCliArgs(["assistant-login", "--help"]), { command: "help", topic: "assistant-login" });
  assert.deepEqual(parseCliArgs(["weixin-login", "-h"]), { command: "help", topic: "weixin-login" });
  assert.deepEqual(parseCliArgs(["config-check", "--help"]), { command: "help", topic: "config-check" });
  assert.throws(() => parseCliArgs(["--help", "--home", "/srv/qiyan"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["assistant-login", "--help", "--home", "/srv/qiyan"]), /unknown argument/);
});

test("formats useful top-level and command-specific help", () => {
  const root = formatCliHelp("root");
  assert.match(root, /^QiYan personal assistant bot\n/u);
  assert.match(root, /Usage:\n  qiyan-bot \[--home <path>\] \[--workdir <path>\]/u);
  assert.match(root, /qiyan-bot assistant-login \[--home <path>\]/u);
  assert.match(root, /-h, --help/u);
  assert.match(root, /Requires Node\.js 24 or newer\./u);
  assert.equal(root.endsWith("\n"), true);

  const login = formatCliHelp("assistant-login");
  assert.match(login, /Usage:\n  qiyan-bot assistant-login \[--home <path>\]/u);
  assert.doesNotMatch(login, /--workdir/u);

  assert.match(formatCliHelp("weixin-login"), /qiyan-bot weixin-login \[--home <path>\]/u);
  assert.match(formatCliHelp("config-check"), /qiyan-bot config-check \[--home <path>\]/u);
});

test("rejects missing, repeated, and unknown CLI arguments", () => {
  assert.throws(() => parseCliArgs(["--workdir"]), /requires a path/);
  assert.throws(() => parseCliArgs(["--home"]), /requires a path/);
  assert.throws(() => parseCliArgs(["--workdir", "one", "--workdir", "two"]), /only once/);
  assert.throws(() => parseCliArgs(["--home", "one", "--home", "two"]), /only once/);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["assistant-login", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["weixin-login", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["config-check", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--version", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--update", "--version"]), /unknown argument/);
});

test("does not echo an unknown argument into a startup error", () => {
  let failure: unknown;
  try { parseCliArgs(["--unknown=secret-token"]); } catch (error) { failure = error; }
  assert.equal(formatStartupError(failure), "CONFIGURATION_ERROR: unknown argument");
  assert.doesNotMatch(formatStartupError(failure), /secret-token/);
});

test("formats only known user-facing startup failures", () => {
  assert.equal(formatStartupError(new AppError("CONFIGURATION_ERROR", "managed file changed")), "CONFIGURATION_ERROR: managed file changed");
  assert.equal(formatStartupError(new Error("request contained secret-token")), "startup failed");
});
