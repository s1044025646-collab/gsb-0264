/**
 * 核心数据类型定义。
 *
 * 下一次出现下标使用可辨识联合：
 * - { kind: "future", index } 表示将在未来 index（0 基）处再次访问；
 * - { kind: "never" } 表示此后不再出现。
 *
 * 刻意不用 -1 之类的“魔法数字”，避免与合法下标混淆。
 */

export type NextOccurrence =
  | { kind: "future"; index: number }
  | { kind: "never" };

export interface CandidateView {
  page: string;
  nextOccurrence: NextOccurrence;
}

export type StepOutcome = "HIT" | "FAULT";

export interface AnalysisStep {
  /** 访问序号，从 0 开始 */
  index: number;
  /** 本次访问的页标识 */
  page: string;
  /** 命中或缺页 */
  outcome: StepOutcome;
  /** 本次访问之前的缓存（按稳定顺序排列） */
  cacheBefore: string[];
  /** 本次访问之后的缓存（按稳定顺序排列） */
  cacheAfter: string[];
  /** 淘汰发生时被逐出的页；未淘汰为 null */
  evictedPage: string | null;
  /** 淘汰判定时缓存内各候选的下一次出现情况；未发生淘汰为空数组 */
  candidates: CandidateView[];
  /** 人类可读的淘汰依据说明 */
  reason: string;
}

export interface AnalysisResult {
  sequence: string[];
  capacity: number;
  distinctPages: number;
  length: number;
  faults: number;
  hits: number;
  /** 命中率 = hits / 访问数；空序列为 null（分母为 0，语义见 README） */
  hitRate: number | null;
  /** 缺页率，空序列同样为 null */
  faultRate: number | null;
  steps: AnalysisStep[];
  algorithm: "BELADY_OPT";
  tieBreakRule: string;
}

export interface ScanEntry {
  capacity: number;
  faults: number;
  hits: number;
  hitRate: number | null;
}
