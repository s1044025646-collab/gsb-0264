# 离线最优页置换（Belady）缺页过程分析后端

操作系统教学用的**离线**页置换分析服务：输入一串页面访问编号与缓存容量（按页数计，初始缓存为空，页面大小相同），在**已知完整未来访问序列**的前提下计算最少可能的缺页次数，并输出每一步的缓存内容与淘汰依据。

只包含后端：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`），提供 HTTP API 与 CLI。不采集真实机器内存、不实现 HTTP 缓存、不运行后台代理，不依赖 Docker、WSL、付费服务或任何外部在线 API。

## 重要概念：离线先知假设

本服务实现的是 **Belady 最优置换（OPT / MIN）**：分析开始时就掌握整段未来访问序列。每次缺页且缓存已满时，淘汰**下一次访问最晚**的页；从此不再出现的页优先淘汰；若多个候选都不再出现，按页标识**公开稳定的字典序**（字符串比较，注意 `"10" < "2"`）决定唯一被淘汰者。

- 这**不是** LRU（最近最少使用），也**不是** FIFO（最早进入）。LRU 用“过去最近一次使用”推测未来，Belady 直接读取未来。
- 真实操作系统/缓存是**在线**的，无法预知未来，因此 **Belady 的缺页次数是理论下界，在线策略不能保证直接达到**。本服务结果仅用于教学对比与下界分析。
- 命中率/缺页率的分母是访问次数。**空序列分母为 0，比例无定义**，接口与 CLI 输出 `null` / “无定义”，而不是 0 或 1。空序列缺页数为 0。
- 容量为 0 时每次访问都缺页且不保留任何页面。

“无后续出现”使用显式状态 `{ "kind": "never" }`（CLI/演示中显示“此后不再出现”），不使用 `-1` 之类可能与合法下标混淆的魔法数字。

## 环境要求

- Windows 本地 PowerShell（也兼容 Linux/macOS）
- Node.js **>= 22.5**（开发验证于 Node 25，内置 `node:sqlite`；如遇实验性模块提示属正常）

> Node 25 启动时可能打印 `ExperimentalWarning: SQLite is an experimental feature`，这是内置模块的版本提示，不影响功能；无需安装任何第三方 SQLite 依赖。

## 安装

```powershell
cd E:\GSB\0264\B
npm install
```

## 构建

```powershell
npm run build
```

TypeScript 编译到 `dist/`。

## 演示

```powershell
npm run demo
```

演示内容：
1. 经典序列 `7,0,1,2,0,3,0,4,2,3,0,3,2`、容量 3 的逐步淘汰（穷举基准确认最优：**7 次缺页**；注意 Silberschatz 教材常给出的 9 次是完整 20 个引用串 `...,1,2,0,1,7,0,1` 的 OPT 结果）；
2. “即将再次出现的页面不应被淘汰”的专门解释；
3. 同一序列容量 0–4 的缺页/命中率对照；
4. 短序列枚举所有合法淘汰选择的递归基准核对。

## 测试

```powershell
npm test
```

测试覆盖：全部相同、全部不同、容量零、容量超过不同页数、重复访问、同分（均不再出现）字典序淘汰、最后几步、空序列语义、缓存不超容量、命中+缺页=访问数、容量增加缺页单调不增加，以及：

- **独立递归基准**：对短序列（<=12 步，另含 200 组随机短序列）枚举每一次满缓存缺页时的每一个合法淘汰选择，穷举全局最少缺页数，与正式 Belady 实现逐一核对；
- **重启一致性**：关闭后用同一 SQLite 文件重新打开，旧过程仍可完整查询。

## 启动 API 服务

```powershell
# 默认自动选择一个空闲端口，启动后在控制台打印实际地址
npm start

# 或指定端口与数据目录
$env:PORT=3000
$env:DATA_DIR="E:\GSB\0264\B\data"
npm start
```

## CLI

```powershell
npm run cli -- --help

