import { analyzeBelady, formatNext } from "./core/belady.js";
import { scanCapacities } from "./core/scan.js";
import { optimalFaultsByEnumeration } from "./core/bruteforce.js";

/**
 * 经典教学序列（Silberschatz 教材示例）：
 * 7,0,1,2,0,3,0,4,2,3,0,3,2，缓存容量 3。
 */
const CLASSIC = ["7", "0", "1", "2", "0", "3", "0", "4", "2", "3", "0", "3", "2"];
const CAPACITY = 3;

function line(title: string): void {
  console.log("=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

line("演示一：经典序列 7,0,1,2,0,3,0,4,2,3,0,3,2，容量 3 的逐步淘汰");
const result = analyzeBelady(CLASSIC, CAPACITY);
for (const step of result.steps) {
  const tag = step.outcome === "HIT" ? "命中" : "缺页";
  const evict = step.evictedPage ? `  淘汰=>${step.evictedPage}` : "";
  console.log(
    `#${String(step.index).padStart(2, "0")} 访问 ${step.page} [${tag}] ` +
      `缓存前 [${step.cacheBefore.join(",") || "空"}] -> 缓存后 [${step.cacheAfter.join(",")}]${evict}`,
  );
  if (step.candidates.length > 0) {
    console.log(
      "      各候选下一次出现: " +
        step.candidates
          .map((c) => `${c.page}: ${formatNext(c.nextOccurrence)}`)
          .join(" | "),
    );
  }
  console.log(`      依据: ${step.reason}`);
}
console.log(
  `\n合计：缺页 ${result.faults} 次，命中 ${result.hits} 次，` +
    `命中率 ${(result.hitRate! * 100).toFixed(2)}%（穷举基准确认最优缺页=${optimalFaultsByEnumeration(CLASSIC, CAPACITY)}）`,
);
console.log(
  "注：教材常引用的“OPT 9 次缺页”对应完整 20 个引用串（末尾还有 1,2,0,1,7,0,1）；",
);
console.log("    本题演示的是其前 13 个引用，最优为 7 次。");

line("演示二：为什么“即将再次出现”的页不能被淘汰");
{
  const seq2 = ["A", "B", "C", "A", "D", "A", "B", "C"];
  const demo2 = analyzeBelady(seq2, 3);
  const critical = demo2.steps[4]; // 访问 D，缓存 {A,B,C} 已满
  console.log(`序列: ${seq2.join(",")}，容量 3`);
  console.log(
    `在第 ${critical.index} 步访问 ${critical.page} 时缺页且缓存已满，候选情况：`,
  );
  for (const candidate of critical.candidates) {
    console.log(`  - 页 ${candidate.page}：${formatNext(candidate.nextOccurrence)}`);
  }
  console.log(`=> 淘汰 ${critical.evictedPage}，保留紧接着第 5 步就要再次访问的页 A。`);
  console.log(`   ${critical.reason}`);
  console.log(
    "如果误淘汰 A，下一次访问 A 立即产生额外缺页；离线先知正是利用完整未来信息避免这种损失。",
  );
}

line("演示三：同一序列多种容量对照");
const scan = scanCapacities(CLASSIC, 4);
console.table(
  scan.entries.map((e) => ({
    容量: e.capacity,
    缺页数: e.faults,
    命中数: e.hits,
    命中率: e.hitRate === null ? "无定义" : `${(e.hitRate * 100).toFixed(2)}%`,
  })),
);

line("演示四：枚举基准核对（短序列递归穷举所有合法淘汰选择）");
{
  const short = ["A", "B", "C", "A", "B", "D", "A", "D"];
  for (const capacity of [0, 1, 2, 3, 4]) {
    const belady = analyzeBelady(short, capacity).faults;
    const optimal = optimalFaultsByEnumeration(short, capacity);
    console.log(
      `容量 ${capacity}: Belady=${belady}，枚举最优=${optimal}，${belady === optimal ? "一致" : "不一致！"}`,
    );
  }
}

console.log("\n提示：以上为离线先知分析，不代表 LRU/FIFO 等在线策略可达性能。");
