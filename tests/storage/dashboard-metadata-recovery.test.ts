import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { prepareDashboardMetadataRecovery, RECOVERY_TABLES } from "../../src/storage/dashboard-metadata-recovery.ts";
import { runConversationRoutingBackfill } from "../../src/storage/conversation-cutover.ts";

interface Watermarks {
  notification?: number;
  settings?: number;
  token?: number;
  goal?: number;
  runtime?: number;
}

test("recovery copies every readable table exactly and rebuilds only dashboard metadata", async (t) => {
  const value = await recoveryFixture(t, { notification: 4, settings: 7, token: 12, goal: 9, runtime: 11 });
  const sourceBefore = await readFile(value.databasePath);
  const reported: string[] = [];

  const prepared = await prepareDashboardMetadataRecovery(value.databasePath, {
    onBackupComplete: (path) => { reported.push(path); },
  });

  assert.deepEqual(reported, [prepared.quarantinePath]);
  assert.deepEqual(await readFile(value.databasePath), sourceBefore);
  assert.equal(prepared.copiedTableCount, RECOVERY_TABLES.length - 1);
  assert.equal(prepared.nextObservationSequence, 13);
  assert.doesNotMatch(JSON.stringify(prepared), /private project note|private operation result/u);

  const candidate = new DatabaseSync(prepared.candidatePath, { readOnly: true });
  const note = candidate.prepare("SELECT project_summary, supervision_objective FROM session_manager_notes").get()!;
  assert.equal(note.project_summary, "private project note");
  assert.equal(note.supervision_objective, "private operation result");
  assert.deepEqual({ ...candidate.prepare("SELECT * FROM session_dashboard_meta").get()! }, {
    singleton: 1,
    assistant_root: null,
    dirty: 1,
    revision: 0,
    next_observation_sequence: 13,
    last_render_error: null,
    render_failure_generation: 0,
  });
  assert.equal(candidate.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  assert.equal(candidate.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  assert.deepEqual(candidate.prepare("PRAGMA foreign_key_check").all(), []);
  candidate.close();

  const manifest = JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.state, "backup_complete");
  assert.equal(manifest.canonical_basename, "bot.sqlite3");
  assert.doesNotMatch(JSON.stringify(manifest), /private project note|private operation result|\/tmp\//u);
});

test("each persisted watermark can independently determine the next observation sequence", async (t) => {
  for (const key of ["notification", "settings", "token", "goal", "runtime"] as const) {
    const value = await recoveryFixture(t, { [key]: 41 });
    const prepared = await prepareDashboardMetadataRecovery(value.databasePath);
    assert.equal(prepared.nextObservationSequence, 42, key);
    const candidate = new DatabaseSync(prepared.candidatePath, { readOnly: true });
    assert.equal(candidate.prepare("SELECT next_observation_sequence AS value FROM session_dashboard_meta").get()!.value, 42);
    candidate.close();
  }
});

test("recovery reads committed hot-WAL rows from its read-only working copy", async (t) => {
  const value = await recoveryFixture(t);
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;");
    db.exec("UPDATE telegram_state SET next_update_id = 99 WHERE singleton = 1");
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, value.databasePath], { encoding: "utf8", env: {} });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");

  const ignoresWal = new DatabaseSync(`file:${value.databasePath}?immutable=1`, { readOnly: true });
  assert.equal(ignoresWal.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 0);
  ignoresWal.close();
  const seesWal = new DatabaseSync(value.databasePath, { readOnly: true });
  assert.equal(seesWal.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 99);
  seesWal.close();

  const before = await artifactBytes(value.databasePath);
  const prepared = await prepareDashboardMetadataRecovery(value.databasePath);
  const after = await artifactBytes(value.databasePath);
  assert.deepEqual(after, before);
  const candidate = new DatabaseSync(prepared.candidatePath, { readOnly: true });
  assert.equal(candidate.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 99);
  candidate.close();
});

