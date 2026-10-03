import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  MAX_CAPACITY,
  MAX_SEQUENCE_LENGTH,
  ValidationError,
  analyzeBelady,
} from "../core/belady.js";
import { optimalFaultsByEnumeration } from "../core/bruteforce.js";
import { scanCapacities } from "../core/scan.js";
import { Store } from "../db/store.js";

const CLASSIC = ["7", "0", "1", "2", "0", "3", "0", "4", "2", "3", "0", "3", "2"];

describe("Belady 最优置换核心", () => {
  it("经典教材序列容量 3：9 次缺页", () => {
    const result = analyzeBelady(CLASSIC, 3);
    // 题目使用教材 20 个引用串的前 13 个：穷举基准确认最优为 7 次缺页
    // （完整 20 引用串的 OPT 为 9 次，二者不要混淆）
    assert.equal(result.faults, 7);
    assert.equal(result.hits, 6);
    assert.equal(result.faults + result.hits, CLASSIC.length);
  });

  it("逐步缓存与淘汰符合下一次出现最晚规则", () => {
    const result = analyzeBelady(CLASSIC, 3);
    // 第 3 步访问 2，缓存 {7,0,1}：7 不再出现，0 在下标 4，1 不再出现
    // 两个 never 按编号字典序："0" 是 future，"1" 与 "7" 为 never，淘汰 "1"
    const step3 = result.steps[3];
    assert.equal(step3.page, "2");
    assert.equal(step3.outcome, "FAULT");
    assert.equal(step3.evictedPage, "1");
    assert.deepEqual(step3.cacheBefore, ["0", "1", "7"]);
    assert.deepEqual(
      step3.candidates.find((c) => c.page === "7")?.nextOccurrence,
      { kind: "never" },
    );
    assert.deepEqual(
      step3.candidates.find((c) => c.page === "0")?.nextOccurrence,
      { kind: "future", index: 4 },
    );

    // 第 5 步访问 3，缓存 {0,2,7}：2 在下标 8，0 在 6，7 不再出现 -> 淘汰 7
    const step5 = result.steps[5];
    assert.equal(step5.evictedPage, "7");

    // 第 7 步访问 4，缓存 {0,2,3}：0 在 10，2 在 8，3 在 9 -> 淘汰最晚的 0?
    // next: 0->10, 2->8, 3->9，最晚是 0（下标 10）
    const step7 = result.steps[7];
    assert.equal(step7.page, "4");
    assert.equal(step7.evictedPage, "0");

    // 第 9 步访问 3 命中（缓存 {2,3,4}）
    assert.equal(result.steps[9].outcome, "HIT");

    // 第 10 步访问 0 缺页：缓存 {2,3,4}，2 在 12，3 在 11，4 不再出现 -> 淘汰 4
    const step10 = result.steps[10];
    assert.equal(step10.page, "0");
    assert.equal(step10.evictedPage, "4");
    assert.deepEqual(
      step10.candidates.find((c) => c.page === "3")?.nextOccurrence,
      { kind: "future", index: 11 },
    );
    // 第 11 步访问 3、第 12 步访问 2 均命中
    assert.equal(result.steps[11].outcome, "HIT");
    assert.equal(result.steps[12].outcome, "HIT");
  });

  it("全部相同：只有第一次缺页，之后全部命中", () => {
    const result = analyzeBelady(["X", "X", "X", "X"], 2);
    assert.equal(result.faults, 1);
    assert.equal(result.hits, 3);
    assert.ok(result.steps.slice(1).every((s) => s.outcome === "HIT"));
  });

  it("全部不同：容量内装入，容量为 k 时前 k 次装入、之后每次淘汰", () => {
    const seq = ["a", "b", "c", "d", "e"];
    const result = analyzeBelady(seq, 2);
    assert.equal(result.faults, 5);
    assert.equal(result.hits, 0);
    assert.deepEqual(result.steps.at(-1)!.cacheAfter, ["d", "e"]);
  });

  it("容量为零：每次访问都缺页且不保留任何页", () => {
    const result = analyzeBelady(["a", "b", "a", "c"], 0);
    assert.equal(result.faults, 4);
    assert.equal(result.hits, 0);
    assert.ok(result.steps.every((s) => s.outcome === "FAULT"));
    assert.ok(result.steps.every((s) => s.cacheAfter.length === 0));
    assert.ok(result.steps.every((s) => s.evictedPage === null));
  });

  it("容量超过不同页数：缺页数等于不同页数", () => {
    const seq = ["a", "b", "a", "c", "b"];
    const result = analyzeBelady(seq, 10);
    assert.equal(result.faults, 3);
    assert.equal(result.hits, 2);
  });

  it("重复访问的命中率正确", () => {
    const result = analyzeBelady(["a", "b", "a", "b", "c"], 2);
    assert.deepEqual(
      result.steps.map((s) => s.outcome),
      ["FAULT", "FAULT", "HIT", "HIT", "FAULT"],
    );
  });

  it("同分（都不再出现）按公开字典序稳定淘汰", () => {
    // 容量 2，a,b 装入；c 到达时 a、b 未来都不再出现 -> 淘汰字典序较小的 a
    const result = analyzeBelady(["b", "a", "c"], 2);
    assert.equal(result.steps[2].evictedPage, "a");
    // 数字标识按字符串字典序："10" < "2"
    const result2 = analyzeBelady(["10", "2", "3"], 2);
    assert.equal(result2.steps[2].evictedPage, "10");
  });

  it("最后几步：最后一次访问之后不再有淘汰误判", () => {
    const seq = ["a", "b", "c", "a"];
    const result = analyzeBelady(seq, 2);
    // 第 2 步 c：a 在 3（将来），b never -> 淘汰 b；第 3 步 a 命中
    assert.equal(result.steps[2].evictedPage, "b");
    assert.equal(result.steps[3].outcome, "HIT");
    const last = result.steps.at(-1)!;
    assert.deepEqual(last.candidates, []);
  });

  it("空序列：缺页 0、命中 0，比例为 null（无定义）而非 0", () => {
    const result = analyzeBelady([], 3);
    assert.equal(result.faults, 0);
    assert.equal(result.hits, 0);
    assert.equal(result.hitRate, null);
    assert.equal(result.faultRate, null);
    assert.deepEqual(result.steps, []);
  });

  it("每一步缓存不超容量，且命中+缺页=访问数", () => {
    for (const capacity of [0, 1, 2, 3, 5]) {
      const result = analyzeBelady(CLASSIC, capacity);
      for (const step of result.steps) {
        assert.ok(step.cacheBefore.length <= capacity);
        assert.ok(step.cacheAfter.length <= capacity);
      }
      assert.equal(result.faults + result.hits, result.length);
    }
  });

  it("命中时缓存内容不变，缺页才可能淘汰", () => {
    const result = analyzeBelady(CLASSIC, 3);
    for (const step of result.steps) {
      if (step.outcome === "HIT") {
        assert.deepEqual(step.cacheBefore, step.cacheAfter);
        assert.equal(step.evictedPage, null);
      }
    }
  });
});

