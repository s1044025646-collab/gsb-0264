import type {
  AnalysisResult,
  AnalysisStep,
  CandidateView,
  NextOccurrence,
  StepOutcome,
} from "./types.js";

/** 公开的序列长度上限（页访问次数） */
export const MAX_SEQUENCE_LENGTH = 10_000;
/** 公开的容量上限（页数） */
export const MAX_CAPACITY = 1_000;

export const TIE_BREAK_RULE =
  "多个候选的下一次访问同为“不再出现”时，按页标识公开稳定的字典序升序，淘汰其中最小者；" +
  "下一次出现下标更大者优先淘汰（下标越大越晚被再次需要）；" +
  "不使用最近最少使用(LRU)，也不使用最早进入(FIFO)。";

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

/** 参数校验：页标识为非空字符串，容量与长度在公开上限内。 */
export function validateInput(sequence: unknown, capacity: unknown): void {
  if (!Array.isArray(sequence)) {
    throw new ValidationError("SEQUENCE_NOT_ARRAY", "sequence 必须是数组");
  }
  if (sequence.length > MAX_SEQUENCE_LENGTH) {
    throw new ValidationError(
      "SEQUENCE_TOO_LONG",
      `序列长度 ${sequence.length} 超过上限 ${MAX_SEQUENCE_LENGTH}`,
    );
  }
  for (let i = 0; i < sequence.length; i++) {
    const item = sequence[i];
    if (typeof item !== "string" || item.trim() === "") {
      throw new ValidationError(
        "INVALID_PAGE_ID",
        `第 ${i} 项页标识必须是非空字符串（收到 ${String(item)}）`,
      );
    }
  }
  if (
    typeof capacity !== "number" ||
    !Number.isInteger(capacity) ||
    capacity < 0
  ) {
    throw new ValidationError(
      "INVALID_CAPACITY",
      "capacity 必须是非负整数（按页数计）",
    );
  }
  if (capacity > MAX_CAPACITY) {
    throw new ValidationError(
      "CAPACITY_TOO_LARGE",
      `容量 ${capacity} 超过上限 ${MAX_CAPACITY}`,
    );
  }
}

/**
 * 预处理每个位置之后各页的下一次出现下标。
 * nextOccurrenceAt[pos][page] = pos 之后该页第一次出现的下标；无则为 null。
 *
 * 实现方式：从右向左扫描，维护“最近一次看到的位置”。
 */
export function buildNextOccurrenceTable(
  sequence: string[],
): Map<number, Map<string, number>> {
  const table = new Map<number, Map<string, number>>();
  const nearest = new Map<string, number>();
  for (let pos = sequence.length - 1; pos >= 0; pos--) {
    // 快照：位于 pos 处的页不计入“pos 之后”
    table.set(pos, new Map(nearest));
    nearest.set(sequence[pos], pos);
  }
  return table;
}

/**
 * Belady 最优页置换（离线先知）。
 *
 * 规则：
 * 1. 访问的页在缓存中 => 命中，不动结构；
 * 2. 未命中且缓存未满 => 直接装入，缺页；
 * 3. 未命中且缓存已满（含容量 0 的退化情形）=> 缺页，并淘汰
 *    “下一次访问最晚”的页；此后不再出现的页优先级最高；
 *    若多个候选都不再出现，按页标识字典序升序确定唯一被淘汰者。
 */
export function analyzeBelady(
  rawSequence: unknown,
  rawCapacity: unknown,
): AnalysisResult {
  validateInput(rawSequence, rawCapacity);
  const sequence = rawSequence as string[];
  const capacity = rawCapacity as number;

  const nextTable = buildNextOccurrenceTable(sequence);

  const cache = new Set<string>();
  const steps: AnalysisStep[] = [];
  let faults = 0;
  let hits = 0;

  const sortedCache = (): string[] => [...cache].sort();

  for (let pos = 0; pos < sequence.length; pos++) {
    const page = sequence[pos];
    const cacheBefore = sortedCache();
    let evictedPage: string | null = null;
    let candidates: CandidateView[] = [];
    let reason: string;
    let outcome: StepOutcome;

    if (cache.has(page)) {
      hits++;
      outcome = "HIT";
      reason = `命中：页 ${page} 已在缓存中，命中不计缺页，缓存不变。`;
    } else {
      faults++;
      outcome = "FAULT";
      if (cache.size < capacity) {
        cache.add(page);
        reason =
          `缺页：页 ${page} 不在缓存中，缓存未满（${cache.size}/${capacity}），直接装入，无需淘汰。`;
      } else {
        // 缓存已满（capacity === 0 时缓存大小恒为 0，同样走此分支）
        const futureMap = nextTable.get(pos)!;
        const toNext = (candidate: string): NextOccurrence => {
          const idx = futureMap.get(candidate);
          return idx === undefined ? { kind: "never" } : { kind: "future", index: idx };
        };

        candidates = [...cache]
          .map((candidate) => ({ page: candidate, nextOccurrence: toNext(candidate) }))
          .sort(compareCandidates);

        if (capacity === 0) {
          reason =
            `缺页：容量为 0，页 ${page} 无法保留在缓存中，每次访问都缺页。`;
        } else {
          const victim = candidates[0];
          evictedPage = victim.page;
          const victimText = formatNext(victim.nextOccurrence);
          const otherText = candidates
            .slice(1)
            .map((c) => `${c.page}(${formatNext(c.nextOccurrence)})`)
            .join("、");
          reason =
            `缺页且缓存已满：淘汰页 ${evictedPage}，其下一次访问为 ${victimText}，` +
            `晚于（或同属“不再出现”且编号小于）其余候选${otherText ? "：" + otherText : "（无）"}。`;
          cache.delete(evictedPage);
          cache.add(page);
        }
      }
    }

    steps.push({
      index: pos,
      page,
      outcome,
      cacheBefore,
      cacheAfter: sortedCache(),
      evictedPage,
      candidates,
      reason,
    });
  }

  const length = sequence.length;
  const distinctPages = new Set(sequence).size;
  return {
    sequence,
    capacity,
    distinctPages,
    length,
    faults,
    hits,
    hitRate: length === 0 ? null : hits / length,
    faultRate: length === 0 ? null : faults / length,
    steps,
    algorithm: "BELADY_OPT",
    tieBreakRule: TIE_BREAK_RULE,
  };
}

function compareCandidates(a: CandidateView, b: CandidateView): number {
  if (a.nextOccurrence.kind === "never" && b.nextOccurrence.kind === "future") {
    return -1;
  }
  if (a.nextOccurrence.kind === "future" && b.nextOccurrence.kind === "never") {
    return 1;
  }
  if (a.nextOccurrence.kind === "future" && b.nextOccurrence.kind === "future") {
    // 下标越大越晚再次需要，越应被淘汰 -> 排前面（返回 -1）
    if (a.nextOccurrence.index !== b.nextOccurrence.index) {
      return b.nextOccurrence.index - a.nextOccurrence.index;
    }
  }
  // 同为 never，或未来下标相同：按页标识字典序升序，小者淘汰
  return a.page < b.page ? -1 : a.page > b.page ? 1 : 0;
}

/** 用明确中文状态表示“无后续出现”，不使用魔法数字。 */
export function formatNext(next: NextOccurrence): string {
  return next.kind === "never"
    ? "此后不再出现"
    : `下标 ${next.index}`;
}
