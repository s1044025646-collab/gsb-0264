import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  MAX_CAPACITY,
  MAX_SEQUENCE_LENGTH,
  ValidationError,
} from "../core/belady.js";
import { BruteForceLimitError } from "../core/bruteforce.js";
import { scanCapacities } from "../core/scan.js";
import { NotFoundError, Store } from "../db/store.js";

const DATA_DIR = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
mkdirSync(DATA_DIR, { recursive: true });
export const store = new Store(join(DATA_DIR, "belady.sqlite"));

interface JsonOut {
  status: number;
  body: unknown;
}

function errorBody(code: string, message: string): JsonOut {
  return { status: errorStatus(code), body: { error: { code, message } } };
}

function errorStatus(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "VALIDATION" || code.includes("INVALID") || code.includes("TOO_")) {
    return 400;
  }
  if (code === "NOT_FOUND_ERROR") return 404;
  return 400;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

function send(res: ServerResponse, out: JsonOut): void {
  const text = JSON.stringify(out.body, null, 2);
  res.writeHead(out.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: RouteContext) => Promise<JsonOut> | JsonOut;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const regex = new RegExp(
    "^" +
      pattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern: regex, keys, handler });
}

route("GET", "/health", () => ({
  status: 200,
  body: {
    ok: true,
    service: "offline-belady-service",
    limits: { maxSequenceLength: MAX_SEQUENCE_LENGTH, maxCapacity: MAX_CAPACITY },
  },
}));

route("GET", "/limits", () => ({
  status: 200,
  body: { maxSequenceLength: MAX_SEQUENCE_LENGTH, maxCapacity: MAX_CAPACITY },
}));

route("POST", "/sequences", async ({ req }) => {
  const body = (await readJson(req)) as {
    sequence?: unknown;
    name?: unknown;
  };
  if (!Array.isArray(body.sequence)) {
    throw new ValidationError("SEQUENCE_NOT_ARRAY", "需要字段 sequence: string[]");
  }
  const name =
    body.name === undefined || body.name === null
      ? null
      : typeof body.name === "string" && body.name.trim() !== ""
        ? body.name
        : (() => {
            throw new ValidationError("INVALID_NAME", "name 必须是非空字符串或省略");
          })();
  // 提前做完整校验（含页标识与长度上限）
  validateSequenceArray(body.sequence);
  const row = store.importSequence(body.sequence, name);
  return {
    status: 201,
    body: {
      id: row.id,
      name: row.name,
      version: row.version,
      sequence: row.sequence,
      length: row.sequence.length,
      createdAt: row.createdAt,
    },
  };
});

function validateSequenceArray(sequence: unknown): asserts sequence is string[] {
  if (!Array.isArray(sequence) || sequence.length > MAX_SEQUENCE_LENGTH) {
    throw new ValidationError(
      "SEQUENCE_TOO_LONG",
      `sequence 必须是数组且长度不超过 ${MAX_SEQUENCE_LENGTH}`,
    );
  }
  sequence.forEach((item, i) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ValidationError(
        "INVALID_PAGE_ID",
        `第 ${i} 项页标识必须是非空字符串`,
      );
    }
  });
}

route("GET", "/sequences", () => ({
  status: 200,
  body: {
    sequences: store.listSequences(),
  },
}));

route("GET", "/sequences/:id", ({ params }) => {
  const row = store.getSequence(Number(params.id));
  return {
    status: 200,
    body: {
      id: row.id,
      name: row.name,
      version: row.version,
      sequence: row.sequence,
      length: row.sequence.length,
      createdAt: row.createdAt,
    },
  };
});

route("POST", "/sequences/:id/analyze", async ({ req, params }) => {
  const body = (await readJson(req)) as { capacity?: unknown };
  const capacity = parseCapacity(body.capacity);
  const row = store.analyze(Number(params.id), capacity);
  return { status: 200, body: row.result };
});

route("GET", "/sequences/:id/analyses", ({ params }) => ({
  status: 200,
  body: { analyses: store.listAnalyses(Number(params.id)).map(summary) },
}));

