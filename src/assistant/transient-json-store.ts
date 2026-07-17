import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, open, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_FILES = 32;
const FILE_NAME = /^worker-conversation-\d{13}-[0-9a-f-]{36}\.json$/u;

export class TransientJsonStore {
  private root: string | undefined;

  constructor(private readonly parentDir = tmpdir()) {}

  async start(): Promise<void> {
    if (this.root) return;
    const root = await mkdtemp(join(this.parentDir, "qiyan-assistant-results-"));
    try { await chmod(root, 0o700); }
    catch (error) { await rm(root, { recursive: true, force: true }).catch(() => undefined); throw error; }
    this.root = root;
  }

  async write(value: unknown): Promise<string> {
    const root = this.root;
    if (!root) throw new Error("transient JSON store is not started");
    const path = join(root, `worker-conversation-${Date.now().toString().padStart(13, "0")}-${randomUUID()}.json`);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
    catch (error) { await unlink(path).catch(() => undefined); throw error; }
    finally { await handle.close(); }
    await this.prune(root).catch(() => undefined);
    return path;
  }

  async stop(): Promise<void> {
    const root = this.root;
    this.root = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  }

  private async prune(root: string): Promise<void> {
    const names = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && FILE_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    await Promise.all(names.slice(0, Math.max(0, names.length - MAX_FILES)).map((name) => unlink(join(root, name)).catch(() => undefined)));
  }
}
