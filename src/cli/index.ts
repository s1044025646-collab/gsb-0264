#!/usr/bin/env node
import { resolve } from "node:path";
import { AppError } from "../core/errors.js";
import { AnalysisService } from "../service/service.js";
import { ApiServer } from "../api/server.js";
import { renderStep, renderSummary } from "./format.js";
import { runDemo } from "./demo.js";

function parsePages(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): string {
  return `离线最优页置换（Belady MIN）分析 CLI

用法:
  page-sim serve [--port 8080] [--host 127.0.0.1]   启动 HTTP API（默认端口 0 = 自动选择空闲端口）
  page-sim demo                                     经典序列 7,0,1,2,0,3,0,4,2,3,0,3,2 / 容量3 逐步演示
  page-sim import --pages "7,0,1,..." [--name 名称]  导入序列（生成不可变版本快照）
  page-sim analyze --id <版本ID> --capacity <n>      对已导入序列做某容量分析并持久化
  page-sim analyze-once --pages "..." --capacity <n> 即时分析（不落库），打印逐步过程
  page-sim step --id <ID> --capacity <n> --step <i>  查看某一步（0 基）
  page-sim scan --id <ID> [--from 0] [--to n]        多容量对照扫描
  page-sim history [--name 关键字] [--page 页号]     历史查询
  page-sim export --id <ID> --capacity <n> --out f   导出完整分析为 JSON 文件

环境变量:
  PAGE_SIM_DB   SQLite 数据库路径（默认 data/page-sim.sqlite，位于项目内数据目录）

页号用逗号或空格分隔；页号为非空字符串。空序列的命中率/缺页率为 N/A（比例无定义）。
`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const service = new AnalysisService();

  switch (command) {
    case "demo":
      runDemo();
      return;

    case "serve": {
      const port = Number(flag(args, "--port") ?? process.env.PORT ?? 0);
      const host = flag(args, "--host") ?? "127.0.0.1";
      const server = new ApiServer(service);
      const started = await server.start(Number.isFinite(port) ? port : 0, host);
      console.log(`HTTP API 已启动: http://${host}:${started.port}`);
      console.log("健康检查: GET /health   限制: GET /api/limits   历史: GET /api/history");
      return;
    }

    case "import": {
      const pages = parsePages(flag(args, "--pages") ?? "");
      const { sequence, reused } = service.importSequence(pages, flag(args, "--name"));
      console.log(`${reused ? "相同内容已存在，复用版本" : "已导入新版本"} #${sequence.id}`);
      console.log(`长度=${sequence.length} sha256=${sequence.contentSha256}`);
      return;
    }

    case "analyze": {
      const id = Number(flag(args, "--id"));
      const capacity = Number(flag(args, "--capacity"));
      const stored = service.analyzeStored(id, capacity);
      console.log(renderSummary(stored.result));
      console.log(`(已持久化：序列版本 ${id}，容量 ${capacity})`);
      return;
    }

    case "analyze-once": {
      const pages = parsePages(flag(args, "--pages") ?? "");
      const capacity = Number(flag(args, "--capacity"));
      const result = service.analyzeAdhoc(pages, capacity);
      result.steps.forEach((s) => console.log(renderStep(s) + "\n"));
      console.log(renderSummary(result));
      return;
    }

    case "step": {
      const id = Number(flag(args, "--id"));
      const capacity = Number(flag(args, "--capacity"));
      const step = Number(flag(args, "--step"));
      console.log(renderStep(service.getStep(id, capacity, step)));
      return;
    }

    case "scan": {
      const id = Number(flag(args, "--id"));
      const scan = service.scanCapacities(
        id,
        flag(args, "--to"),
        flag(args, "--from"),
      );
      console.log("容量\t缺页\t命中\t命中率\t\t缺页率");
      for (const e of scan) {
        const hr = e.hitRate === null ? "N/A" : (e.hitRate * 100).toFixed(2) + "%";
        const fr = e.faultRate === null ? "N/A" : (e.faultRate * 100).toFixed(2) + "%";
        console.log(`${e.capacity}\t${e.faults}\t${e.hits}\t${hr}\t${fr}`);
      }
      return;
    }

    case "history": {
      const history = service.history({
        name: flag(args, "--name"),
        page: flag(args, "--page"),
      });
      if (history.length === 0) {
        console.log("（无历史记录）");
        return;
      }
      for (const { sequence, analyses } of history) {
        console.log(
          `版本#${sequence.id} 名称=${sequence.name ?? "-"} 长度=${sequence.length} ` +
            `sha256=${sequence.contentSha256.slice(0, 12)} 创建=${sequence.createdAt}`,
        );
        for (const a of analyses) {
          const hr = a.hitRate === null ? "N/A" : (a.hitRate * 100).toFixed(2) + "%";
          console.log(`   容量${a.capacity}: 缺页=${a.faults} 命中=${a.hits} 命中率=${hr}`);
        }
      }
      return;
    }

    case "export": {
      const id = Number(flag(args, "--id"));
      const capacity = Number(flag(args, "--capacity"));
      const out = resolve(flag(args, "--out") ?? "export.json");
      service.exportAnalysis(id, capacity, out);
      console.log(`已导出: ${out}`);
      return;
    }

    default:
      console.log(usage());
      if (command && command !== "--help" && command !== "-h") {
        throw new AppError("NOT_FOUND", `未知命令：${command}`, 404);
      }
  }
}

main().catch((err: unknown) => {
  if (err instanceof AppError) {
    console.error(`错误 [${err.code}] ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error("内部错误:", err);
    process.exitCode = 1;
  }
});
