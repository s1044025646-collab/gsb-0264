import { validateCapacity, validateSequence } from "./validation.js";

/**
 * 独立递归基准：枚举每个缺页且缓存已满时刻“所有合法的淘汰选择”，
 * 返回理论上的最少缺页次数。
 *
 * 与 Belady 实现刻意分开：这里不使用“下一次出现最晚”的启发式结论，
 * 只做朴素的全枚举搜索，用于测试中交叉验证正式算法的最优性。
 * 仅适用于很短的序列（不同页数小、访问步数少）。
 */
export function optimalFaultsByEnumeration(
  rawSequence: unknown,
  rawCapacity: unknown,
): number {
  const sequence = validateSequence(rawSequence);
  const capacity = validateCapacity(rawCapacity);

  if (capacity === 0) return sequence.length;

  const solve = (i: number, cache: Set<string>): number => {
    if (i === sequence.length) return 0;
    const page = sequence[i];
    if (cache.has(page)) {
      return solve(i + 1, cache);
    }
    if (cache.size < capacity) {
      const next = new Set(cache);
      next.add(page);
      return 1 + solve(i + 1, next);
    }
    // 已满：枚举缓存中的每一页作为淘汰对象，取最优分支。
    let best = Number.POSITIVE_INFINITY;
    for (const victim of cache) {
      const next = new Set(cache);
      next.delete(victim);
      next.add(page);
      const branch = solve(i + 1, next);
      if (branch < best) best = branch;
    }
    return 1 + best;
  };

  return solve(0, new Set());
}
