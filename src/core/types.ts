/**
 * 公开限制（长度与容量上限）。
 * 序列最多 10 000 次访问；容量最多 1 000 页；页号为非空字符串，单个页号最长 64 字符。
 */
export const LIMITS = {
  MAX_SEQUENCE_LENGTH: 10_000,
  MAX_CAPACITY: 1_000,
  MAX_PAGE_LABEL_LENGTH: 64,
} as const;

/** 候选项下一次出现的位置；无后续出现时使用显式状态而非魔法数字。 */
export interface CandidateNextUse {
  page: string;
  /** 下一次访问下标；当 state 为 NEVER_AGAIN 时为 null。 */
  nextIndex: number | null;
  /** NO_NEXT 表示该页此后不再出现（最优规则下优先淘汰）。 */
  state: "HAS_NEXT" | "NO_NEXT";
}

export interface ReplacementDecision {
  /** 被淘汰页；命中或容量为零时为 null。 */
  evictedPage: string | null;
  /** 淘汰时刻缓存中各候选页的下一次出现情况（按稳定编号顺序排列）。 */
  candidates: CandidateNextUse[];
  /** 决策依据的人类可读说明。 */
  reason: string;
}

export interface StepReport {
  /** 0 基访问下标。 */
  index: number;
  page: string;
  event: "HIT" | "FAULT";
  /** 访问前缓存（按稳定编号顺序）。 */
  cacheBefore: string[];
  /** 访问后缓存（按稳定编号顺序）。 */
  cacheAfter: string[];
  /** 淘汰决策；命中或无需淘汰时为 null。 */
  replacement: ReplacementDecision | null;
}

export interface AnalysisResult {
  sequence: string[];
  capacity: number;
  steps: StepReport[];
  faults: number;
  hits: number;
  accesses: number;
  /** 命中率 = hits / accesses；空序列时为 null（分母为零，比例无定义）。 */
  hitRate: number | null;
  faultRate: number | null;
  distinctPages: number;
}