test("recovery rejects unsafe observation watermarks and removes its candidate", async (t) => {
  for (const watermark of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const value = await recoveryFixture(t, { settings: watermark });
    let quarantinePath: string | undefined;
    let failure: unknown;
    try {
      await prepareDashboardMetadataRecovery(value.databasePath, {
        onBackupComplete: (path) => { quarantinePath = path; },
      });
    } catch (error) { failure = error; }

    assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
      && failure.message === "QiYan Bot state database recovery failed; retained backup was not installed", true);
    assert.notEqual(quarantinePath, undefined);
    await assert.rejects(access(join(quarantinePath!, "candidate.sqlite3")));
    assert.equal(JSON.parse(await readFile(join(quarantinePath!, "manifest.json"), "utf8")).state, "backup_complete");
  }
});

test("structural validation ignores stored SQL formatting but rejects unexpected schema", async (t) => {
  const formatted = await recoveryFixture(t, {}, (db) => {
    rewriteSchemaSql(db, "qiyan_state", (sql) => sql.replace("CREATE TABLE qiyan_state", "CREATE  TABLE qiyan_state"));
  });
  const prepared = await prepareDashboardMetadataRecovery(formatted.databasePath);
  assert.equal(prepared.copiedTableCount, RECOVERY_TABLES.length - 1);

  const changed = await recoveryFixture(t, {}, (db) => {
    db.exec("CREATE INDEX unexpected_recovery_index ON session_manager_notes(project_summary)");
  });
  let quarantinePath: string | undefined;
  await assert.rejects(prepareDashboardMetadataRecovery(changed.databasePath, {
    onBackupComplete: (path) => { quarantinePath = path; },
  }), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery failed; retained backup was not installed");
  assert.notEqual(quarantinePath, undefined);
  await assert.rejects(access(join(quarantinePath!, "candidate.sqlite3")));

  const changedConstraint = await recoveryFixture(t, {}, (db) => {
    rewriteSchemaSql(db, "qiyan_state", (sql) => sql.replace("state_version INTEGER NOT NULL", "state_version INTEGER"));
  });
  await assert.rejects(prepareDashboardMetadataRecovery(changedConstraint.databasePath), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery failed; retained backup was not installed");
});

test("an unreadable authoritative table fails without exposing rows and leaves the source unchanged", async (t) => {
  const value = await recoveryFixture(t, {}, undefined, "session_manager_notes");
  const sourceBefore = await readFile(value.databasePath);
  let quarantinePath: string | undefined;
  let failure: unknown;
  try {
    await prepareDashboardMetadataRecovery(value.databasePath, {
      onBackupComplete: (path) => { quarantinePath = path; },
    });
  } catch (error) { failure = error; }

  assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
    && failure.message === "QiYan Bot state database recovery failed; retained backup was not installed", true);
  assert.doesNotMatch(failure instanceof Error ? failure.message : "", /private project note|private operation result/u);
  assert.deepEqual(await readFile(value.databasePath), sourceBefore);
  assert.notEqual(quarantinePath, undefined);
  await assert.rejects(access(join(quarantinePath!, "candidate.sqlite3")));
});

test("source races cannot publish an inconsistent backup manifest", async (t) => {
  for (const race of ["mutate", "add", "remove", "replace"] as const) {
    const value = await recoveryFixture(t);
    if (race === "remove") await writeFile(`${value.databasePath}-journal`, "stable-journal", { mode: 0o600 });
    let scratchPath: string | undefined;
    const reported: string[] = [];
    let failure: unknown;
    try {
      await prepareDashboardMetadataRecovery(value.databasePath, {
        beforeBackupComplete: async (path) => {
          scratchPath = path;
          if (race === "mutate") {
            const file = await open(value.databasePath, "r+");
            try { await file.write(Buffer.from([0x51]), 0, 1, 0); }
            finally { await file.close(); }
          } else if (race === "add") {
            await writeFile(`${value.databasePath}-wal`, "new-sidecar", { mode: 0o600 });
          } else if (race === "remove") {
            await rm(`${value.databasePath}-journal`);
          } else {
            const bytes = await readFile(value.databasePath);
            await rename(value.databasePath, `${value.databasePath}.replaced`);
            await writeFile(value.databasePath, bytes, { mode: 0o600 });
          }
        },
        onBackupComplete: (path) => { reported.push(path); },
      });
    } catch (error) { failure = error; }

    assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
      && failure.message === "QiYan Bot state database recovery source is unsafe", true, race);
    assert.deepEqual(reported, [], race);
    assert.notEqual(scratchPath, undefined, race);
    await assert.rejects(access(join(scratchPath!, "manifest.json")));
    await assert.rejects(access(scratchPath!));
  }
});