describe("枚举递归基准交叉验证", () => {
  const cases: { seq: string[]; cap: number }[] = [];
  const pool = ["a", "b", "c", "d"];
  const seqs = [
    [],
    ["a"],
    ["a", "a", "a"],
    ["a", "b", "a", "c"],
    ["c", "a", "b", "a", "d"],
    ["a", "b", "c", "d", "a", "b"],
    ["d", "d", "a", "b", "c", "a"],
  ];
  for (const seq of seqs) {
    for (let cap = 0; cap <= 4; cap++) cases.push({ seq, cap });
  }
  void pool;

  for (const { seq, cap } of cases) {
    it(`序列 [${seq.join(",") || "空"}] 容量 ${cap} 达到枚举最优`, () => {
      const belady = analyzeBelady(seq, cap).faults;
      const optimal = optimalFaultsByEnumeration(seq, cap);
      assert.equal(belady, optimal);
    });
  }

  it("随机短序列批量核对（穷举 vs Belady）", () => {
    let seed = 20261003;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let trial = 0; trial < 200; trial++) {
      const length = 1 + Math.floor(rand() * 10);
      const alphabetSize = 1 + Math.floor(rand() * 4);
      const seq = Array.from({ length }, () =>
        String.fromCharCode(97 + Math.floor(rand() * alphabetSize)),
      );
      const cap = Math.floor(rand() * 5);
      assert.equal(
        analyzeBelady(seq, cap).faults,
        optimalFaultsByEnumeration(seq, cap),
        `序列 [${seq.join(",")}] 容量 ${cap}`,
      );
    }
  });
});

