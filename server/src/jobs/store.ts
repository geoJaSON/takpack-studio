import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { JobProgress, JobRecord, JobStatus } from "../types.js";

/** Mutable subset of JobRecord — id/createdAt are immutable, updatedAt is maintained here. */
export type JobPatch = Partial<
  Pick<
    JobRecord,
    | "status"
    | "progress"
    | "warnings"
    | "error"
    | "artifactPath"
    | "artifactName"
    | "sizeBytes"
  >
>;

interface JobRow {
  id: string;
  status: string;
  progress: string;
  warnings: string;
  error: string | null;
  artifact_path: string | null;
  artifact_name: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * SQLite-backed job persistence at <dataDir>/jobs.sqlite.
 * Stores ONLY JobRecord fields — never the ExportRequest, so API keys can
 * never end up on disk.
 */
export class JobStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly selectStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "jobs.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id            TEXT PRIMARY KEY,
        status        TEXT NOT NULL,
        progress      TEXT NOT NULL,
        warnings      TEXT NOT NULL,
        error         TEXT,
        artifact_path TEXT,
        artifact_name TEXT,
        size_bytes    INTEGER,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO jobs (id, status, progress, warnings, error, artifact_path, artifact_name, size_bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectStmt = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`);
    this.listStmt = this.db.prepare(
      `SELECT * FROM jobs ORDER BY created_at DESC, id`,
    );
    this.updateStmt = this.db.prepare(
      `UPDATE jobs SET status = ?, progress = ?, warnings = ?, error = ?,
        artifact_path = ?, artifact_name = ?, size_bytes = ?, updated_at = ?
       WHERE id = ?`,
    );
  }

  create(): JobRecord {
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: randomUUID(),
      status: "queued",
      progress: { phase: "queued", percent: 0 },
      warnings: [],
      createdAt: now,
      updatedAt: now,
    };
    this.insertStmt.run(
      record.id,
      record.status,
      JSON.stringify(record.progress),
      JSON.stringify(record.warnings),
      null,
      null,
      null,
      null,
      record.createdAt,
      record.updatedAt,
    );
    return record;
  }

  get(id: string): JobRecord | undefined {
    const row = this.selectStmt.get(id) as JobRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  list(): JobRecord[] {
    const rows = this.listStmt.all() as JobRow[];
    return rows.map(rowToRecord);
  }

  /** Merge a patch into an existing record; bumps updatedAt. */
  update(id: string, patch: JobPatch): JobRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: JobRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.updateStmt.run(
      next.status,
      JSON.stringify(next.progress),
      JSON.stringify(next.warnings),
      next.error ?? null,
      next.artifactPath ?? null,
      next.artifactName ?? null,
      next.sizeBytes ?? null,
      next.updatedAt,
      id,
    );
    return next;
  }

  /**
   * Mark jobs left queued/running by a previous process as failed.
   * Returns the number of jobs reconciled. Call once on boot.
   */
  reconcileOrphans(): number {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error = 'server restarted', updated_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: JobRow): JobRecord {
  const record: JobRecord = {
    id: row.id,
    status: row.status as JobStatus,
    progress: JSON.parse(row.progress) as JobProgress,
    warnings: JSON.parse(row.warnings) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.error !== null) record.error = row.error;
  if (row.artifact_path !== null) record.artifactPath = row.artifact_path;
  if (row.artifact_name !== null) record.artifactName = row.artifact_name;
  if (row.size_bytes !== null) record.sizeBytes = row.size_bytes;
  return record;
}
