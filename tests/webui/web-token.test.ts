import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("concurrent first-use token creation returns one installed credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-web-token-"));
  const gate = join(root, "gate");
  const moduleUrl = pathToFileURL(resolve("src/webui/web-token.ts")).href;
  const count = 16;
  const children: ChildProcess[] = [];
  const results: Array<Promise<string>> = [];
  t.after(async () => {
    await writeFile(gate, "cleanup").catch(() => undefined);
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    await Promise.allSettled(results);
    await rm(root, { recursive: true, force: true });
  });
  for (let index = 0; index < count; index += 1) {
    const ready = join(root, `ready-${index}`);
    const script = [
      `import { existsSync, writeFileSync } from "node:fs";`,
      `import { ensureWebUiToken } from ${JSON.stringify(moduleUrl)};`,
      `writeFileSync(${JSON.stringify(ready)}, "");`,
      `const timer = setInterval(() => {`,
      `  if (!existsSync(${JSON.stringify(gate)})) return;`,
      `  clearInterval(timer);`,
      `  process.stdout.write(ensureWebUiToken(${JSON.stringify(root)}));`,
      `}, 1);`,
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    results.push(new Promise<string>((resolveToken, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 && signal === null
        ? resolveToken(Buffer.concat(stdout).toString())
        : reject(new Error(`token child failed (${signal ?? code})`)));
    }));
  }

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const ready = (await readdir(root)).filter((name) => name.startsWith("ready-")).length;
    if (ready === count) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal((await readdir(root)).filter((name) => name.startsWith("ready-")).length, count);
  await writeFile(gate, "go");

  const tokens = await Promise.all(results);
  assert.equal(new Set(tokens).size, 1);
  assert.equal(await readFile(join(root, "web-token"), "utf8"), tokens[0]);
});