async function recoveryFixture(
  t: TestContext,
  watermarks: Watermarks = {},
  customize?: (db: DatabaseSync) => void,
  corruptTable = "session_dashboard_meta",
): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-dashboard-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "bot.sqlite3");
  const db = openDatabase(databasePath);
  runConversationRoutingBackfill(db);
  db.exec("UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1");
  db.exec("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'");
  db.prepare(`INSERT INTO session_manager_notes
    (endpoint_id, thread_id, project_summary, supervision_objective, pending_follow_up, updated_at)
    VALUES ('local', 'thread-private', 'private project note', 'private operation result', NULL, 1)`).run();
  db.prepare(`INSERT INTO session_rollout_ownership
    (endpoint_id, thread_id, mapping_id, rollout_path, device, inode, byte_offset, external_turn_id, updated_at)
    VALUES ('local', 'thread-private', 'mapping-private', '/private/rollout', '1', '2', 3, NULL, 1)`).run();
  db.prepare(`INSERT INTO session_rollout_owned_turns
    (endpoint_id, thread_id, mapping_id, turn_id, recorded_at)
    VALUES ('local', 'thread-private', 'mapping-private', 'turn-private', 1)`).run();
  if (watermarks.notification !== undefined) {
    db.prepare(`INSERT INTO session_dashboard_notifications
      (sequence, endpoint_id, method, params_json, state, received_at)
      VALUES (?, 'local', 'test/method', '{}', 'completed', 1)`).run(watermarks.notification);
  }
  if (watermarks.settings !== undefined || watermarks.token !== undefined || watermarks.goal !== undefined) {
    db.prepare(`INSERT INTO session_dashboard_facts
      (endpoint_id, thread_id, current_settings_observation_sequence, token_observation_sequence, goal_observation_sequence)
      VALUES ('local', 'thread-private', ?, ?, ?)`).run(
        watermarks.settings ?? null,
        watermarks.token ?? null,
        watermarks.goal ?? null,
      );
  }
  if (watermarks.runtime !== undefined) {
    db.prepare(`INSERT INTO session_runtime
      (endpoint_id, thread_id, mapping_id, management_state, native_status, native_observation_sequence)
      VALUES ('local', 'thread-private', 'mapping-private', 'managed', 'idle', ?)`).run(watermarks.runtime);
  }
  customize?.(db);
  const rootPage = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = ?").get(corruptTable)!.rootpage);
  const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  db.close();

  const handle = await open(databasePath, "r+");
  try { await handle.write(Buffer.alloc(pageSize), 0, pageSize, (rootPage - 1) * pageSize); }
  finally { await handle.close(); }
  return { root, databasePath };
}

function rewriteSchemaSql(db: DatabaseSync, name: string, rewrite: (sql: string) => string): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name) as { sql: string };
  const rewritten = rewrite(row.sql);
  assert.notEqual(rewritten, row.sql);
  db.enableDefensive(false);
  db.exec("PRAGMA writable_schema=ON");
  try { db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?").run(rewritten, name); }
  finally { db.exec("PRAGMA writable_schema=OFF"); db.enableDefensive(true); }
  const version = Number(db.prepare("PRAGMA schema_version").get()!.schema_version);
  db.exec(`PRAGMA schema_version=${version + 1}`);
}

async function artifactBytes(databasePath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { result[suffix || "main"] = (await readFile(`${databasePath}${suffix}`)).toString("base64"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return result;
}
