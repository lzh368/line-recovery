# cooling-control · 散热 MCP v0.1

已实现 Python stdio 演示服务 [server.py](server.py)，启动与应用连接见 [MCP 使用说明](../README.md)。新版设备具有驱动柜内部独立风机；散热输入已随 dataset-v0.1 提供，不把该能力默认为旧工位已有。本次没有运行 Agent 或评分。

| 工具 | 用途 | 返回契约 |
| --- | --- | --- |
| get_cooling_status | 查询同一设备的最新温度、风机、暂停与许可状态 | contracts/device-state.schema.json；source 不得为 uploaded_snapshot |
| start_cooling | 请求开启批准的风机模式，不启动输送 | contracts/action-result.schema.json；action=start_cooling |

`tools.json` 是实际 tools/list。命令为 `python3 interfaces/cooling-control/server.py`（仓库根目录），与 power-control 共享可信演示状态、版本及幂等记录；应用已配置客户端启动命令。运行前必须初始化演示数据库。

## 公开演示规则

- 本项目自定义参数，不是行业通用阈值：柜温达到 50 °C 预警，达到 60 °C 时控制器暂停输送。
- 温度降至 45 °C 或以下并连续保持至少 30 s，后端才可令 temperature_recovery_ready=true。缺失读数中断计时。
- 散热前核对控制器及风机电源可用、风机无故障、控制许可有效、无急停/维护锁定、防护与区域条件合格且状态新鲜。
- 工具只请求开启风机，不改温度反馈、转速反馈或保护阈值，不解除保护、不恢复上料。
- confirmed 表示风机已有运行反馈，不代表温度已降低；等待超时、风机不转、温度不降需报告失败/未知或转人工，不能无限轮询。
- 温度达标后仍须通过 power-control 重新查询当前状态及运行许可，再请求恢复输送。

写请求参数、幂等、版本和拒绝条件与 power-control 一致，本实现不接受 live 模式。散热输入、日志与参考已按这些规则制作；逐例参考与后端夹具不在本仓库。使用 `cooling` 公开场景可联调温度反馈；对应数据案例的实验须加载其独立夹具。数据校验、服务测试和 Agent 评分分别记录。
