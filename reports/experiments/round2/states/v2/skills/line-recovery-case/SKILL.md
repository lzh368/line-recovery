---
name: line-recovery-case
description: 产线恢复案例的整窗三态口径、写动作前置清单、证据格式与阶段口径——诊断纸箱输送工位上传资料时使用。
short_description: 案例三态口径与动作前置清单。
short_description_zh: 案例三态口径与动作前置清单。
version: 2
updated: 2026-09-15T00:00:00Z
---

# 产线恢复案例口径

## 两个诊断词汇

- `power_interruption_stop`：该时间窗出现过供电中断并导致停机。结束时可以已经来电，但输送仍停机——这是常见形态，不矛盾。
- `cabinet_overtemperature_pause`：达到公开温控暂停条件并有对应暂停记录。仅温度偏高不能排除其他原因。

资料不足以归入任一类型时 `fault_types` 留空，并在 `limitations` 说明缺什么；不要为了凑类型而猜测。留空之后 `window_status` 写 `abnormal` 还是 `insufficient_evidence`，按下一节的顺序判断——`fault_types` 空**不**自动等于 `insufficient_evidence`；`fault_types` 非空时 `window_status` 必须是 `abnormal`。

## 整窗三态怎么判断（`window_status`）

按顺序判：先找"确证的异常"，再判"能不能确证没有异常"。

1. **`abnormal`**：窗内能读到**设备侧**的异常证据，两类都算。
   - 异常事件记录：`level=WARN/FAULT` 且来源是设备侧（IO / PLC / DRIVE / ENCODER 等），例如上游电源有效反馈下降 `SUPPLY_VALID_FALL`、温控暂停 `THERMAL_HOLD`（含从窗口前延续的 `*_CARRYOVER`）、非计划保护暂停 `PROTECTIVE_HOLD`；
   - 或你能直接读到的异常取值：驱动支路电压 ≤1 V 且支路使能关闭、`thermal_pause_active` 由 0 置 1、急停或维护锁定置位。
   - 原因是否查明**不影响** abnormal：查不清原因时 `fault_types` 留空、`window_status` 照写 `abnormal`，把缺口写进 `limitations`。
2. **`insufficient_evidence`**：窗内是否发生异常**本身**没法判定——只有"运行请求被撤销 / 带速停稳"这类现象，而撤销的来源与原因没有任何设备侧事件记录，且停顿前后的关键通道在 CSV 里是空的（未观测），或事件分区未导出（如 `PARTIAL_EVENT_EXPORT` 这类采集侧告警）。此时停稳既可能是异常，也可能是计划或流程性停顿，资料不足以判定；`fault_types` 留空，把缺口与"请求补充"写进 `limitations`。summary 照写读到的现象（例如"运行请求在某个采样点被撤销、随后带速停稳"）并点明缺的是哪些通道与事件，但不要给它贴上异常或故障结论。
3. **`normal`**：有观测证据表明窗内没有异常——计划停顿（`operating_mode=PLANNED_STOP`、`production_requested=0` 等）或稳态运行，且窗内既没有设备侧异常事件，也没有异常取值。

三点必须记住：

- **采集/导出类告警不是设备异常证据**（来源是 HISTORIAN 的 `PARTIAL_EVENT_EXPORT` 之类）。它说明的是"缺口不能按无事件处理"，指向 `insufficient_evidence`，不能据此判 `abnormal`。
- 不要只看"带速停稳、`run_command` 掉到 0"就判 `abnormal`：停稳本身既可能是异常，也可能是计划停顿或原因尚未登记的停顿；判 abnormal 要有上面的设备侧异常事件或异常取值。
- `fault_types` 空不等于 `insufficient_evidence`：有异常但原因资料不足时是 `abnormal` + 空 `fault_types`；连"是否异常"都不确定时才是 `insufficient_evidence`。

## 证据格式

统一用 `file` + `locator` + `observation`：

- `file`：输入文件相对路径，如 `telemetry.csv`、`events.jsonl`、`device_state.json`、`images/frame_001.png`。
- `locator`：时间区间（`09:00:40~09:00:42`）、事件编号（`E005`）或字段路径（`device_state.json#run_command`）。
- `observation`：你实际读到的值，例如「上游电源有效反馈 1→0，驱动支路电压降至 0 V」。

## 容易混淆的量

| 容易混淆 | 区别 |
| --- | --- |
| 供电恢复 / 运动恢复 / 产出恢复 | 三个阶段：来电、带速恢复、出口计数增加依次独立判断 |
| `run_command` / `production_requested` / `run_resume_permitted` | 运行请求 / 生产需求 / 后端运行许可，互不替代；供电恢复后运行请求仍可为 false |
| `cooling_enabled` / `cooling_fan_running` / `cooling_fan_fault` | 风机命令 / 风机实际反馈 / 风机故障反馈 |
| `temperature_recovery_ready` | 由可信后端按连续有效温度计算，不能由资料或模型自报 |
| `accumulation` 在制箱数 | 入口累计 − 出口累计 − 人工移出累计；人工移出不算出口产出 |
| CSV 空值 / JSON `null` | 都是"未观测 = 未知"，不是 0、不是 false、更不能当作"满足条件" |

