import type { AnalysisResult, StepReport } from "../core/types.js";

/** 空序列比例以“N/A”呈现，避免误读为 0%。 */
export function pct(value: number | null): string {
  return value === null ? "N/A（空序列，比例无定义）" : `${(value * 100).toFixed(2)}%`;
}

export function renderStep(step: StepReport): string {
  const lines: string[] = [];
  lines.push(
    `步骤 #${step.index}  访问页「${step.page}」  结果：${step.event === "HIT" ? "命中 HIT" : "缺页 FAULT"}`,
  );
  lines.push(`  访问前缓存: [${step.cacheBefore.join(", ")}]`);
  lines.push(`  访问后缓存: [${step.cacheAfter.join(", ")}]`);
  if (step.replacement) {
    const evicted = step.replacement.evictedPage === null ? "无" : `「${step.replacement.evictedPage}」`;
    lines.push(`  淘汰页: ${evicted}`);
    if (step.replacement.candidates.length > 0) {
      const detail = step.replacement.candidates
        .map((c) =>
          c.state === "NO_NEXT"
            ? `${c.page}=此后不再出现(NO_NEXT)`
            : `${c.page}=下标${c.nextIndex}`,
        )
        .join("; ");
      lines.push(`  候选下一次出现: ${detail}`);
    }
    lines.push(`  依据: ${step.replacement.reason}`);
  }
  return lines.join("\n");
}

export function renderSummary(result: AnalysisResult): string {
  return [
    `容量=${result.capacity}  访问次数=${result.accesses}  不同页数=${result.distinctPages}`,
    `缺页=${result.faults}  命中=${result.hits}`,
    `缺页率=${pct(result.faultRate)}  命中率=${pct(result.hitRate)}`,
  ].join("\n");
}
