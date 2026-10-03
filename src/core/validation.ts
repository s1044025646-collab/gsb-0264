import { AppError } from "./errors.js";
import { LIMITS } from "./types.js";

/**
 * 校验并规范化页面访问序列。
 * 页面必须是非空字符串（数字会被转为字符串），trim 后不能为空，长度受限。
 */
export function validateSequence(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new AppError("INVALID_SEQUENCE", "sequence 必须是字符串数组");
  }
  if (input.length > LIMITS.MAX_SEQUENCE_LENGTH) {
    throw new AppError(
      "SEQUENCE_TOO_LONG",
      `序列长度 ${input.length} 超过上限 ${LIMITS.MAX_SEQUENCE_LENGTH}`,
      400,
      { limit: LIMITS.MAX_SEQUENCE_LENGTH },
    );
  }
  return input.map((raw, i) => {
    const label = typeof raw === "number" ? String(raw) : raw;
    if (typeof label !== "string") {
      throw new AppError("PAGE_LABEL_INVALID", `第 ${i} 个页号不是字符串`);
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      throw new AppError("PAGE_LABEL_INVALID", `第 ${i} 个页号为空字符串，页号必须非空`);
    }
    if (trimmed.length > LIMITS.MAX_PAGE_LABEL_LENGTH) {
      throw new AppError(
        "PAGE_LABEL_INVALID",
        `第 ${i} 个页号长度 ${trimmed.length} 超过上限 ${LIMITS.MAX_PAGE_LABEL_LENGTH}`,
      );
    }
    return trimmed;
  });
}

/** 校验容量：必须是 0 到 MAX_CAPACITY 之间的整数。 */
export function validateCapacity(input: unknown): number {
  if (typeof input === "string" && input.trim() !== "" && Number.isInteger(Number(input.trim()))) {
    input = Number(input.trim());
  }
  if (typeof input !== "number" || !Number.isInteger(input)) {
    throw new AppError("INVALID_CAPACITY", "capacity 必须是非负整数");
  }
  if (input < 0) {
    throw new AppError("INVALID_CAPACITY", "capacity 必须是非负整数，不能为负数");
  }
  if (input > LIMITS.MAX_CAPACITY) {
    throw new AppError(
      "CAPACITY_TOO_LARGE",
      `容量 ${input} 超过上限 ${LIMITS.MAX_CAPACITY}`,
      400,
      { limit: LIMITS.MAX_CAPACITY },
    );
  }
  return input;
}

/** 公开稳定的编号顺序：字典序（按代码点比较，保证跨平台一致）。 */
export function stablePageOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
