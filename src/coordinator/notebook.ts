import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { AppError } from "../core/errors.ts";

const entrySchema = z.object({
  thread_id: z.string().min(1),
  project_status: z.string().default(""),
  current_objective: z.string().optional(),
  last_sent: z.object({ message: z.string(), at: z.string() }).optional(),
  last_worker_event: z.object({ message_id: z.string(), status: z.string(), at: z.string() }).optional(),
  pending_follow_up: z.string().nullable().optional(),
  updated_at: z.string(),
});
const notebookSchema = z.object({ version: z.literal(1), sessions: z.record(z.string(), entrySchema) });
export type NotebookDocument = z.infer<typeof notebookSchema>;

async function writeAtomic(path: string, document: NotebookDocument): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export class CoordinatorNotebook {
  private tail: Promise<void> = Promise.resolve();
  private constructor(private readonly path: string, private document: NotebookDocument) {}

  static async bootstrap(path: string, examplePath: string): Promise<CoordinatorNotebook> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AppError("CONFIGURATION_ERROR", `invalid coordinator notebook ${path}`);
      const document = parseNotebook(await readFile(examplePath, "utf8"), path);
      await writeAtomic(path, document);
      return new CoordinatorNotebook(path, document);
    }
    return new CoordinatorNotebook(path, parseNotebook(source, path));
  }

  snapshot(): NotebookDocument {
    return structuredClone(this.document);
  }

  async reconcileNicknames(nicknamesByThread: ReadonlyMap<string, string>): Promise<void> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const current = notebookSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      const sessions: NotebookDocument["sessions"] = {};
      for (const [nickname, entry] of Object.entries(current.sessions)) {
        sessions[nicknamesByThread.get(entry.thread_id) ?? nickname] = entry;
      }
      this.document = { version: 1, sessions };
      await writeAtomic(this.path, this.document);
    } finally {
      release();
    }
  }
}

function parseNotebook(source: string, path: string): NotebookDocument {
  try {
    return notebookSchema.parse(JSON.parse(source));
  } catch {
    throw new AppError("CONFIGURATION_ERROR", `invalid coordinator notebook ${path}`);
  }
}
