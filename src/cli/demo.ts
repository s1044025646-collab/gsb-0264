import { analyze } from "../core/belady.js";
import { renderStep, renderSummary } from "./format.js";

/** 经典教学序列与容量 3 的逐步演示，并解释“即将再次出现的页不应被淘汰”。 */
export function runDemo(): void {
  const sequence = ["7", "0", "1", "2", "0", "3", "0", "4", "2", "3", "0", "3", "2"];
  console.log("=== Belady（MIN/OPT）离线最优置换逐步演示 ===");
  console.log(`访问序列: ${sequence.join(", ")}`);
  console.log(`缓存容量: 3（初始为空，0 基下标）\n`);

  const result = analyze(sequence, 3);
  for (const step of result.steps) {
    console.log(renderStep(step));
    console.log("");
  }
  console.log("--- 汇总 ---");
  console.log(renderSummary(result));

  console.log("\n=== 关键解释：为什么“即将再次出现的页”不应被淘汰 ===");
  const explainStep = result.steps[7]; // 下标 7：缺页装入 4，淘汰下一次出现最晚的 0
  console.log(renderStep(explainStep));
  console.log(
    [
      "",
      "说明：在下标 7 缺页装入 4 时，缓存 {0,2,3} 已满。三者的下一次出现为：",
      "页 2 -> 下标 8（紧接着就要用）、页 3 -> 下标 9、页 0 -> 下标 10（最晚）。",
      "Belady 淘汰下一次出现最晚的 0。",
      "特别地，页 2“即将再次出现”（下标 8），它的下一次出现下标最小，",
      "如果此时淘汰 2，下一步访问 2 会立即产生一次本可避免的缺页，",
      "因此最优规则绝不会淘汰即将再次使用的页。",
      "这正是离线先知：算法必须看到完整未来序列；任何在线策略都无法保证达到该结果。",
    ].join("\n"),
  );
}
