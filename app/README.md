# 产线恢复助手 · 应用（app/）

读上传的纸箱输送工位资料（ZIP 或仓库里的 example），核对停机经过与恢复条件，给出**带证据的历史异常判断**与**恢复计划**；需要动作时先重新查询工具状态，再由后端按许可请求执行，并如实区分"命令受理 / 命令确认 / 产出恢复"三个阶段。

- 技术栈：Node 24 + TypeScript（`tsx` 直跑，无需构建）、原生 JS 前端、无外部前端依赖。
- 资料只读：应用读取仓库的契约与输入资料；解包、应用审计、报告写在 `app/runtime/`，MCP 设备状态与工具审计写在 `interfaces/runtime/`。实验归档前应保留这些运行记录。
- 两个 MCP 服务已交付并配置为本地 stdio，均只支持演示模式。**当前 Agent 只生成诊断和计划，动作由页面按钮触发**；自动调用及持续读回的接入见 [MCP 使用说明](../interfaces/README.md)。

## 快速开始

```bash
python3 interfaces/manage.py init --profile power-return  # 仓库根目录；已有状态不覆盖
cd app
npm install          # 安装依赖
npm run setup        # 初始化应用自带的嵌入式 Agent（写 app/penguin_data 下的 Agent State）
npm start            # 启动 → 终端会打印实际地址，默认 http://127.0.0.1:4711
```

打开页面后点左侧 **载入 example**（读 `examples/input/lr_001`）即可浏览全部页签；也可以上传自己的 ZIP（根目录必须直接含 `request.json`）。想看一次完整的接口自检而不开浏览器：

```bash
npm run check
npm run check:mcp    # 真实 MCP + HTTP 恢复链路，临时演示数据库，不调用模型
npm run check:agent  # Agent 的受控工具链路：真实 stdio 包装服务 + 幂等/读回/请求号纪律，不调用模型
```

## 端口与环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4711` | 首选端口；被占用时自动顺序取下一个空闲端口（最多顺延 12 个），不会抢占已在运行的服务 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `LR_CONTRACTS_DIR` | `<repo>/contracts` | 契约目录（Schema 与报告模板，只读） |
| `LR_INTERFACES_DIR` | `<repo>/interfaces` | 两个 MCP 的工具定义目录（应用只读） |
| `LR_EXAMPLE_DIR` | `<repo>/examples/input` | example 资料目录（只读） |
| `LR_RUNTIME_DIR` | `app/runtime` | 解包案例、审计、报告 |
| `LR_INTERFACES_CONFIG` | `app/config/interfaces.json` | 接口连接配置 |
| `LR_DATA_ROOT` | `app/penguin_data` | 嵌入式 Agent 的数据根，**始终在项目内**，不使用用户全局 `~/.penguin` |
| `LINE_RECOVERY_STATE_DB` | `<repo>/interfaces/runtime/demo.sqlite3` | 两个 MCP 共用的演示数据库；批量实验每例使用独立文件 |

## 配置模型（只有"诊断"需要）

诊断用嵌入式 Agent 跑：它读案例目录，只允许 `read_file`，产出"判断 + 证据 + 恢复计划"的 JSON。

**模型固定为 DeepSeek V4.1 Flash**（厂商目录里 V4.1 Flash 的裸名 `deepseek-flash`，提供方 `deepseek`），走官方端点 `https://api.deepseek.com`。这三项**都是 `.env` 里真实生效的变量**（不是注释，也不写死在代码里），每次建会话都显式带上，因此不受 Agent 数据根里 Project 默认模型的影响：

| 变量 | 代码里的默认值 | 说明 |
| --- | --- | --- |
| `LR_MODEL_PROVIDER` | `deepseek` | 提供方 |
| `LR_MODEL_ID` | `deepseek-flash` | 模型标识（DeepSeek V4.1 Flash 的裸名） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 端点；只在走自建网关 / 代理时才改 |
| `DEEPSEEK_API_KEY` | 无 —— **唯一必须你填的一项** | 官方 API Key；变量名由提供方推导（`deepseek` → `DEEPSEEK_API_KEY`） |

