import { randomBytes, randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "web-token";

export function readWebUiToken(dataDir: string): string | undefined {
  try { return readFileSync(join(dataDir, TOKEN_FILE), "utf8").trim() || undefined; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function ensureWebUiToken(dataDir: string): string {
  const existing = readWebUiToken(dataDir);
  if (existing) return existing;

  const token = randomBytes(32).toString("base64url");
  const path = join(dataDir, TOKEN_FILE);
  const temporary = writeTemporaryToken(dataDir, token);
  try {
    linkSync(temporary, path);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = readWebUiToken(dataDir);
    if (!winner) throw error;
    return winner;
  } finally {
    removeTemporary(temporary);
  }
}

export function rotateWebUiToken(dataDir: string): string {
  const token = randomBytes(32).toString("base64url");
  const path = join(dataDir, TOKEN_FILE);
  const temporary = writeTemporaryToken(dataDir, token);
  try {
    renameSync(temporary, path);
  } finally {
    removeTemporary(temporary);
  }
  return token;
}

function writeTemporaryToken(dataDir: string, token: string): string {
  const temporary = join(dataDir, `.web-token.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
  return temporary;
}

function removeTemporary(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
