# 离线最优页置换（Belady MIN）缺页过程分析后端

使用 **TypeScript + Node.js + SQLite** 实现的操作系统教学工具，只提供 **HTTP API 与 CLI**（无前端、无 Docker、无 WSL、无任何在线服务依赖）。

给定一串页面访问编号和缓存容量，在**已知完整未来访问序列**的离线假设下，计算理论上**最少**的缺页次数，并输出每一步的缓存内容与淘汰依据。

## 重要假设：离线先知 ≠ 在线缓存

- 本项目实现的是 **Belady 最优置换（MIN / OPT）**：淘汰“未来最长时间内不会被访问”的页。
- 算法必须**提前看到完整序列**，这在真实系统运行时无法获得，因此结果是**理论下界**，**不代表 LRU、FIFO、时钟等任何在线策略可以实际达到的性能**。
- 本工具**不采集真实机器内存**、**不实现 HTTP 缓存**、**不运行后台代理**。
- 它是离线分析/教学工具，请勿把输出当作生产缓存配置依据。

## 淘汰规则（核心）

每次缺页且缓存已满时：

1. 预处理各页面未来出现位置；
2. 淘汰**下一次访问下标最大**的页；
3. **此后不再出现**的页视同“无限远”，**优先淘汰**；
4. 若多个候选都不再出现，按**公开稳定的编号顺序**淘汰（编号为字符串，采用跨平台一致的代码点字典序，例如 `"1" < "10" < "2"`）。

注意：这**不是** LRU（不看最近多久用过），也**不是** FIFO（不看进入缓存先后）。

命中不计缺页。**容量 0** 时每次访问都缺页且不保留任何页面。**空序列**缺页数为 0，且命中率/缺页率记为 `null` / `N/A`——因为分母为零，比例**无定义**，不伪装成 0%。

## 公开限制

| 项目 | 上限 |
| --- | --- |
| 序列长度（访问次数） | 10 000 |
| 缓存容量（页数） | 1 000 |
| 单个页号长度 | 64 字符 |

可通过 `GET /api/limits` 或源码 `src/core/types.ts` 查看。页号为非空字符串，容量为非负整数，初始缓存为空，页面大小相同。

## 环境要求

- Windows 本地运行，Node.js **>= 22.5**（开发验证于 Node v25）。
- SQLite 使用 Node **内置模块** `node:sqlite`，**无需编译原生模块、无需外部数据库安装**。

## 安装

```powershell
npm install
```

## 构建

```powershell
npm run build
```

编译产物输出到 `dist/`。

## 测试

```powershell
npm test
```

测试覆盖：全部相同、全部不同、容量 0、容量超过不同页数、重复访问、同分（多页不再出现）淘汰、最后几步、空序列比例语义；
并用**独立的递归全枚举基准**（枚举每个淘汰点的所有合法选择）对随机短序列交叉验证 Belady 确为最少缺页；
同时校验容量增加时缺页数单调不增、每步缓存不超容量、命中数 + 缺页数 = 访问次数、SQLite 重启后可复现同一过程。

## 启动 HTTP API

```powershell
# 默认端口 0 = 自动选择一个空闲端口，仅监听 127.0.0.1
npm start

# 指定端口
npx tsx src/cli/index.ts serve --port 8080
```

## 教学演示（经典序列，容量 3）

```powershell
npm run demo
```

序列 `7,0,1,2,0,3,0,4,2,3,0,3,2`、容量 3 的最优结果为 **7 次缺页**，淘汰顺序为 `1 -> 7 -> 0 -> 4`（共 4 次淘汰）。其中下标 3 时 `1/7` 都不再出现，按稳定字典序淘汰 `1`；下标 5 时页 `7` 已**不再出现**（`NO_NEXT`）优先淘汰，而**不是**淘汰仍会被访问的 `2`——这直观展示了“不再出现优先于下一次出现晚”的规则。
演示还会解释：下标 7 缺页装 `4` 时，缓存 `{0,2,3}` 的下一次出现分别是 `10 / 8 / 9`；页 `2` 在**下标 8 立即再次使用**，若淘汰它下一步必缺页，因此最优规则淘汰最晚的 `0`，绝不会淘汰即将再次出现的页。

## CLI 命令

