import { TIE_BREAK_RULE, validateInput } from "./belady.js";

/** 允许对序列做穷举枚举的长度上限（指数复杂度，仅供测试基准） */
export const BRUTEFORCE_MAX_LENGTH = 14;

export class BruteForceLimitError extends Error {
  code = "BRUTEFORCE_TOO_LONG";
  constructor(length: number) {
    super(
      `序列长度 ${length} 超出枚举基准上限 ${BRUTEFORCE_MAX_LENGTH}，` +
        "枚举所有淘汰选择是指数级操作，仅允许短序列使用。",
    );
    this.name = "BruteForceLimitError";
  }
}

/**
 * 独立递归基准：枚举每一步所有“合法的淘汰选择”，求最少缺页数。
 *
 * 与 Belady 实现刻意分开书写：这里不使用“下一次出现最晚”规则，
 * 而是在每次满缓存缺页时尝试逐出缓存中的每一个页，
 * 递归走完整个序列后取全局最小缺页数。
 *
 * @returns 最少可能缺页数
 */
export function optimalFaultsByEnumeration(
  rawSequence: unknown,
  rawCapacity: unknown,
): number {
  validateInput(rawSequence, rawCapacity);
  const sequence = rawSequence as string[];
  const capacity = rawCapacity as number;
  if (sequence.length > BRUTEFORCE_MAX_LENGTH) {
    throw new BruteForceLimitError(sequence.length);
  }

  const run = (pos: number, cache: Set<string>, faultsSoFar: number): number => {
    if (pos === sequence.length) {
      return faultsSoFar;
    }
    const page = sequence[pos];
    if (cache.has(page)) {
      return run(pos + 1, cache, faultsSoFar);
    }
    const next = new Set(cache);
    if (next.size < capacity) {
      next.add(page);
      return run(pos + 1, next, faultsSoFar + 1);
    }
    if (capacity === 0) {
      // 无法保留：缺页且缓存仍为空
      return run(pos + 1, next, faultsSoFar + 1);
    }
    // 满缓存缺页：枚举每一个候选淘汰选择，取最优
    let best = Infinity;
    for (const victim of next) {
      const branch = new Set(next);
      branch.delete(victim);
      branch.add(page);
      best = Math.min(best, run(pos + 1, branch, faultsSoFar + 1));
    }
    return best;
  };

  return run(0, new Set<string>(), 0);
}

export { TIE_BREAK_RULE };
