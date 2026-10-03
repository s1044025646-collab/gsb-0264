import { writeFileSync } from "node:fs";
import { analyze } from "../core/belady.js";
import { AppError } from "../core/errors.js";
import type { AnalysisResult, StepReport } from "../core/types.js";
import { LIMITS } from "../core/types.js";
import { validateCapacity, validateSequence } from "../core/validation.js";
import { Repository } from "../storage/repository.js";

export interface ScanEntry {
  capacity: number;
  faults: number;
  hits: number;
  hitRate: number | null;
  faultRate: number | null;
}

export class AnalysisService {
  constructor(private readonly repo: Repository = new Repository()) {}

  importSequence(rawSequence: unknown, name?: unknown) {
    const pages = validateSequence(rawSequence);
    const label = typeof name === "string" && name.trim() ? name.trim() : null;
    return this.repo.importSequence(pages, label);
  }

  /** 对已存储的序列版本做分析并持久化；旧版本内容不可变。 */
  analyzeStored(sequenceId: number, rawCapacity: unknown) {
    const capacity = validateCapacity(rawCapacity);
    const sequence = this.repo.getSequence(sequenceId);
    const result = analyze(sequence.pages, capacity);
    return this.repo.saveAnalysis(sequenceId, result);
  }

  /** 不落库的即时分析（用于直接提交序列的场景）。 */
  analyzeAdhoc(rawSequence: unknown, rawCapacity: unknown): AnalysisResult {
    return analyze(rawSequence, rawCapacity);
  }

  getStep(sequenceId: number, rawCapacity: unknown, rawStep: unknown): StepReport {
    const capacity = validateCapacity(rawCapacity);
    const stored = this.repo.getAnalysis(sequenceId, capacity);
    const step =
      typeof rawStep === "string" && rawStep.trim() !== ""
        ? Number(rawStep)
        : (rawStep as number);
    if (!Number.isInteger(step)) {
      throw new AppError("INVALID_QUERY", "step 必须是整数下标");
    }
    if (step < 0 || step >= stored.result.steps.length) {
      throw new AppError(
        "STEP_OUT_OF_RANGE",
        `步骤下标 ${step} 越界：该分析共 ${stored.result.steps.length} 步（0 基）`,
        404,
        { step, stepCount: stored.result.steps.length },
      );
    }
    return stored.result.steps[step];
  }

  /**
   * 同一序列在多个容量下的对照扫描。
   * 容量大于不同页数时缺页恒为不同页数；扫描默认覆盖 0..不同页数（封顶 MAX_CAPACITY）。
   */
  scanCapacities(sequenceId: number, rawTo?: unknown, rawFrom?: unknown): ScanEntry[] {
    const sequence = this.repo.getSequence(sequenceId);
    const distinct = new Set(sequence.pages).size;
    const upperBound = Math.min(distinct, LIMITS.MAX_CAPACITY);
    const from = rawFrom === undefined ? 0 : validateCapacity(rawFrom);
    const requestedTo = rawTo === undefined ? upperBound : validateCapacity(rawTo);
    const to = Math.min(requestedTo, LIMITS.MAX_CAPACITY);
    if (from > to) {
      throw new AppError("INVALID_QUERY", `容量范围非法：from=${from} 大于 to=${to}`);
    }

    const entries: ScanEntry[] = [];
    for (let capacity = from; capacity <= to; capacity++) {
      const result = analyze(sequence.pages, capacity);
      this.repo.saveAnalysis(sequenceId, result);
      entries.push({
        capacity,
        faults: result.faults,
        hits: result.hits,
        hitRate: result.hitRate,
        faultRate: result.faultRate,
      });
    }
    return entries;
  }

  listSequences(limit?: number, offset?: number) {
    return this.repo.listSequences(limit, offset);
  }

  getSequence(sequenceId: number) {
    return this.repo.getSequence(sequenceId);
  }

  listAnalyses(sequenceId: number) {
    return this.repo.listAnalyses(sequenceId);
  }

  history(query: { name?: string; page?: string; limit?: number }) {
    return this.repo.queryHistory(query);
  }

  /** 导出某序列某容量的完整分析为 JSON 文件。 */
  exportAnalysis(sequenceId: number, rawCapacity: unknown, outputPath: string): string {
    const capacity = validateCapacity(rawCapacity);
    const sequence = this.repo.getSequence(sequenceId);
    const stored = this.repo.getAnalysis(sequenceId, capacity);
    const payload = {
      exportedAt: new Date().toISOString(),
      note: "离线 Belady(MIN) 最优置换分析；基于先知完整序列，不代表在线策略可达性能。",
      sequence,
      analysis: {
        capacity,
        faults: stored.result.faults,
        hits: stored.result.hits,
        hitRate: stored.result.hitRate,
        faultRate: stored.result.faultRate,
        steps: stored.result.steps,
      },
    };
    writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
    return outputPath;
  }
}