route("GET", "/analyses/:analysisId", ({ params }) => {
  const row = store.getAnalysis(Number(params.analysisId));
  return { status: 200, body: { ...summary(row), result: row.result } };
});

route("GET", "/analyses/:analysisId/steps/:stepIndex", ({ params }) => {
  const row = store.getAnalysis(Number(params.analysisId));
  const stepIndex = Number(params.stepIndex);
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new ValidationError("INVALID_STEP_INDEX", "stepIndex 必须是非负整数");
  }
  const step = row.result.steps[stepIndex];
  if (!step) {
    throw new NotFoundError(
      `分析 ${row.id} 只有 ${row.result.steps.length} 步，下标 ${stepIndex} 越界`,
    );
  }
  return {
    status: 200,
    body: { analysisId: row.id, capacity: row.capacity, step },
  };
});

route("POST", "/sequences/:id/scan", async ({ req, params }) => {
  const sequenceId = Number(params.id);
  const seq = store.getSequence(sequenceId).sequence;
  const body = (await readJson(req)) as { maxCapacity?: unknown };
  const maxCapacity = parseCapacity(body.maxCapacity);
  const scan = scanCapacities(seq, maxCapacity);
  return {
    status: 200,
    body: { sequenceId, ...scan, note: "容量增加时最优缺页数单调不增加" },
  };
});

route("GET", "/history", ({ url }) => {
  const rawId = url.searchParams.get("sequenceId");
  const analyses = store
    .listAnalyses(rawId === null ? undefined : Number(rawId))
    .map(summary);
  return { status: 200, body: { analyses } };
});

route("GET", "/export/:analysisId", ({ params }) => {
  const row = store.getAnalysis(Number(params.analysisId));
  return {
    status: 200,
    body: {
      meta: summary(row),
      result: row.result,
      exportedAt: new Date().toISOString(),
      offlineAssumption:
        "本结果基于离线先知假设：分析时已知完整未来访问序列。真实在线缓存无法提前知道未来，不能直接达到该性能。",
    },
  };
});

function summary(row: ReturnType<Store["listAnalyses"]>[number]) {
  return {
    analysisId: row.id,
    sequenceId: row.sequenceId,
    capacity: row.capacity,
    faults: row.faults,
    hits: row.hits,
    hitRate: row.hitRate,
    createdAt: row.createdAt,
  };
}

function parseCapacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ValidationError("INVALID_CAPACITY", "capacity 必须是非负整数");
  }
  if (value > MAX_CAPACITY) {
    throw new ValidationError("CAPACITY_TOO_LARGE", `capacity 上限为 ${MAX_CAPACITY}`);
  }
  return value;
}

export const app = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue;
      const match = candidate.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      candidate.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      const out = await candidate.handler({ req, res, url, params });
      send(res, out);
      return;
    }
    send(res, {
      status: 404,
      body: { error: { code: "ROUTE_NOT_FOUND", message: `${req.method} ${url.pathname} 不存在` } },
    });
  } catch (err) {
    const out = mapError(err);
    send(res, out);
  }
});

function mapError(err: unknown): JsonOut {
  if (err instanceof ValidationError || err instanceof NotFoundError) {
    return errorBody(err.code, err.message);
  }
  if (err instanceof BruteForceLimitError) {
    return errorBody(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message } } };
}

/** 请求系统分配一个空闲 TCP 端口。 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function listen(server: Server): Promise<number> {
  const requested = process.env.PORT;
  const port = requested ? Number(requested) : await pickFreePort();
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual =
        typeof address === "object" && address ? address.port : port;
      console.log(`[belady] HTTP API 已启动: http://127.0.0.1:${actual}`);
      console.log(`[belady] 数据目录: ${DATA_DIR}`);
      console.log("[belady] 按 Ctrl+C 停止");
      resolvePort(actual);
    });
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith("server.js");
if (isMain) {
  listen(app).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