describe("容量扫描单调性", () => {
  it("容量增加时最优缺页数单调不增加，命中率单调不减少", () => {
    const scan = scanCapacities(CLASSIC, 6);
    for (let i = 1; i < scan.entries.length; i++) {
      assert.ok(scan.entries[i].faults <= scan.entries[i - 1].faults);
      assert.ok(
        (scan.entries[i].hitRate ?? 1) >= (scan.entries[i - 1].hitRate ?? 1),
      );
    }
    // 容量 >= 不同页数(6)后，缺页数恒为不同页数
    assert.equal(scan.entries[3].faults, 7);
    assert.equal(scan.entries[6].faults, new Set(CLASSIC).size);
  });
});

describe("参数校验错误码", () => {
  it("拒绝非数组序列与空页标识", () => {
    assert.throws(() => analyzeBelady("a,b" as unknown, 1), ValidationError);
    assert.throws(() => analyzeBelady(["a", "  "], 1), (err: Error) =>
      err instanceof ValidationError && err.code === "INVALID_PAGE_ID");
  });

  it("拒绝负容量、非整数容量与超大容量", () => {
    assert.throws(() => analyzeBelady(["a"], -1), (err: Error) =>
      err instanceof ValidationError && err.code === "INVALID_CAPACITY");
    assert.throws(() => analyzeBelady(["a"], 1.5), (err: Error) =>
      err instanceof ValidationError && err.code === "INVALID_CAPACITY");
    assert.throws(
      () => analyzeBelady(["a"], MAX_CAPACITY + 1),
      (err: Error) => err instanceof ValidationError && err.code === "CAPACITY_TOO_LARGE",
    );
  });

  it("拒绝超长序列", () => {
    assert.throws(
      () => analyzeBelady(new Array(MAX_SEQUENCE_LENGTH + 1).fill("a"), 1),
      (err: Error) => err instanceof ValidationError && err.code === "SEQUENCE_TOO_LONG",
    );
  });
});

describe("SQLite 持久化与版本不变性", () => {
  function tempStore(): Store {
    const dir = mkdtempSync(join(tmpdir(), "belady-"));
    return new Store(join(dir, "test.sqlite"));
  }

  it("改动同名序列产生新版本，旧分析报告不变", () => {
    const store = tempStore();
    const v1 = store.importSequence(["a", "b", "c"], "s");
    const analysis1 = store.analyze(v1.id, 1);
    const v2 = store.importSequence(["a", "b"], "s");
    assert.equal(v2.version, 2);
    const replayed = store.getAnalysis(analysis1.id);
    assert.deepEqual(replayed.result.sequence, ["a", "b", "c"]);
    assert.equal(replayed.result.faults, analysis1.faults);
    // 新版本单独分析互不影响
    const analysis2 = store.analyze(v2.id, 1);
    assert.notEqual(analysis2.id, analysis1.id);
    store.close();
  });

  it("分析幂等：重复请求返回同一报告", () => {
    const store = tempStore();
    const seq = store.importSequence(["a", "b", "a"], null);
    const first = store.analyze(seq.id, 1);
    const second = store.analyze(seq.id, 1);
    assert.equal(first.id, second.id);
    store.close();
  });

  it("重启（重新打开同一数据库文件）后可查询同一过程", () => {
    const dir = mkdtempSync(join(tmpdir(), "belady-restart-"));
    const dbFile = join(dir, "test.sqlite");
    const first = new Store(dbFile);
    const seq = first.importSequence(CLASSIC, "classic");
    const analysis = first.analyze(seq.id, 3);
    assert.equal(analysis.faults, 7);
    first.close();

    const reopened = new Store(dbFile);
    const replayedAnalysis = reopened.getAnalysis(analysis.id);
    assert.equal(replayedAnalysis.faults, 7);
    assert.equal(replayedAnalysis.result.steps.length, CLASSIC.length);
    assert.equal(replayedAnalysis.result.steps[7].evictedPage, "0");
    assert.equal(replayedAnalysis.result.steps[10].evictedPage, "4");
    const replayedSeq = reopened.resolveLatest("classic");
    assert.deepEqual(replayedSeq.sequence, CLASSIC);
    reopened.close();
  });
});
