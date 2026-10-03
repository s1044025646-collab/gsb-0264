import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SequenceRow {
  id: number;
  name: string | null;
  pages_json: string;
  length: number;
  content_sha256: string;
  created_at: string;
}

export interface AnalysisRow {
  id: number;
  sequence_id: number;
  capacity: number;
  result_json: string;
  faults: number;
  hits: number;
  hit_rate: number | null;
  created_at: string;
}

let dbInstance: DatabaseSync | null = null;

/**
 * 打开（并初始化）项目内数据目录中的 SQLite 数据库。
 * 序列以不可变快照保存：再次导入相同/修改后的序列都会生成新版本，
 * 旧报告永远绑定旧快照，改动原序列不会影响历史结果。
 */
export function initSchema(db: DatabaseSync): DatabaseSync {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      pages_json TEXT NOT NULL,
      length INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence_id INTEGER NOT NULL REFERENCES sequences(id),
      capacity INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      faults INTEGER NOT NULL,
      hits INTEGER NOT NULL,
      hit_rate REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(sequence_id, capacity)
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_sequence ON analyses(sequence_id);
  `);
  return db;
}

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  return initSchema(db);
}

export function getDatabase(dbPath: string): DatabaseSync {
  if (!dbInstance) dbInstance = openDatabase(dbPath);
  return dbInstance;
}

/** 测试支持：重置单例。 */
export function resetDatabaseForTest(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
