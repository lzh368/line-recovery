---
name: line-recovery-case
description: 产线恢复案例的术语、证据格式与阶段口径——诊断纸箱输送工位上传资料时使用。
short_description: 案例术语与证据口径。
short_description_zh: 案例术语与证据口径。
version: 1
updated: 2026-09-15T00:00:00Z
---

# 产线恢复案例口径

## 两个诊断词汇

- `power_interruption_stop`：该时间窗出现过供电中断并导致停机。结束时可以已经来电，但输送仍停机——这是常见形态，不矛盾。
- `cabinet_overtemperature_pause`：达到公开温控暂停条件并有对应暂停记录。仅温度偏高不能排除其他原因。

原因证据不足时 `fault_types` 留空、`window_status` 用 `insufficient_evidence`，并在 `limitations` 说明缺什么；不要为了凑类型而猜测。`fault_types` 非空时 `window_status` 必须是 `abnormal`。

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
| `cooling_enabled` / `cooling_fan_running` | 风机命令 / 风机实际反馈 |
| `temperature_recovery_ready` | 由可信后端按连续有效温度计算，不能由资料或模型自报 |
| `accumulation` 在制箱数 | 入口累计 − 出口累计 − 人工移出累计；人工移出不算出口产出 |

## 阶段词汇（后端按真实工具轨迹使用）

`not_attempted` 未执行 → `requested` 已提交 → `cooling_started` 风机确认 → `temperature_ready` 温度持续达标 → `running_confirmed` 运动确认 → `production_confirmed` 新的产出证据。受理不等于执行完成；风机运行不等于温度下降；带速恢复不等于出口恢复产出。
