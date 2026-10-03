import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core/belady.js";
import { optimalFaultsByEnumeration } from "../src/core/bruteForce.js";

const CLASSIC = ["7", "0", "1", "2", "0", "3", "0", "4", "2", "3", "0", "3", "2"];

describe("Belady 最优置换", () => {
  it("经典序列容量 3：缺页 7 次，淘汰过程正确", () => {
    const r = analyze(CLASSIC, 3);
    assert.equal(r.accesses, 13);
    assert.equal(r.faults, 7);
    assert.equal(r.hits, 6);
    assert.equal(r.hits + r.faults, r.accesses);

    const evictions = r.steps
      .filter((s) => s.replacement?.evictedPage !== null && s.replacement !== null)
      .map((s) => [s.index, s.replacement!.evictedPage] as const);
    assert.deepEqual(
      evictions.filter(([, p]) => p !== null),
      // 下标3：{7,1} 都不再出现，字典序 "1"<"7" -> 淘汰 1；
      // 下标5：页 7 已不再出现（NO_NEXT 优先）-> 淘汰 7，而非淘汰仍会被访问的 2；
      // 下标7：0/2/3 下次出现为 10/8/9 -> 淘汰 0；下标10：4 不再出现 -> 淘汰 4。
      [[3, "1"], [5, "7"], [7, "0"], [10, "4"]],
    );
    assert.equal(evictions.filter(([, p]) => p !== null).length, 4);

    // 下标 7：候选 2/3/0 的下一次出现分别为 8/9/10，淘汰最晚的 0
    const s7 = r.steps[7];
    assert.equal(s7.event, "FAULT");
    assert.equal(s7.replacement?.evictedPage, "0");
    assert.deepEqual(
      s7.replacement?.candidates.map((c) => [c.page, c.nextIndex, c.state]),
      [
        ["0", 10, "HAS_NEXT"],
        ["2", 8, "HAS_NEXT"],
        ["3", 9, "HAS_NEXT"],
      ],
    );
  });

  it("全部相同：任意正容量只缺页一次", () => {
    const r = analyze(["x", "x", "x", "x"], 2);
    assert.equal(r.faults, 1);
    assert.equal(r.hits, 3);
  });

  it("全部不同：缺页数等于访问次数（受容量限制）", () => {
    const r = analyze(["a", "b", "c", "d"], 2);
    assert.equal(r.faults, 4);
    assert.equal(r.hits, 0);
  });

  it("容量 0：每次访问都缺页且不保留页面", () => {
    const r = analyze(["a", "b", "a", "b"], 0);
    assert.equal(r.faults, 4);
    assert.equal(r.hits, 0);
    for (const step of r.steps) {
      assert.deepEqual(step.cacheBefore, []);
      assert.deepEqual(step.cacheAfter, []);
      assert.equal(step.event, "FAULT");
      assert.equal(step.replacement?.evictedPage, null);
    }
  });

  it("容量超过不同页数：缺页数等于不同页数，之后全命中", () => {
    const r = analyze(["a", "b", "a", "c", "b"], 10);
    assert.equal(r.faults, 3);
    assert.equal(r.hits, 2);
  });

  it("重复访问与逐步缓存状态正确", () => {
    const r = analyze(["1", "2", "1", "3", "2"], 2);
    assert.deepEqual(r.steps[0].cacheAfter, ["1"]);
    assert.deepEqual(r.steps[1].cacheAfter, ["1", "2"]);
    assert.equal(r.steps[2].event, "HIT");
    // 下标 3 缺页满：1 下一次出现为 NO_NEXT，2 在下标 4，淘汰 1
    assert.equal(r.steps[3].replacement?.evictedPage, "1");
    const c1 = r.steps[3].replacement?.candidates.find((c) => c.page === "1");
    assert.equal(c1?.state, "NO_NEXT");
    assert.equal(c1?.nextIndex, null);
  });

  it("同分淘汰：多页都不再出现时按稳定字典编号顺序淘汰最小者", () => {
    const r = analyze(["b", "a", "c", "d"], 2);
    // 下标 2 装满 a,b,c? 容量2：下标2缺页满，b、a 都 NO_NEXT -> 淘汰字典序 a
    assert.equal(r.steps[2].replacement?.evictedPage, "a");
    // 下标 3：缓存 {b,c}，均 NO_NEXT -> 淘汰 b
    assert.equal(r.steps[3].replacement?.evictedPage, "b");

    // 数字编号按字符串字典序："1" < "10" < "2"
    const r2 = analyze(["10", "2", "1", "3"], 2);
    // 下标2：候选 {10,2} 均 NO_NEXT -> 字典序 "10" < "2"，淘汰 10
    assert.equal(r2.steps[2].replacement?.evictedPage, "10");
    // 下标3：候选 {1,2} 均 NO_NEXT -> 淘汰 "1"
    assert.equal(r2.steps[3].replacement?.evictedPage, "1");
  });

  it("最后几步：NO_NEXT 页优先于仍会出现的页被淘汰", () => {
    const r = analyze(["a", "b", "c", "a", "d"], 3);
    // 下标 4 缺页满：a 还在当前位之后? a 出现在下标3，之后 NO_NEXT；b、c 也 NO_NEXT。
    // 三者都 NO_NEXT，淘汰字典序最小 a
    assert.equal(r.steps[4].replacement?.evictedPage, "a");

    // 构造：下标4时 b 仍将出现 -> 不应淘汰 b
    const r2 = analyze(["a", "b", "c", "x", "b"], 3);
    assert.notEqual(r2.steps[3].replacement?.evictedPage, "b");
  });

  it("空序列：缺页 0，命中率与缺页率为 null（比例无定义）", () => {
    const r = analyze([], 3);
    assert.equal(r.faults, 0);
    assert.equal(r.hits, 0);
    assert.equal(r.hitRate, null);
    assert.equal(r.faultRate, null);
    assert.deepEqual(r.steps, []);
  });

  it("每一步缓存不超过容量", () => {
    const r = analyze(CLASSIC, 3);
    for (const step of r.steps) {
      assert.ok(step.cacheBefore.length <= 3);
      assert.ok(step.cacheAfter.length <= 3);
    }
    const r0 = analyze(CLASSIC, 0);
    for (const step of r0.steps) assert.equal(step.cacheAfter.length, 0);
  });

  it("容量增加时最优缺页数单调不增，且与递归枚举基准一致", () => {
    const seqs = [
      CLASSIC,
      ["a", "b", "c", "a", "b", "c"],
      ["1", "2", "3", "1", "4", "2"],
    ];
    for (const seq of seqs) {
      let prev = Number.POSITIVE_INFINITY;
      for (let cap = 0; cap <= 5; cap++) {
        const f = analyze(seq, cap).faults;
        assert.ok(f <= prev, `容量 ${cap} 缺页 ${f} 不应大于 ${prev}`);
        const brute = optimalFaultsByEnumeration(seq, Math.min(cap, 4));
        assert.equal(f, cap <= 4 ? brute : f);
        prev = f;
      }
    }
  });

  it("对随机短序列：Belady 缺页数等于全枚举最优值", () => {
    const rng = mulberry(20261003);
    for (let trial = 0; trial < 200; trial++) {
      const len = 1 + Math.floor(rng() * 9);
      const alphabetSize = 1 + Math.floor(rng() * 4);
      const seq = Array.from({ length: len }, () => String(Math.floor(rng() * alphabetSize)));
      const cap = Math.floor(rng() * 4);
      assert.equal(
        analyze(seq, cap).faults,
        optimalFaultsByEnumeration(seq, cap),
        `序列 ${seq.join(",")} 容量 ${cap}`,
      );
    }
  });

  it("参数校验：空页号、负容量、非整数容量被拒绝", () => {
    assert.throws(() => analyze(["a", "  "], 2), /非空/);
    assert.throws(() => analyze(["a"], -1), /非负整数/);
    assert.throws(() => analyze(["a"], 1.5), /非负整数/);
  });
});

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