**要填的文件：`app/.env`**（唯一要动的地方）

```bash
cd app
cp -n .env.example .env   # 只在不存在时创建；已有 Key 不覆盖
```

`.env` 里模型三项都已给出，留空或删掉就用上表的默认值；**只有 Key 是空的**：

```dotenv
LR_MODEL_PROVIDER=deepseek
LR_MODEL_ID=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=<在 https://platform.deepseek.com/api_keys 申请的官方 Key>
```

- `.env` 已被仓库 `.gitignore` 忽略（`.env` / `.env.*`），不会提交、不会被应用写入或回显；`app/.env.example` 是提交进版本库的模板。
- 服务启动时把 `.env` 的变量放进进程环境；**已经在 shell 里 `export` 的同名变量优先**，不会被文件覆盖（所以也可以直接 `DEEPSEEK_API_KEY=... npm start`）。
- 换模型 / 换端点只改 `.env` 再重启，不必改代码；只写 `DEEPSEEK_BASE_URL` 而不显式传给 SDK 是不生效的（Agent 数据根里 Project 的模型条目会把端点定死），本应用每次都显式传，所以这一行真的管用。
- 填完后重启服务，顶栏 pill 会从"模型未配置"变成"模型 deepseek-flash"，侧栏"模型"卡片会显示 `模型 deepseek / deepseek-flash · 变量 LR_MODEL_PROVIDER / LR_MODEL_ID（来自 …/app/.env）` 与 `密钥变量 DEEPSEEK_API_KEY · 已读到 · 填写位置 …/app/.env（存在）`。

未配置模型时的行为是**如实降级**，不是坏掉：

- 顶部状态栏显示"模型未配置"，`GET /api/model` 返回 `configured:false`、`api_key_present:false`、要填的文件路径与原因；
- "诊断与证据"页签禁用分析按钮并说明原因与填写位置；`POST /api/cases/:id/analyze` 是 SSE 流，会在事件流里回一条 `{"type":"error","code":"MODEL_NOT_CONFIGURED"}` 并且不产出报告（普通 JSON 接口遇到模型凭据问题返回 `503`）；
- 密钥填了但无效时不会被当成"成功"：诊断以 `MODEL_AUTH_ERROR` 和厂商的原始报错如实返回，报告不生成；
- 上传/解包、资料浏览、工具状态、审计、动作边界**不受影响**。

密钥只从环境读取，不写入任何文件、不进日志、不回显；页面与接口都不返回密钥内容（`npm run check` 里有一条断言专门校验这一点）。

## 配置两个 MCP 接口

`app/config/interfaces.json` 已配置下列两个服务。相对路径以 `app/` 为基准，不依赖启动命令时所在目录。默认使用 `python3`，如系统命令不同可改为 Python 3.11+ 的绝对路径：

```json
{
  "execution_mode": "dry_run",
  "interfaces": {
    "power-control": {
      "command": "python3",
      "args": ["../interfaces/power-control/server.py"],
      "env": {},
      "cwd": null,
      "timeout_ms": 10000
    },
    "cooling-control": {
      "command": "python3",
      "args": ["../interfaces/cooling-control/server.py"],
      "env": {},
      "cwd": null,
      "timeout_ms": 10000
    }
  }
}
```

- `command` 为空（`null`）= **工具未连接**：只显示状态，不查询、不执行、不伪造动作。
- 本次服务只接受 `dry_run`。应用配置为 `live` 时，这两个服务会拒绝启动；上传包和 Agent 都不能切换模式，仓库没有现场设备适配器。
- 左侧"设备工具"卡片有 **连接 / 断开** 按钮，调用 `POST /api/tools/<id>/connect|disconnect`，用真实的进程状态展示连接结果。
- 未连接时请求恢复的实际响应（`npm run check` 已断言）：`attempted=false`、阶段 `not_attempted`、`operations=[]`、`latest_state=null`、决策 `human_required`、原因码 `TOOLS_UNAVAILABLE`，审计里多一条 `blocked` 记录且**没有** `request_id`（因为根本没发出写调用）。