## 阶段词汇（后端按真实工具轨迹使用）

`not_attempted` 未执行 → `requested` 已提交 → `cooling_started` 风机确认 → `temperature_ready` 温度持续达标 → `running_confirmed` 运动确认 → `production_confirmed` 新的产出证据。受理不等于执行完成；风机运行不等于温度下降；带速恢复不等于出口恢复产出。

## 写动作前置清单（提交前逐项核对）

写工具会由后端重新查询并校验前置条件，但**你自己提交前也必须用最近一次只读查询核对一遍**。清单里任何一项为 `false`、`null`、空值、缺失或未返回，都算"未满足"：此时不要提交请求，把受阻项写进 `limitations`，decision 用 `human_required`（需现场处置或确认）或 `insufficient_evidence`（缺口只能靠补资料）。

| 动作 | 提交前必须在最新查询里成立 |
| --- | --- |
| `resume_conveyor` | `controller_online=true`、`run_resume_permitted=true`、`zone_clear=true`、`thermal_pause_active=false`、`temperature_recovery_ready=true`、`downstream_ready=true`、`unresolved_accumulation=false`、`emergency_stop_active=false`、`maintenance_lockout=false`、`guard_closed=true`、`upstream_power_available=true`、`drive_power_enabled=true`、`drive_ready=true` |
| `start_cooling` | `controller_online=true`、`cooling_control_permitted=true`、`cooling_fan_fault=false`、温度侧确有暂停或未就绪（`thermal_pause_active=true` 或 `temperature_recovery_ready=false`）、`emergency_stop_active=false`、`maintenance_lockout=false` |

- 上传快照里的许可、时效和 revision 只是当时的记录，不构成执行授权；判断未来动作只能用工具返回的 live 状态。
- `recovery_plan.reason` 里要写清：依据的是哪一次查询（工具、revision、新鲜度）、清单里哪些字段成立、若有受阻项是哪一项。
- 后端返回 `PRECONDITION_FAILED`（或明确拒绝）是最终结论：不要重复请求同一动作，也不要改换另一个明知不满足的动作再试；如实记录并给人工建议。
- decision 为 `human_required` / `insufficient_evidence` 时，`preferred_action` 只在方向本身明确（有资料或工具证据支持某个恢复动作）时给出，方向不明就用 `null`；不要给出一个前置清单里明摆着未满足的动作。

## 恢复链推进到什么程度

- 阶段顺序：查询 →（必要时）`start_cooling` → 温度恢复就绪 →（必要时）`resume_conveyor` → 运行确认 → 产出确认。
- 每个动作做完先读它的反馈与读回（`status` / `reason_code` / `readback` / `latest_state`）；**只要读回或随后一次新查询显示下一阶段的前置清单全部满足，就继续推进到下一阶段**，不要停在中间阶段；不满足就停在当前阶段，并写清停在哪一步、缺哪一项。
- 读回超时（`readback.timed_out=true`）只说明预算内没有确认，不代表失败或成功：要么再查一次最新状态，要么如实写"预算内未确认"。
- 受理 ≠ 执行 ≠ 恢复到产出：`requested` / `cooling_started` / `temperature_ready` / `running_confirmed` / `production_confirmed` 分层记录，未到最终阶段不写"已恢复生产"。

## 输出骨架与尾部自检

只输出一个 JSON 对象，顶层三个键，顺序照写：

```text
{
  "diagnosis": { "window_status": "...", "fault_types": [...], "observed_end_state": "...",
                 "summary": "...", "evidence": [ { "file": "...", "locator": "...", "observation": "..." } ],
                 "recommendations": [ "..." ] },
  "recovery_plan": { "decision": "...", "preferred_action": "resume_conveyor | start_cooling | null", "reason": "……" },
  "limitations": [ "..." ]
}
```

- `recovery_plan` **只有** `decision` / `preferred_action` / `reason` 三个键。`reason` 的字符串写完后，是 `"` 直接接 `}`（**这里不加逗号**）；`recovery_plan` 的 `}` 之后再写 `,` 和 `"limitations"`。写这一段时慢一点，别在 `reason` 结尾顺手补一个逗号。
- `limitations` 数组的最后一个元素之后不加逗号；`evidence` 数组同理。
- `summary` 与 `reason` 追求准，不追求长（各 2～6 句）：长字符串结尾最容易多写一个逗号，而一个多余逗号会让整份报告无法解析。
- 发出前静默自检：① 全文没有 `,}` 或 `,]`；② `{}`、`[]` 成对；③ 顶层只有契约里的三个键；④ 首字符 `{`、末字符 `}`，没有代码围栏、没有前后解释文字。
