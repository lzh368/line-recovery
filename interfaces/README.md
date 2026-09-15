# 两个 MCP 服务

已实现 `power-control` 和 `cooling-control`，使用 Python 3.11+ 标准库，无需安装 Python 依赖。它们是两个独立的 MCP stdio 进程，共享同一个 SQLite 演示设备后端；应用的连接配置已经指向这两个服务。

| 服务 | 查询工具 | 写工具 |
| --- | --- | --- |
| power-control | `get_device_status` | `resume_conveyor`：来电后申请恢复输送，不远程合闸 |
| cooling-control | `get_cooling_status` | `start_cooling`：开启散热，不直接启动输送 |

## 快速启动

在仓库根目录初始化与 `examples/input/lr_001/` 对应的供电恢复演示状态：

```bash
python3 interfaces/manage.py init --profile power-return
cd app
npm ci
npm run setup
npm start
```

如果应用已经完成安装和 Agent 初始化，不必重复 `npm run setup`。模型密钥按 [应用说明](../app/README.md) 填在 `app/.env` 或通过环境变量配置；MCP 本身不需要密钥，也不调用模型。

在页面的“设备工具”中连接两个服务。无需另外手动启动 Python 服务，应用会按 `app/config/interfaces.json` 启动并管理它们。直接在终端运行 `server.py` 会等待 MCP JSON-RPC 消息，不会打开网页。

已有状态时 `init` 会拒绝覆盖。如需重新演示，先断开两个服务，再显式复位并重新连接：

```bash
python3 interfaces/manage.py reset --profile power-return
python3 interfaces/manage.py status
```

`reset` 会开始新一轮演示，但保留旧状态和审计记录。默认数据库 `interfaces/runtime/demo.sqlite3` 已被 Git 忽略。

## 演示与反馈

内置四个公开的接口联调场景：`power-return`、`cooling`、`maintenance`、`fan-failure`。例如切换到散热联调：

```bash
python3 interfaces/manage.py reset --profile cooling
```

供电恢复请求受理后，先出现带速反馈，再出现新的出口计数。散热请求受理后，先出现风机反馈，随后温度下降；满足持续达标条件后，才允许另行请求恢复输送。风机故障和维护锁定不会被处理成恢复成功。

演示按经过时间推进，不按查询次数推进。默认 `--time-scale 20` 表示 1 秒真实时间对应 20 秒演示时间；需要按真实时间等待时使用 `--time-scale 1`。温度须在演示时间内连续满足公开的 30 秒条件。该倍率只用于演示，不代表真实设备的散热速度或延迟。

两个服务均返回新查询的 `captured_at`、30 秒有效期及共同的 `revision`。写操作要求本服务先查询、版本匹配且当前条件全部满足；未知条件不会按允许处理。相同 `request_id` 和参数只返回第一次操作结果，不重复执行。动作受理后的进展通过查询状态核验，不能把 `accepted` 当作恢复完成。

## 17 份案例的后端夹具

数据集的上传资料与后续设备反馈是两回事。上传 ZIP 不会修改可信后端，也不会授予运行权限。逐例后端夹具和参考答案已归档到 [evaluator/](../data/dataset/evaluator/README.md)，由组织实验的一方管理，不能交给被测 Agent。

为每例创建独立数据库，加载该例的可信夹具，然后让两个 MCP 使用同一数据库：

```bash
python3 interfaces/manage.py --db /absolute/run/lr_101/state.sqlite3 init --fixture data/dataset/evaluator/optimization/lr_101/backend-fixture.json --time-scale 20
```

启动应用前设置 `LINE_RECOVERY_STATE_DB=/absolute/run/lr_101/state.sqlite3`，或在两个服务的配置 `env` 中设置相同绝对路径。一份数据库只对应一个当前案例；批量实验不能让不同案例共用可变状态。内置 `cooling` 是接口联调场景，不应冒充任意上传案例的后续反馈。

支持夹具中“动作后延时反馈”“尚未执行时状态变化”“执行瞬间版本冲突”和散热 1 Hz 读回。夹具是演示输入，加载夹具本身不算执行；真实调用时才记录受理、拒绝及反馈。

## 校验命令

```bash
python3 -m unittest discover -s interfaces/tests -v
cd app
npm run check
npm run check:mcp
npx tsc --noEmit
```

后端维护方还可在仓库根目录执行 `python3 tools/check_evaluation_bundle.py` 核对输入与评测材料绑定，再执行 `python3 tools/check_backend_fixtures.py --fixtures data/dataset/evaluator`。后一项按参考动作验证后端兼容性，不测试 Agent 能否自行选对动作，不产生 Agent 分数。

## 实现范围

- 仅 `dry_run`；设置 `live` 时服务拒绝启动，无 PLC、现场网络或真实设备控制代码。
- MCP 使用 [stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[初始化](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) 和 [tools 接口](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)，协议版本 `2025-06-18`。只声明本项目实现的 tools 能力。
- SQLite 事务对两个进程的查询、版本检查和写入串行化；复位后的版本不复用，旧客户端不能跨轮执行。
- 不提供解除急停、维护锁定、屏蔽保护、修改温度或任意脚本工具。
- 管理 CLI 不对 Agent 开放。数据库可能包含私有夹具及审计，不应提交或加入 Agent 可读目录。
- 当前应用仍由按钮触发动作，Agent 自动调用及持续读回由下一步完成，见 [接入交接](../interfaces/README.md)。

## 文件

```text
interfaces/
├── manage.py                  # 维护方初始化、复位、状态及审计入口
├── power-control/server.py    # 恢复输送 MCP
├── cooling-control/server.py  # 散热 MCP
├── shared/                    # 协议、输入校验、共享状态和公开演示场景
├── tests/                     # 后端与真实 stdio 协议回归
└── runtime/                   # 本地可变状态及审计，不入 Git
```
