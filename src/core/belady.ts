import { AppError } from "./errors.js";
import type {
  AnalysisResult,
  CandidateNextUse,
  ReplacementDecision,
  StepReport,
} from "./types.js";
import { stablePageOrder, validateCapacity, validateSequence } from "./validation.js";

/**
 * 预处理每个访问位置之后同一页面的下一次出现下标；无后续出现记为 null。
 * nextUse[i] 表示严格位于 i 之后、页号等于 sequence[i] 的最小下标。
 */
export function buildNextUseTable(sequence: string[]): (number | null)[] {
  const nextUse: (number | null)[] = new Array(sequence.length).fill(null);
  const lastSeen = new Map<string, number>();
  for (let i = sequence.length - 1; i >= 0; i--) {
    const page = sequence[i];
    const later = lastSeen.get(page);
    nextUse[i] = later === undefined ? null : later;
    lastSeen.set(page, i);
  }
  return nextUse;
}

/**
 * 建立“页号 -> 该页所有出现下标（升序）”的索引，供二分查找下一次出现。
 */
function buildOccurrenceIndex(sequence: string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < sequence.length; i++) {
    const list = index.get(sequence[i]);
    if (list) list.push(i);
    else index.set(sequence[i], [i]);
  }
  return index;
}

/** 在严格大于 i 的位置中，返回该页第一次出现下标；无则 null。 */
function nextOccurrenceAfter(
  occurrences: Map<string, number[]>,
  page: string,
  i: number,
): number | null {
  const list = occurrences.get(page);
  if (!list) return null;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] <= i) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : null;
}

/**
 * Belady（MIN / OPT）离线最优置换。
 *
 * 规则：缺页且缓存已满时，淘汰“下一次访问位置最晚”的页；
 * 此后不再出现的页优先级最高（视同无限远）；
 * 若多页都不再出现，按公开稳定的字典编号顺序淘汰编号最小者。
 * 注意：这不是 LRU（不看过去），也不是 FIFO（不看进入顺序）。
 */
export function analyze(rawSequence: unknown, rawCapacity: unknown): AnalysisResult {
  const sequence = validateSequence(rawSequence);
  const capacity = validateCapacity(rawCapacity);
  const nextUse = buildNextUseTable(sequence);
  const occurrences = buildOccurrenceIndex(sequence);

  const cache = new Set<string>();
  const steps: StepReport[] = [];
  let faults = 0;
  let hits = 0;

  for (let i = 0; i < sequence.length; i++) {
    const page = sequence[i];
    const cacheBefore = [...cache].sort(stablePageOrder);
    let replacement: ReplacementDecision | null = null;
    let isHit = false;

    if (cache.has(page)) {
      hits++;
      isHit = true;
    } else {
      faults++;
      if (capacity === 0) {
        // 容量为零：每次访问都缺页，且不保留任何页面，也不存在“淘汰”。
        replacement = {
          evictedPage: null,
          candidates: [],
          reason: "缓存容量为 0：发生缺页但不保留页面，无淘汰动作。",
        };
      } else if (cache.size < capacity) {
        // 缓存未满：直接装入，无需淘汰。
        replacement = {
          evictedPage: null,
          candidates: [],
          reason: "缓存尚未占满，直接装入该页，无需淘汰。",
        };
        cache.add(page);
      } else {
        // 缓存已满：枚举各候选页的下一次出现位置。
        const candidates: CandidateNextUse[] = cacheBefore.map((candidate) => {
          const ni = nextOccurrenceAfter(occurrences, candidate, i);
          return {
            page: candidate,
            nextIndex: ni,
            state: ni === null ? ("NO_NEXT" as const) : ("HAS_NEXT" as const),
          };
        });

        const victim = chooseVictim(candidates);
        const noNextCount = candidates.filter((c) => c.state === "NO_NEXT").length;
        cache.delete(victim.page);
        cache.add(page);
        const victimDesc =
          victim.state === "NO_NEXT"
            ? "此后不再出现（视同无限远）"
            : `下一次访问在下标 ${victim.nextIndex}，为所有候选中最晚`;
        replacement = {
          evictedPage: victim.page,
          candidates,
          reason:
            `缓存已满，按 Belady 最优规则淘汰「${victim.page}」：${victimDesc}。` +
            (victim.state === "NO_NEXT" && noNextCount > 1
              ? " 多个候选都不再出现时，按稳定字典编号顺序选取编号最小者。"
              : ""),
        };
      }
    }

    const cacheAfter = [...cache].sort(stablePageOrder);
    steps.push({
      index: i,
      page,
      event: isHit ? "HIT" : "FAULT",
      cacheBefore,
      cacheAfter,
      replacement,
    });
  }

  const accesses = sequence.length;
  return {
    sequence,
    capacity,
    steps,
    faults,
    hits,
    accesses,
    // 空序列比例无定义，显式用 null 表示（不用 0 伪装成“命中率 0%”）。
    hitRate: accesses === 0 ? null : hits / accesses,
    faultRate: accesses === 0 ? null : faults / accesses,
    distinctPages: new Set(sequence).size,
  };
}

/** 选择被淘汰页：NO_NEXT 优先；其次 nextIndex 最大；再按字典编号最小。 */
export function chooseVictim(candidates: CandidateNextUse[]): CandidateNextUse {
  if (candidates.length === 0) {
    throw new AppError("INTERNAL", "无淘汰候选却请求选择淘汰页", 500);
  }
  const sorted = [...candidates].sort((a, b) => {
    if (a.state === "NO_NEXT" && b.state !== "NO_NEXT") return -1;
    if (b.state === "NO_NEXT" && a.state !== "NO_NEXT") return 1;
    if (a.state === "NO_NEXT" && b.state === "NO_NEXT") {
      return stablePageOrder(a.page, b.page);
    }
    // 两个不同页面不可能在同一下标被访问，HAS_NEXT 的 nextIndex 必不同；
    // 仍保留稳定兜底。
    if (b.nextIndex !== a.nextIndex) return (b.nextIndex ?? -1) - (a.nextIndex ?? -1);
    return stablePageOrder(a.page, b.page);
  });
  return sorted[0];
}