npm run cli -- limits
npm run cli -- import --pages "7,0,1,2,0,3,0,4,2,3,0,3,2" --name 经典序列
npm run cli -- analyze --pages "7,0,1,2,0,3,0,4,2,3,0,3,2" --capacity 3
npm run cli -- analyze-db --id 1 --capacity 3
npm run cli -- step --analysis 1 --index 7
npm run cli -- scan --pages "7,0,1,2,0,3,0,4,2,3,0,3,2" --max-capacity 4
npm run cli -- history
npm run cli -- export --analysis 1 --out result.json
npm run cli -- verify --pages "a,b,c,a,d" --capacity 2
```

`--pages` 为逗号分隔的非空字符串；`--pages ""` 表示空序列。`analyze`/`scan`/`verify` 是无状态即时计算；`import`/`analyze-db`/`step`/`history`/`export` 使用 SQLite 持久化。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与上限 |
| GET | `/limits` | 公开序列长度与容量上限 |
| POST | `/sequences` | 导入序列版本：`{sequence: string[], name?: string}` |
| GET | `/sequences` | 序列版本列表 |
| GET | `/sequences/:id` | 查看某序列版本（含完整页序列） |
| POST | `/sequences/:id/analyze` | 分析：`{capacity: number}`，完整结果落库 |
| GET | `/sequences/:id/analyses` | 该序列全部容量的历史分析摘要 |
| GET | `/analyses/:analysisId` | 完整分析结果 |
| GET | `/analyses/:analysisId/steps/:stepIndex` | 查看某一步 |
| POST | `/sequences/:id/scan` | 容量扫描：`{maxCapacity: number}` |
| GET | `/history?sequenceId=` | 历史查询 |
| GET | `/export/:analysisId` | 导出完整结果（含离线假设声明） |

调用示例：

```powershell
$body = '{"sequence":["7","0","1","2","0","3","0","4","2","3","0","3","2"],"name":"经典序列"}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/sequences -ContentType 'application/json' -Body $body
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/sequences/1/analyze -ContentType 'application/json' -Body '{"capacity":3}'
Invoke-RestMethod http://127.0.0.1:<端口>/analyses/1/steps/7
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/sequences/1/scan -ContentType 'application/json' -Body '{"maxCapacity":4}'
Invoke-RestMethod http://127.0.0.1:<端口>/export/1
```

### 每步报告字段

```json
{
  "index": 7,
  "page": "4",
  "outcome": "FAULT",
  "cacheBefore": ["0", "2", "3"],
  "cacheAfter": ["2", "3", "4"],
  "evictedPage": "0",
  "candidates": [
    { "page": "0", "nextOccurrence": { "kind": "future", "index": 10 } },
    { "page": "3", "nextOccurrence": { "kind": "future", "index": 9 } },
    { "page": "2", "nextOccurrence": { "kind": "future", "index": 8 } }
  ],
  "reason": "缺页且缓存已满：淘汰页 0，其下一次访问为 下标 10……"
}
```

`outcome` 为 `"HIT"` 或 `"FAULT"`；`nextOccurrence` 为 `{kind:"future",index}` 或 `{kind:"never"}`。

## 错误码

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `SEQUENCE_NOT_ARRAY` / `INVALID_JSON` | 请求体格式错误 |
| 400 | `INVALID_PAGE_ID` | 页标识不是非空字符串 |
| 400 | `SEQUENCE_TOO_LONG` | 长度超过 10000 |
| 400 | `INVALID_CAPACITY` | 容量不是非负整数 |
| 400 | `CAPACITY_TOO_LARGE` | 容量超过 1000 |
| 400 | `INVALID_STEP_INDEX` | 步下标非法/越界 |
| 404 | `NOT_FOUND` | 序列或分析不存在 |
| 404 | `ROUTE_NOT_FOUND` | 路径不存在 |
| 500 | `INTERNAL_ERROR` | 服务端内部错误 |

## 数据与版本语义

- 数据目录默认在项目内 `data/`（可用 `DATA_DIR` 环境变量覆盖），数据库文件 `data/belady.sqlite`。
- 序列以**不可变版本**保存：同名重复导入自动生成新版本（`(name, version)` 唯一）；分析结果以完整 JSON 存入 `analyses` 表，`(sequence_id, capacity)` 唯一且幂等。
- **改动原序列不会改变旧报告**：旧版本行与旧分析 JSON 永不被覆盖。

## 公开上限

- 序列长度：**10000** 次访问；
- 缓存容量：**1000** 页。

## 限制与合理假设

- 页标识按字符串处理，不做数值化（因此 `"10" < "2"`，字典序是公开稳定的同分裁决规则）。
- 枚举基准为指数复杂度，限制 12 步以内，仅用于测试/教学核对。
- 服务仅监听 `127.0.0.1`，面向本机教学使用，未包含鉴权与 HTTPS。
- 缓存快照按字典序输出，便于逐步对照；该排序不影响淘汰决策。