拉取本次服务更新后，切换步骤：

1. `git pull`，再 `cd app && npm install`（依赖有变化时）；
2. 按 `interfaces/README.md` 初始化演示数据库；`config/interfaces.json` 已配置两个服务，无需重新填写命令；
3. 重启 `npm start`，在左侧"设备工具"卡片点 **连接**，确认两个接口都变成"已连接"且列出已声明工具；
4. 先跑只读的 `get_device_status` / `get_cooling_status` 看最新状态，再请求动作；本实现保持 `dry_run`，配置 `live` 会被服务拒绝。

## Agent 的受控设备工具

上面两个服务是**接口侧**的 MCP。Agent 不直接连它们，而是连应用自带的包装服务 `src/tools/wrapper-server.ts`：`npm run setup` 会把它写进 Agent State 的 `tools.mcpServers`（名字 `recovery-control`），模型因此看到四个工具 `mcp__recovery-control__*`。

| 工具 | 说明 |
| --- | --- |
| `get_device_status` / `get_cooling_status` | 只读：查询最新可信状态（含新鲜度判定），只留一条 `query` 审计，不产生任何写 |
| `resume_conveyor` / `start_cooling` | 写：走 `runRecovery`，先查询 → 执行点前核对 → 带 `expected_revision` / `request_id` 请求 → 限时状态读回 → 按阶段判定 |

模型只能表达"调用哪个动作"：四个工具的入参 schema 都是**空对象**，`device_id` / `expected_revision` / `request_id` 一律由后端补全，模型改不了设备、版本、请求号或速度。请求号按 (案例, 动作) 持久化：同一版本上的重试复用原请求号（接口侧幂等返回原结果，不会第二次执行），版本已变则换新号。

限时读回预算（真实时间，到点就停，不靠多查几次跨过时间条件）：`resume_conveyor` 8 s / 1 s / 8 次，`start_cooling` 30 s / 2 s / 15 次。超预算就如实保留当时的阶段（`readback.timed_out=true`），绝不跳到"恢复成功"。

服务进程的 `cwd` 是会话的 workspaceDir（即案例目录），包装服务由它反查案例；查不到就返回 `CASE_NOT_RESOLVED`，既不猜案例也不执行动作。审计里的 `actor` 区分 `agent` / `backend` / `operator`，报告里的 `recovery` 只取自本轮真实工具轨迹。

## 页面

| 页签 | 内容 |
| --- | --- |
| 资料概览 | 操作人员的问题、案例与采集窗口、窗口内的真实核对（含"快照不是实时状态"）、上传快照与 CSV 的逐项核对、快照里不可信字段、完整性校验、`device.json`、公开操作参考 |
| 时序数据 | 关键量折线（供电电压 / 带速 / 柜温 / 上游电源可用）与 121 行 CSV 明细 |
| 控制器日志 | E001–E014 原文与逐条解读 |
| 工位图片 | 快照图片（点击放大，断线时显示占位而不是编造） |
| 诊断与证据 | 执行诊断（SSE 流式显示 thinking / 受控工具轨迹 / 正文），报告按 `contracts/report.schema.json` 校验后落盘；历史异常判断与最新状态/动作反馈分开展示 |
| 动作与反馈 | 请求恢复输送 / 请求散热（按业务故事与许可条件决定是否给按钮）、`accepted≠confirmed` 的阶段展示与阶段来源、限时读回预算与是否幂等重放、后端审计表（含触发方 agent/后端） |

所有文本都经 `textContent` 渲染，页面自身不发任何外部网络请求。

