import { analyzeBelady, validateInput } from "./belady.js";
import type { ScanEntry } from "./types.js";

/**
 * 同一序列在容量 0..maxCapacity（含）下的对照扫描。
 * 容量超过不同页数后，缺页数恒等于不同页数。
 */
export function scanCapacities(
  sequence: unknown,
  maxCapacity: unknown,
): { maxCapacity: number; entries: ScanEntry[] } {
  validateInput(sequence, maxCapacity);
  const seq = sequence as string[];
  const cap = maxCapacity as number;
  const entries: ScanEntry[] = [];
  for (let c = 0; c <= cap; c++) {
    const result = analyzeBelady(seq, c);
    entries.push({
      capacity: c,
      faults: result.faults,
      hits: result.hits,
      hitRate: result.hitRate,
    });
  }
  return { maxCapacity: cap, entries };
}
