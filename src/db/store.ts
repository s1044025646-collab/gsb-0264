import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeBelady } from "../core/belady.js";
import type { AnalysisResult } from "../core/types.js";

/**
 * SQLite 存储。
 *
 * 序列以“版本”为单位不可变保存：同一名称重复导入会产生新版本，
 * 旧版本及其分析报告永远不会被覆盖（改动原序列不改变旧报告）。
 * 分析结果以完整 JSON 原样落库，重放查询不需要重新计算。
 */

export interface SequenceRow {
  id: number;
  name: string | null;
  version: number;
  sequence: string[];
  createdAt: string;
}

export interface AnalysisRow {
  id: number;
  sequenceId: number;
  capacity: number;
  faults: number;
  hits: number;
  hitRate: number | null;
  result: AnalysisResult;
  createdAt: string;
}

export class NotFoundError extends Error {
  code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const absolute = resolve(dbPath);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        version INTEGER NOT NULL,
        sequence_json TEXT NOT NULL,
        seq_length INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence_id INTEGER NOT NULL
          REFERENCES sequences(id) ON DELETE CASCADE,
        capacity INTEGER NOT NULL,
        faults INTEGER NOT NULL,
        hits INTEGER NOT NULL,
        hit_rate REAL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(sequence_id, capacity)
      );
    `);
  }

  /** 导入序列；同名序列自动产生新版本。返回不可变行。 */
  importSequence(sequence: string[], name: string | null): SequenceRow {
    const version = this.nextVersion(name);
    const info = this.db
      .prepare(
        `INSERT INTO sequences (name, version, sequence_json, seq_length)
         VALUES (?, ?, ?, ?)`,
      )
      .run(name, version, JSON.stringify(sequence), sequence.length);
    return this.getSequence(Number(info.lastInsertRowid));
  }

  private nextVersion(name: string | null): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM sequences WHERE name IS ?")
      .get(name) as { v: number } | undefined;
    return (row?.v ?? 0) + 1;
  }

  getSequence(id: number): SequenceRow {
    const row = this.db
      .prepare("SELECT * FROM sequences WHERE id = ?")
      .get(id) as DbSequence | undefined;
    if (!row) {
      throw new NotFoundError(`序列版本 id=${id} 不存在`);
    }
    return hydrateSequence(row);
  }

  /** 默认取该名称最新版本；不传名称则取全局最新导入。 */
  resolveLatest(name?: string | null): SequenceRow {
    const row =
      name === undefined
        ? (this.db
            .prepare("SELECT * FROM sequences ORDER BY id DESC LIMIT 1")
            .get() as DbSequence | undefined)
        : (this.db
            .prepare(
              "SELECT * FROM sequences WHERE name = ? ORDER BY version DESC LIMIT 1",
            )
            .get(name) as DbSequence | undefined);
    if (!row) {
      throw new NotFoundError(
        name ? `名称为 ${name} 的序列不存在` : "数据库中尚无序列",
      );
    }
    return hydrateSequence(row);
  }

  listSequences(): SequenceRow[] {
    const rows = this.db
      .prepare("SELECT * FROM sequences ORDER BY id ASC")
      .all() as DbSequence[];
    return rows.map(hydrateSequence);
  }

  /** 运行分析并持久化；同一 (sequenceId, capacity) 幂等返回既有报告。 */
  analyze(sequenceId: number, capacity: number): AnalysisRow {
    const seqRow = this.getSequence(sequenceId);
    const existing = this.db
      .prepare("SELECT * FROM analyses WHERE sequence_id = ? AND capacity = ?")
      .get(sequenceId, capacity) as DbAnalysis | undefined;
    if (existing) {
      return hydrateAnalysis(existing);
    }
    const result = analyzeBelady(seqRow.sequence, capacity);
    const info = this.db
      .prepare(
        `INSERT INTO analyses
           (sequence_id, capacity, faults, hits, hit_rate, result_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequenceId,
        capacity,
        result.faults,
        result.hits,
        result.hitRate,
        JSON.stringify(result),
      );
    return this.getAnalysis(Number(info.lastInsertRowid));
  }

  getAnalysis(id: number): AnalysisRow {
    const row = this.db
      .prepare("SELECT * FROM analyses WHERE id = ?")
      .get(id) as DbAnalysis | undefined;
    if (!row) {
      throw new NotFoundError(`分析 id=${id} 不存在`);
    }
    return hydrateAnalysis(row);
  }

  listAnalyses(sequenceId?: number): AnalysisRow[] {
    const rows =
      sequenceId === undefined
        ? (this.db
            .prepare("SELECT * FROM analyses ORDER BY id ASC")
            .all() as DbAnalysis[])
        : (this.db
            .prepare(
              "SELECT * FROM analyses WHERE sequence_id = ? ORDER BY capacity ASC",
            )
            .all(sequenceId) as DbAnalysis[]);
    return rows.map(hydrateAnalysis);
  }

  close(): void {
    this.db.close();
  }
}

interface DbSequence {
  id: number;
  name: string | null;
  version: number;
  sequence_json: string;
  seq_length: number;
  created_at: string;
}

interface DbAnalysis {
  id: number;
  sequence_id: number;
  capacity: number;
  faults: number;
  hits: number;
  hit_rate: number | null;
  result_json: string;
  created_at: string;
}

function hydrateSequence(row: DbSequence): SequenceRow {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    sequence: JSON.parse(row.sequence_json) as string[],
    createdAt: row.created_at,
  };
}

function hydrateAnalysis(row: DbAnalysis): AnalysisRow {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    capacity: row.capacity,
    faults: row.faults,
    hits: row.hits,
    hitRate: row.hit_rate,
    result: JSON.parse(row.result_json) as AnalysisResult,
    createdAt: row.created_at,
  };
}