## 后端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 版本、各目录、契约文件、执行模式 |
| GET | `/api/model` | 模型是否已配置（真实建会话探测） |
| GET | `/api/tools` | 两个接口的连接状态与配置 |
| POST | `/api/tools/:id/connect` · `/disconnect` | 按配置启动/停止接口服务进程 |
| GET | `/api/cases` | 案例列表 |
| POST | `/api/cases/load-example` | 载入 `examples/input` |
| POST | `/api/cases/upload` | 上传 ZIP（`X-Case-Label` 可选命名） |
| DELETE | `/api/cases/:id` | 删除上传案例（example 不可删） |
| GET | `/api/cases/:id` | 概要（含 20 项事实与核对结果） |
| GET | `/api/cases/:id/telemetry` | CSV 行（`offset` / `limit`） |
| GET | `/api/cases/:id/events` · `/audit` · `/report` | 日志 / 审计 / 报告（无报告返回 404 `REPORT_NOT_FOUND`） |
| GET | `/api/cases/:id/file?path=` | 案例内文件（路径穿越被拒） |
| POST | `/api/cases/:id/analyze` | 诊断（SSE 事件流，逐段回传） |
| POST | `/api/cases/:id/recovery` | 请求动作：`{"action":"resume_conveyor"\|"start_cooling"}` |

## 目录

```text
app/
├── .env.example                  # 本地凭据模板（复制成 .env 后填官方 API Key；.env 不入库）
├── agent/persona.md              # Agent 人格（setup 时写入 Agent State 的 AGENTS.md）
├── agent/skills/line-recovery-case/SKILL.md
├── config/interfaces.json        # 两个 MCP 接口的连接配置
├── public/                       # 中文前端（index.html / app.js / styles.css）
├── src/
│   ├── server.ts                 # HTTP 服务与路由
│   ├── setup-agent.ts            # npm run setup（含注册受控工具服务 mcpServers）
│   ├── selftest.ts               # npm run check
│   ├── paths.ts  audit.ts
│   ├── case/                     # ZIP 解包、契约校验、解析、事实提取、案例存储
│   ├── diagnosis/                # 嵌入式 Agent、提示词、报告组装
│   ├── tools/                    # MCP 客户端、接口注册表、恢复流程
│   │   ├── wrapper-server.ts     # 应用自带的受控工具 MCP 服务（Agent 经它调用设备）
│   │   ├── agent-tools.ts        # 四个受控工具的实现（由 cwd 反查案例）
│   │   └── decisions.ts          # 按 (案例, 动作) 持久化 request_id / 应答，供重试幂等
├── tests/                        # run-offline-check / mcp-integration / agent-tools
├── runtime/                      # 运行期数据（cases / audit / reports），已被 gitignore
```

服务启动、演示复位、逐例后端加载及时间倍率见 [MCP 使用说明](../interfaces/README.md)。上传不同案例不会自动切换后端；联调时须确保当前后端与案例匹配。

## 本轮边界

- **已交付**：两个 MCP 演示服务、共享状态后端、应用连接配置，以及应用自带的受控工具包装服务（Agent 真的能调用，参数由后端补全）。
- **已验证**：`npm run check`（隔离配置下无模型、无工具时的降级）、`npm run check:mcp`（真实 stdio 客户端 + HTTP 动作接口）、`npm run check:agent`（真实包装服务的工具清单、空入参、只读无写、限时读回、只受理一次写、请求号纪律、反查不到案例时如实拒绝、散热→许可→另行恢复的顺序、执行点竞态下的幂等重放）均通过；真实模型诊断中 Agent 确实调用了 `get_device_status` / `get_cooling_status` / `resume_conveyor`，并在读回后报告 `production_confirmed`。
- **待接入**：现场适配器（当前仅 `dry_run` 演示后端）；Agent 的跨案例长时自主循环。
- **未验证**：现场设备上的真实执行（仓库没有现场适配器，`live` 会被演示服务拒绝）。
