import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors.js";
import type { AnalysisResult } from "../core/types.js";
import { getDatabase, initSchema, type AnalysisRow, type SequenceRow } from "./db.js";

export interface StoredSequence {
  id: number;
  name: string | null;
  pages: string[];
  length: number;
  contentSha256: string;
  createdAt: string;
}

export interface StoredAnalysis {
  id: number;
  sequenceId: number;
  capacity: number;
  result: AnalysisResult;
  faults: number;
  hits: number;
  hitRate: number | null;
  createdAt: string;
}

export function sha256OfSequence(pages: string[]): string {
  return createHash("sha256").update(JSON.stringify(pages)).digest("hex");
}

function mapSequence(row: SequenceRow): StoredSequence {
  return {
    id: row.id,
    name: row.name,
    pages: JSON.parse(row.pages_json) as string[],
    length: row.length,
    contentSha256: row.content_sha256,
    createdAt: row.created_at,
  };
}

function mapAnalysis(row: AnalysisRow): StoredAnalysis {
  return {
    id: row.id,
    sequenceId: row.sequence_id,
    capacity: row.capacity,
    result: JSON.parse(row.result_json) as AnalysisResult,
    faults: row.faults,
    hits: row.hits,
    hitRate: row.hit_rate,
    createdAt: row.created_at,
  };
}

export class Repository {
  constructor(db: DatabaseSync = getDatabase(defaultDbPath())) {
    this.db = initSchema(db);
  }

  private readonly db: DatabaseSync;

  /** 保存序列的不可变快照；相同内容重复导入返回既有快照而不覆盖。 */
  importSequence(pages: string[], name?: string | null): { sequence: StoredSequence; reused: boolean } {
    const hash = sha256OfSequence(pages);
    const existing = this.db
      .prepare("SELECT * FROM sequences WHERE content_sha256 = ? ORDER BY id LIMIT 1")
      .get(hash) as unknown as SequenceRow | undefined;
    if (existing) return { sequence: mapSequence(existing), reused: true };

    const result = this.db
      .prepare("INSERT INTO sequences (name, pages_json, length, content_sha256) VALUES (?, ?, ?, ?)")
      .run(name ?? null, JSON.stringify(pages), pages.length, hash);
    const row = this.db
      .prepare("SELECT * FROM sequences WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as SequenceRow;
    return { sequence: mapSequence(row), reused: false };
  }

  getSequence(id: number): StoredSequence {
    const row = this.db.prepare("SELECT * FROM sequences WHERE id = ?").get(id) as
      | SequenceRow
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `序列版本 ${id} 不存在`, 404);
    return mapSequence(row);
  }

  listSequences(limit = 100, offset = 0): StoredSequence[] {
    const rows = this.db
      .prepare("SELECT * FROM sequences ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as SequenceRow[];
    return rows.map(mapSequence);
  }

  /** 保存或读取某序列在某容量下的分析（同一序列+容量只存一份完整结果）。 */
  saveAnalysis(sequenceId: number, result: AnalysisResult): StoredAnalysis {
    this.getSequence(sequenceId);
    const existing = this.db
      .prepare("SELECT * FROM analyses WHERE sequence_id = ? AND capacity = ?")
      .get(sequenceId, result.capacity) as unknown as AnalysisRow | undefined;
    if (existing) return mapAnalysis(existing);

    const inserted = this.db
      .prepare(
        `INSERT INTO analyses (sequence_id, capacity, result_json, faults, hits, hit_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sequenceId,
        result.capacity,
        JSON.stringify(result),
        result.faults,
        result.hits,
        result.hitRate,
      );
    const row = this.db
      .prepare("SELECT * FROM analyses WHERE id = ?")
      .get(Number(inserted.lastInsertRowid)) as unknown as AnalysisRow;
    return mapAnalysis(row);
  }

  getAnalysis(sequenceId: number, capacity: number): StoredAnalysis {
    const row = this.db
      .prepare("SELECT * FROM analyses WHERE sequence_id = ? AND capacity = ?")
      .get(sequenceId, capacity) as unknown as AnalysisRow | undefined;
    if (!row) {
      throw new AppError(
        "NOT_FOUND",
        `序列版本 ${sequenceId} 在容量 ${capacity} 下尚无分析记录，请先执行分析`,
        404,
      );
    }
    return mapAnalysis(row);
  }

  listAnalyses(sequenceId: number): StoredAnalysis[] {
    this.getSequence(sequenceId);
    const rows = this.db
      .prepare("SELECT * FROM analyses WHERE sequence_id = ? ORDER BY capacity ASC")
      .all(sequenceId) as unknown as AnalysisRow[];
    return rows.map(mapAnalysis);
  }

  /** 历史查询：可按序列名或页号关键字模糊检索，按时间倒序。 */
  queryHistory(options: { name?: string; page?: string; limit?: number }): Array<{
    sequence: StoredSequence;
    analyses: StoredAnalysis[];
  }> {
    const limit = options.limit ?? 50;
    let rows: SequenceRow[];
    if (options.name) {
      rows = this.db
        .prepare(
          "SELECT * FROM sequences WHERE name LIKE ? ORDER BY id DESC LIMIT ?",
        )
        .all(`%${options.name}%`, limit) as unknown as SequenceRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM sequences ORDER BY id DESC LIMIT ?")
        .all(limit) as unknown as SequenceRow[];
    }
    const out: { sequence: StoredSequence; analyses: StoredAnalysis[] }[] = [];
    for (const row of rows) {
      const sequence = mapSequence(row);
      if (options.page && !sequence.pages.includes(options.page)) continue;
      const analyses = this.db
        .prepare("SELECT * FROM analyses WHERE sequence_id = ? ORDER BY capacity ASC")
        .all(sequence.id) as unknown as AnalysisRow[];
      out.push({ sequence, analyses: analyses.map(mapAnalysis) });
    }
    return out;
  }
}

export function defaultDbPath(): string {
  return process.env.PAGE_SIM_DB ?? "data/page-sim.sqlite";
}

