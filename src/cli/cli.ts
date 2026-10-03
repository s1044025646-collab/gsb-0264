#!/usr/bin/env node
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  MAX_CAPACITY,
  MAX_SEQUENCE_LENGTH,
  analyzeBelady,
  formatNext,
  ValidationError,
} from "../core/belady.js";
import { optimalFaultsByEnumeration } from "../core/bruteforce.js";
import { scanCapacities } from "../core/scan.js";
import { NotFoundError, Store } from "../db/store.js";
import type { AnalysisResult } from "../core/types.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(join(DATA_DIR, "belady.sqlite"));

function usage(): never {
  console.log(`离线最优页置换（Belady）分析 CLI

用法:
  npm run cli -- --help
  npm run cli -- limits
  npm run cli -- import --pages "7,0,1,2" [--name 经典序列]
  npm run cli -- analyze  --pages "7,0,1,2" --capacity 3 [--json]
  npm run cli -- analyze-db --id <sequenceId> --capacity 3
  npm run cli -- step --analysis <analysisId> --index 3
  npm run cli -- scan --pages "7,0,1,2" --max-capacity 4
  npm run cli -- history [--id <sequenceId>]
  npm run cli -- export --analysis <analysisId> [--out result.json]
  npm run cli -- verify --pages "7,0,1,2" --capacity 3

说明:
  --pages 为逗号分隔的非空页标识；容量单位为页。
  analyze/scan/verify 为无状态即时计算；import/analyze-db/step/history/export 使用 SQLite 持久化。
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const map = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        map.set(key, true);
      } else {
        map.set(key, next);
        i++;
      }
    }
  }
  return map;
}

function parsePages(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") {
    throw new ValidationError("MISSING_PAGES", "需要 --pages 参数，如 --pages \"7,0,1,2\"");
  }
  // 空字符串表示空序列（缺页数为 0，比例无定义）；
  // 非空时允许逗号周围空白，但不允许出现纯空白页标识。
  if (value.trim() === "") return [];
  const pages = value.split(",").map((p) => p.trim());
  if (pages.some((p) => p === "")) {
    throw new ValidationError("INVALID_PAGE_ID", "页标识必须是非空字符串，请检查多余的逗号");
  }
  return pages;
}

function capacityArg(args: Map<string, string | boolean>, key = "capacity"): number {
  const value = args.get(key);
  const num = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(num) || num < 0) {
    throw new ValidationError("INVALID_CAPACITY", `--${key} 必须是非负整数`);
  }
  if (num > MAX_CAPACITY) {
    throw new ValidationError("CAPACITY_TOO_LARGE", `--${key} 上限 ${MAX_CAPACITY}`);
  }
  return num;
}

function printResult(result: AnalysisResult): void {
  console.log(
    `序列: [${result.sequence.join(", ")}]  容量: ${result.capacity}  长度: ${result.length}  不同页数: ${result.distinctPages}`,
  );
  console.log(
    `缺页 ${result.faults} 次，命中 ${result.hits} 次，` +
      `命中率 ${result.hitRate === null ? "无定义（空序列）" : (result.hitRate * 100).toFixed(2) + "%"}`,
  );
  for (const step of result.steps) {
    const tag = step.outcome === "HIT" ? "命中" : "缺页";
    const evict = step.evictedPage ? `，淘汰 ${step.evictedPage}` : "";
    console.log(
      `#${String(step.index).padStart(2, "0")} 访问 ${step.page} [${tag}] ` +
        `前:{[${step.cacheBefore.join(",")}]} -> 后:{[${step.cacheAfter.join(",")}]}${evict}`,
    );
    if (step.candidates.length > 0) {
      console.log(
        "     候选下次出现: " +
          step.candidates
            .map((c) => `${c.page}=${formatNext(c.nextOccurrence)}`)
            .join("，"),
      );
    }
    console.log(`     依据: ${step.reason}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
  }
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case "limits":
      console.log(JSON.stringify({ maxSequenceLength: MAX_SEQUENCE_LENGTH, maxCapacity: MAX_CAPACITY }, null, 2));
      break;

    case "import": {
      const pages = parsePages(args.get("pages"));
      if (pages.length > MAX_SEQUENCE_LENGTH) {
        throw new ValidationError("SEQUENCE_TOO_LONG", `序列长度上限 ${MAX_SEQUENCE_LENGTH}`);
      }
      const name = typeof args.get("name") === "string" ? (args.get("name") as string) : null;
      const row = store.importSequence(pages, name);
      console.log(
        `已导入序列版本 id=${row.id} name=${row.name ?? "(无名)"} version=${row.version} 长度=${row.sequence.length}`,
      );
      break;
    }

    case "analyze": {
      const pages = parsePages(args.get("pages"));
      const capacity = capacityArg(args);
      const result = analyzeBelady(pages, capacity);
      if (args.get("json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printResult(result);
      }
      break;
    }

    case "analyze-db": {
      const id = Number(args.get("id"));
      const capacity = capacityArg(args);
      const row = store.analyze(id, capacity);
      console.log(
        `分析 id=${row.id}（序列 ${row.sequenceId}，容量 ${row.capacity}）：缺页 ${row.faults}，命中 ${row.hits}，命中率 ${
          row.hitRate === null ? "无定义（空序列）" : (row.hitRate * 100).toFixed(2) + "%"
        }`,
      );
      if (args.get("json")) console.log(JSON.stringify(row.result, null, 2));
      break;
    }

    case "step": {
      const analysisId = Number(args.get("analysis"));
      const index = Number(args.get("index"));
      const row = store.getAnalysis(analysisId);
      if (!Number.isInteger(index) || index < 0) {
        throw new ValidationError("INVALID_STEP_INDEX", "--index 必须是非负整数");
      }
      const step = row.result.steps[index];
      if (!step) throw new NotFoundError(`只有 ${row.result.steps.length} 步，下标 ${index} 越界`);
      console.log(JSON.stringify({ analysisId, capacity: row.capacity, step }, null, 2));
      break;
    }

    case "scan": {
      const pages = parsePages(args.get("pages"));
      const maxCapacity = capacityArg(args, "max-capacity");
      const scan = scanCapacities(pages, maxCapacity);
      console.log("容量\t缺页\t命中\t命中率");
      for (const entry of scan.entries) {
        console.log(
          `${entry.capacity}\t${entry.faults}\t${entry.hits}\t${
            entry.hitRate === null ? "无定义" : (entry.hitRate * 100).toFixed(2) + "%"
          }`,
        );
      }
      break;
    }

    case "history": {
      const idRaw = args.get("id");
      const rows = store.listAnalyses(idRaw === undefined ? undefined : Number(idRaw));
      if (rows.length === 0) {
        console.log("（暂无历史分析）");
      }
      for (const row of rows) {
        console.log(
          `analysis=${row.id} sequence=${row.sequenceId} capacity=${row.capacity} faults=${row.faults} hits=${row.hits} created=${row.createdAt}`,
        );
      }
      break;
    }

    case "export": {
      const analysisId = Number(args.get("analysis"));
      const row = store.getAnalysis(analysisId);
      const payload = {
        meta: {
          analysisId: row.id,
          sequenceId: row.sequenceId,
          capacity: row.capacity,
          faults: row.faults,
          hits: row.hits,
          hitRate: row.hitRate,
        },
        result: row.result,
        exportedAt: new Date().toISOString(),
        offlineAssumption:
          "离线先知假设下的最优结果；在线缓存无法预知未来，不能直接达到该性能。",
      };
      const out = args.get("out");
      if (typeof out === "string") {
        writeFileSync(resolve(out), JSON.stringify(payload, null, 2), "utf8");
        console.log(`已导出到 ${resolve(out)}`);
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
      break;
    }

    case "verify": {
      const pages = parsePages(args.get("pages"));
      const capacity = capacityArg(args);
      const result = analyzeBelady(pages, capacity);
      const optimal = optimalFaultsByEnumeration(pages, capacity);
      const ok = result.faults === optimal;
      console.log(
        `Belady 缺页=${result.faults}，枚举最优缺页=${optimal}，${ok ? "一致 ✓" : "不一致 ✗"}`,
      );
      if (!ok) process.exitCode = 1;
      break;
    }

    default:
      console.error(`未知命令: ${command}`);
      usage();
  }
}

main()
  .catch((err: unknown) => {
    const code = err instanceof ValidationError || err instanceof NotFoundError ? err.code : "INTERNAL_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误 [${code}]: ${message}`);
    process.exit(1);
  })
  .finally(() => store.close());