```powershell
npx tsx src/cli/index.ts --help

# 导入（生成不可变版本快照，存 SQLite）
npx tsx src/cli/index.ts import --pages "7,0,1,2,0,3,0,4,2,3,0,3,2" --name 经典序列

# 对已导入版本做某容量分析（持久化）
npx tsx src/cli/index.ts analyze --id 1 --capacity 3

# 即时分析（不落库），打印每一步
npx tsx src/cli/index.ts analyze-once --pages "7,0,1,2,0,3,0,4,2,3,0,3,2" --capacity 3

# 查看某一步（0 基）
npx tsx src/cli/index.ts step --id 1 --capacity 3 --step 7

# 多容量对照扫描
npx tsx src/cli/index.ts scan --id 1 --from 0 --to 5

# 历史查询（可按名称 / 页号过滤）
npx tsx src/cli/index.ts history --name 经典
npx tsx src/cli/index.ts history --page 4

# 导出某版本某容量的完整分析 JSON
npx tsx src/cli/index.ts export --id 1 --capacity 3 --out result.json
```

## HTTP API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/limits` | 公开序列长度/容量上限 |
| POST | `/api/sequences` | 导入序列（`{sequence:string[], name?}`） |
| GET | `/api/sequences` | 序列版本列表 |
| GET | `/api/sequences/:id` | 查看某版本（不可变快照） |
| POST | `/api/sequences/:id/analyses` | 分析（`{capacity}`）并持久化 |
| GET | `/api/sequences/:id/analyses` | 该版本所有容量的分析 |
| GET | `/api/sequences/:id/steps/:step?capacity=n` | 查看某一步 |
| GET | `/api/sequences/:id/scan?from=0&to=n` | 多容量对照扫描 |
| POST | `/api/analyze` | 即时分析 `{sequence, capacity}`（不落库） |
| GET | `/api/history?name=&page=` | 历史查询 |
| POST | `/api/sequences/:id/export` | 导出完整结果（`{capacity, output}`） |

示例：

```powershell
curl.exe -X POST http://127.0.0.1:8080/api/sequences `
  -H "content-type: application/json" `
  -d '{\"sequence\":[\"7\",\"0\",\"1\",\"2\",\"0\",\"3\",\"0\",\"4\",\"2\",\"3\",\"0\",\"3\",\"2\"],\"name\":\"demo\"}'
```

## 每步报告字段

每个 step 包含：访问下标 `index`、访问页 `page`、`event`（`HIT`/`FAULT`）、
访问前 `cacheBefore`、访问后 `cacheAfter`、`replacement`：

- `evictedPage`：被淘汰页（无则 `null`）；
- `candidates`：淘汰时刻缓存中**每个候选页**的下一次出现情况，
  `nextIndex` 为下标，`state` 为 `HAS_NEXT` 或 `NO_NEXT`（无后续出现的**显式状态**，不使用魔法数字）；
- `reason`：中文淘汰依据说明。

## 错误码

所有错误返回 `{ "error": { "code", "message", "details?" } }`：

| code | 含义 | HTTP |
| --- | --- | --- |
| `INVALID_SEQUENCE` / `PAGE_LABEL_INVALID` | 序列不是数组 / 页号为空或过长 | 400 |
| `SEQUENCE_TOO_LONG` / `CAPACITY_TOO_LARGE` | 超过公开上限 | 400 |
| `INVALID_CAPACITY` | 容量不是非负整数 | 400 |
| `INVALID_PAYLOAD` / `INVALID_QUERY` | 请求体非 JSON / 查询参数非法 | 400 |
| `NOT_FOUND` | 序列版本或资源不存在 | 404 |
| `STEP_OUT_OF_RANGE` | 步骤下标越界 | 404 |
| `CONFLICT` / `INTERNAL` | 冲突 / 内部错误 | 409 / 500 |

## 数据与版本语义

- 数据库文件默认位于**项目内数据目录** `data/page-sim.sqlite`（可用环境变量 `PAGE_SIM_DB` 覆盖）。
- 序列以**不可变快照**保存，并记录内容 `sha256`。修改原序列后再次导入会生成**新版本**；旧报告永久绑定旧快照，**不会**被改动覆盖。
- 完全相同的内容重复导入会复用既有快照（返回 `reused: true`）。
- 同一序列版本 + 同一容量的完整分析结果只保存一份。

## 目录结构

```
src/
  core/         Belady 算法、递归枚举基准、类型、校验、错误码
  storage/      SQLite 连接与仓储（版本化持久化）
  service/      分析、单步、容量扫描、历史、导出
  api/          纯 node:http 的 JSON API
  cli/          命令行、教学演示、输出格式化
tests/          Node 内置测试运行器用例
data/           项目内 SQLite 数据目录
```
