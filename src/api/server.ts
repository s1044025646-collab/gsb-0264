import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { AppError } from "../core/errors.js";
import { LIMITS } from "../core/types.js";
import { AnalysisService } from "../service/service.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    params: Record<string, string>,
    query: URLSearchParams,
  ) => unknown;
}

function route(
  method: string,
  path: string,
  handler: Route["handler"],
): Route {
  const paramNames: string[] = [];
  const patternSource = path
    .replace(/:([A-Za-z]+)/g, (_m, name) => {
      paramNames.push(name);
      return "([^/]+)";
    })
    .replace(/\//g, "\\/");
  return { method, pattern: new RegExp(`^${patternSource}$`), paramNames, handler };
}

export class ApiServer {
  private server: Server | null = null;
  constructor(private readonly service: AnalysisService = new AnalysisService()) {}

  private routes: Route[] = [
    route("GET", "/api/limits", () => ({ limits: LIMITS })),
    route("POST", "/api/sequences", (_req, _res, body) => {
      const b = body as { sequence?: unknown; name?: unknown };
      const result = this.service.importSequence(b?.sequence, b?.name);
      return { sequence: result.sequence, reused: result.reused };
    }),
    route("GET", "/api/sequences", (_req, _res, _b, _p, query) => {
      const limit = Number(query.get("limit") ?? 100);
      const offset = Number(query.get("offset") ?? 0);
      return { sequences: this.service.listSequences(limit, offset) };
    }),
    route("GET", "/api/sequences/:id", (_req, _res, _b, params) => ({
      sequence: this.service.getSequence(Number(params.id)),
    })),
    route("POST", "/api/sequences/:id/analyses", (_req, _res, body, params) => {
      const b = body as { capacity?: unknown };
      const stored = this.service.analyzeStored(Number(params.id), b?.capacity);
      return { analysis: stored };
    }),
    route("GET", "/api/sequences/:id/analyses", (_req, _res, _b, params) => ({
      analyses: this.service.listAnalyses(Number(params.id)),
    })),
    route("GET", "/api/sequences/:id/steps/:step", (_req, _res, _b, params, query) => ({
      step: this.service.getStep(
        Number(params.id),
        query.get("capacity"),
        params.step,
      ),
    })),
    route("GET", "/api/sequences/:id/scan", (_req, _res, _b, params, query) => ({
      sequenceId: Number(params.id),
      scan: this.service.scanCapacities(
        Number(params.id),
        query.get("to") ?? undefined,
        query.get("from") ?? undefined,
      ),
    })),
    route("POST", "/api/analyze", (_req, _res, body) => {
      const b = body as { sequence?: unknown; capacity?: unknown };
      return { analysis: this.service.analyzeAdhoc(b?.sequence, b?.capacity) };
    }),
    route("GET", "/api/history", (_req, _res, _b, _p, query) => ({
      history: this.service.history({
        name: query.get("name") ?? undefined,
        page: query.get("page") ?? undefined,
        limit: Number(query.get("limit") ?? 50),
      }),
    })),
    route("POST", "/api/sequences/:id/export", (_req, _res, body, params) => {
      const b = body as { capacity?: unknown; output?: unknown };
      const output = typeof b?.output === "string" && b.output.trim() ? b.output : "export.json";
      const path = this.service.exportAnalysis(Number(params.id), b?.capacity, output);
      return { exportedTo: path };
    }),
  ];

  private async readJson(req: IncomingMessage): Promise<unknown> {
    if (req.method === "GET") return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > 5 * 1024 * 1024) {
        throw new AppError("INVALID_PAYLOAD", "请求体超过 5MB 上限", 413);
      }
      chunks.push(buf);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("INVALID_PAYLOAD", "请求体不是合法 JSON");
    }
  }

  start(port: number = 0, host = "127.0.0.1"): Promise<{ port: number; close: () => void }> {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const body = await this.readJson(req);

        if (url.pathname === "/" || url.pathname === "/health") {
          this.sendJson(res, 200, {
            service: "offline-page-replacement",
            assumption: "离线先知（Belady MIN），结果不代表在线缓存性能",
          });
          return;
        }

        for (const r of this.routes) {
          if (r.method !== req.method) continue;
          const match = r.pattern.exec(url.pathname);
          if (!match) continue;
          const params: Record<string, string> = {};
          r.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1])));
          const data = await r.handler(req, res, body, params, url.searchParams);
          if (!res.writableEnded) this.sendJson(res, 200, data);
          return;
        }
        throw new AppError("NOT_FOUND", `路由不存在：${req.method} ${url.pathname}`, 404);
      } catch (err) {
        this.sendError(res, err);
      }
    });

    return new Promise((resolve) => {
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo;
        this.server = server;
        resolve({
          port: address.port,
          close: () => server.close(),
        });
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof AppError) {
      this.sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.sendJson(res, 500, { error: { code: "INTERNAL", message } });
  }
}
