import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Repository } from "../src/storage/repository.js";
import { AnalysisService } from "../src/service/service.js";
import { ApiServer } from "../src/api/server.js";

const dbPath = join(tmpdir(), `page-sim-test-${process.pid}-${Date.now()}.sqlite`);
const CLASSIC = ["7", "0", "1", "2", "0", "3", "0", "4", "2", "3", "0", "3", "2"];

// 整个测试文件共享单一连接，避免 WAL 下多连接的可见性/锁问题。
const sharedDb = new DatabaseSync(dbPath);

function freshService() {
  return new AnalysisService(new Repository(sharedDb));
}

describe("服务层 / SQLite 持久化 / HTTP API", () => {
  let sequenceId = 0;

  it("导入 -> 分析 -> 扫描 -> 单步 -> 导出元数据", () => {
    const service = freshService();
    const { sequence } = service.importSequence(CLASSIC, "经典序列");
    sequenceId = sequence.id;

    const stored = service.analyzeStored(sequenceId, 3);
    assert.equal(stored.faults, 7);

    const scan = service.scanCapacities(sequenceId);
    const faultsByCap = scan.map((e) => e.faults);
    for (let i = 1; i < faultsByCap.length; i++) {
      assert.ok(faultsByCap[i] <= faultsByCap[i - 1]);
    }

    const step = service.getStep(sequenceId, 3, 3);
    assert.equal(step.replacement?.evictedPage, "1");
    assert.throws(() => service.getStep(sequenceId, 3, 99), /越界/);
  });

  it("重启后（重新打开同一数据库）仍能查询同一过程", () => {
    const service = freshService();
    const stored = service.listAnalyses(sequenceId).find((a) => a.capacity === 3);
    assert.ok(stored);
    assert.equal(stored?.faults, 7);
    const step = service.getStep(sequenceId, 3, 7);
    assert.equal(step.replacement?.evictedPage, "0");
  });

  it("改动原输入序列会生成新版本，旧版本与旧报告不变", () => {
    const service = freshService();
    const modified = [...CLASSIC, "9"];
    const { sequence: v2 } = service.importSequence(modified, "经典序列-改");
    assert.notEqual(v2.id, sequenceId);

    const oldSeq = service.getSequence(sequenceId);
    assert.deepEqual(oldSeq.pages, CLASSIC);
    assert.equal(service.listAnalyses(sequenceId).find((a) => a.capacity === 3)?.faults, 7);

    // 完全相同内容重复导入：复用快照
    const again = service.importSequence(CLASSIC, "另一个名字");
    assert.equal(again.reused, true);
    assert.equal(again.sequence.id, sequenceId);
  });

  it("历史查询：按名称与页号过滤", () => {
    const service = freshService();
    const byName = service.history({ name: "经典" });
    assert.ok(byName.length >= 2);
    const byPage = service.history({ page: "9" });
    assert.ok(byPage.every((h) => h.sequence.pages.includes("9")));
  });
});

describe("HTTP API 端到端", () => {
  let baseUrl = "";
  let close: () => void = () => {};
  let seqId = 0;

  before(async () => {
    // 整个进程共用同一临时库路径；默认单例可能已指向 data/page-sim.sqlite，
    // 这里显式注入临时数据库，确保 API 与其它测试看到同一版本数据。
    const service = freshService();
    const server = new ApiServer(service);
    const started = await server.start(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${started.port}`;
    close = started.close;
  });

  after(() => {
    close();
    try {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + "-wal", { force: true });
      rmSync(dbPath + "-shm", { force: true });
    } catch {
      // 清理尽力而为
    }
  });

  async function json(path: string, init?: RequestInit) {
    const res = await fetch(baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  it("GET /api/limits 公开上限", async () => {
    const { status, body } = await json("/api/limits");
    assert.equal(status, 200);
    assert.equal(body.limits.MAX_SEQUENCE_LENGTH, 10_000);
  });

  it("导入、分析、单步、扫描、即时分析与错误码", async () => {
    const imported = await json("/api/sequences", {
      method: "POST",
      body: JSON.stringify({ sequence: CLASSIC, name: "api" }),
    });
    assert.equal(imported.status, 200);
    seqId = imported.body.sequence.id;

    const analyzed = await json(`/api/sequences/${seqId}/analyses`, {
      method: "POST",
      body: JSON.stringify({ capacity: 3 }),
    });
    assert.equal(analyzed.body.analysis.faults, 7);

    const step = await json(`/api/sequences/${seqId}/steps/3?capacity=3`);
    assert.equal(step.body.step.replacement.evictedPage, "1");

    const scan = await json(`/api/sequences/${seqId}/scan?from=0&to=3`);
    assert.equal(scan.body.scan.length, 4);

    const adhoc = await json("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ sequence: ["a", "a"], capacity: 1 }),
    });
    assert.equal(adhoc.body.analysis.faults, 1);

    // 相同内容此前已导入为“经典序列”，重复导入复用快照（reused），名称不覆盖。
    // 因此按页号查询历史（而不是依赖新名称）。
    assert.equal(imported.body.reused, true);
    const history = await json("/api/history?page=7");
    assert.ok(history.body.history.length >= 1);

    // 再用全新内容验证按名称检索
    const named = await json("/api/sequences", {
      method: "POST",
      body: JSON.stringify({ sequence: ["p", "q"], name: "唯一名XYZ" }),
    });
    assert.equal(named.body.reused, false);
    const historyByName = await json("/api/history?name=唯一名XYZ");
    assert.ok(historyByName.body.history.length >= 1);

    // 校验错误返回结构化错误码
    const bad = await json("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ sequence: ["a"], capacity: -2 }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_CAPACITY");

    const missing = await json("/api/sequences/99999");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "NOT_FOUND");

    const badJson = await fetch(baseUrl + "/api/sequences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    const badBody = await badJson.json();
    assert.equal(badBody.error.code, "INVALID_PAYLOAD");
  });
});
