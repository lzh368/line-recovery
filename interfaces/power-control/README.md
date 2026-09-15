# power-control · 恢复运行 MCP v0.1

已实现 Python stdio 演示服务 [server.py](server.py)，启动与应用连接见 [MCP 使用说明](../README.md)。故事是“已经来电，但没有自动重启”，不提供远程合闸、接通电源或给电池充电的工具。

| 工具 | 用途 | 返回契约 |
| --- | --- | --- |
| get_device_status | 查询最新可信设备状态，不改变设备 | contracts/device-state.schema.json；source 不得为 uploaded_snapshot |
| resume_conveyor | 供电和许可满足时，请求批准的输送启动流程 | contracts/action-result.schema.json；action=resume_conveyor |

`tools.json` 是服务实际返回的 MCP tools/list，inputSchema 自包含。命令为 `python3 interfaces/power-control/server.py`（仓库根目录）；应用会自动管理进程，无需另外启动。运行前必须初始化演示数据库。

## 服务端强制检查

执行点重新核对：设备白名单、控制器在线、当前上游及驱动供电正常、驱动就绪、AUTO 且生产任务有效、运行许可有效、急停和维护锁定未生效、防护及区域条件合格、下游可接收、无未解决积聚、无温控暂停、温度恢复条件合格、状态新鲜。现场适配器还须执行其真实规程。

许可来自可信后端，不接受上传文件自授权；工具参数不允许 approved、safety_ok、任意地址或控制脚本。

- expected_revision 匹配最新状态；两个 MCP 使用同一设备状态版本和执行锁。
- request_id 为幂等键。同设备同请求号同参返回原操作，不重复执行；改参数复用请求号拒绝。先查幂等，再检查状态版本。
- 后端执行批准的空载确认与上料恢复过程，Agent 不能自选速度或跳过检查。
- accepted 仅表示受理；confirmed 需要新运行反馈。出口恢复产出另需对照动作前基准与后续计数。
- 已满足目标可返回 already_satisfied；失败或读回未知必须保留，不能把 null 当作成功。
- 超时先查询，不盲目换请求号重发。生成报告的格式重试不能重放设备动作。

本实现只支持 dry_run，live 会被拒绝。演示状态标为 demo_backend，不冒充现场数据。逐例夹具留在工作区外，由维护方预先加载到隔离数据库；服务不读评分答案，不按 case_id 替 Agent 选择动作。公开通用演示场景在 shared/profiles.py。
