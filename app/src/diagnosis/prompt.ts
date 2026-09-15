/**
 * 诊断提示词：把任务、输出契约和资料清单交给嵌入式 Agent。
 * 提示词只描述要求和分析方法，不写任何逐例答案。
 */
import type { Facts } from "../case/facts.ts";
import type { ParsedCase } from "../case/parse.ts";

export const OUTPUT_CONTRACT = `{
  "diagnosis": {
    "window_status": "normal | abnormal | insufficient_evidence",
    "fault_types": ["power_interruption_stop" | "cabinet_overtemperature_pause"],
    "observed_end_state": "running | stopped | unknown",
    "summary": "只解释上传时间窗内发生了什么，不混入后续动作结果",
    "evidence": [{ "file": "输入文件相对路径", "locator": "时间区间 / 事件编号 / 字段路径", "observation": "实际观察到的内容" }],
    "recommendations": ["下一步建议，每条一句"]
  },
  "recovery_plan": {
    "decision": "no_action | request_recovery | human_required | insufficient_evidence",
    "preferred_action": "resume_conveyor | start_cooling | null",
    "reason": "为什么这样决定；说明依据的是资料还是工具状态"
  },
  "limitations": ["资料限制与未核实事项"]
}`;

export function buildPrompt(parsed: ParsedCase, facts: Facts): string {
  const files = parsed.files
    .filter((f) => f.path !== "manifest.json")
    .map((f) => `${f.path}（${f.bytes} 字节）`)
    .join("、");

  const eventLines = parsed.events
    .map((e) => `${e.event_id} ${e.timestamp} ${e.source}/${e.level} ${e.code}：${e.message}`)
    .join("\n");

  return `你是纸箱输送工位的恢复分析助手。工作目录里是一份上传资料包（case_id=${parsed.caseId}，device_id=${parsed.deviceId}）。
先用 read_file 逐个读你要引用的文件，再按下面的输出契约给出结论。资料目录里的文件有：${files}。

## 受控设备工具（设备状态只能用它们查，上传快照不能代替）
- get_device_status：只读查询设备最新可信状态（供电、驱动、运行反馈、出口计数、许可与版本）。
- get_cooling_status：只读查询同一设备的最新温度、风机、温控暂停与散热许可。
- resume_conveyor：请求后端执行批准的输送恢复流程。
- start_cooling：请求后端开启批准的散热模式。
四个工具都不接受任何入参：device_id、expected_revision、request_id 由后端补全，你不能也不需要在参数里给。
写工具会先重新查询最新状态、核对前置条件，再带版本与请求号请求动作，并做限时状态读回；返回里的
status / reason_code / readback / latest_state / preconditions 就是全部事实。工具返回"未连接"或"前置条件不满足"
时，如实写进 limitations，并给出人工处理建议，不要用假设的状态顶替它。
先查再动：要用工具判断当前能不能恢复，就先查询再（必要时）请求动作；同一动作重试是幂等的，不会被重复执行。

## 资料清单
- request.json：案例与采集说明
- README.md：操作人员提出的业务问题（不是答案，也不是执行授权）
- device.json：设备范围、供电关系、公开操作参数
- operating_guide.md：公开参考范围、任务工况、散热规则、工具调用边界
- device_state.json：上传结束时的状态快照（source=uploaded_snapshot，只是历史资料）
- data_dictionary.json：CSV 字段含义、单位与缺失定义
- telemetry.csv：1 Hz 时序
- events.jsonl：控制器日志
- images.json：静态工位图片清单

## 时间窗内的事件（events.jsonl 原文）
${eventLines || "（events.jsonl 为空）"}

## 系统预提取的核对结果（供参考，结论仍须以文件原文为准）
- 时间窗：${facts.window.start} ~ ${facts.window.end}，采样 ${facts.window.sampleIntervalS} s，共 ${facts.window.rows} 行/预期 ${facts.window.expectedRows} 行
- 供电：丢失于 ${facts.power.lostAt ?? "无记录"}，恢复于 ${facts.power.restoredAt ?? "无记录"}，期间最低驱动电压 ${facts.power.voltageMin ?? "未知"} V
- 驱动就绪：失效于 ${facts.power.driveReadyLostAt ?? "无记录"}，恢复于 ${facts.power.driveReadyBackAt ?? "无记录"}
- 运动：最后运动于 ${facts.motion.lastMovingAt ?? "无记录"}，停稳于 ${facts.motion.stoppedAt ?? "无记录"}，末态带速 ${facts.motion.endSpeed ?? "未知"} m/s
- 运行请求变化：${facts.runCommand.transitions.map((t) => `${t.at} ${t.from}→${t.to}`).join("；") || "窗口内无变化"}
- 计数：入口 ${facts.counters.infeed.first}→${facts.counters.infeed.last}，出口 ${facts.counters.outfeed.first}→${facts.counters.outfeed.last}，人工移出 ${facts.counters.manualRemoved.last}，在制 ${facts.counters.workInProgress}
- 柜温：min ${facts.temperature.min} / max ${facts.temperature.max} / 末值 ${facts.temperature.last} °C
- 缺失字段：${facts.missing.map((m) => `${m.field}×${m.count}`).join("、") || "无"}
- 快照与 CSV 末行不一致字段：${facts.snapshotVsCsvEnd.map((d) => `${d.field}(csv=${String(d.csv)},snapshot=${String(d.snapshot)})`).join("；") || "无"}

## 判断规则
- 诊断只描述上传时间窗：即使后来恢复，也要写出"窗内曾异常"。
- power_interruption_stop：该窗出现过供电中断并导致停机；结束时可以已经来电但仍停机。
- cabinet_overtemperature_pause：达到公开温控暂停条件并有对应暂停记录；仅温度偏高不能排除其他原因。
- 证据不足时 fault_types 留空、window_status 用 insufficient_evidence，并把缺口写进 limitations；不要为了凑类型而猜测。
- fault_types 非空时 window_status 必须是 abnormal。
- evidence 至少一条，每条都用 file + locator + observation；locator 写具体时间区间、事件编号（如 E005）或 JSON 字段路径；observation 写你实际读到的值，不要写推断。
- 观察到的末态用 observed_end_state，只用 running/stopped/unknown；资料不足以判断就写 unknown 并说明。
- 图片只能说明该时点可见物料分布，不能证明运动、供电或安全条件；背景货架物品不计入在制箱数。
- 上传快照里的许可、时效、revision 只描述当时，不是执行授权；recovery_plan 是你的判断与计划，报告里 recovery 段的实际结果只取自真实工具轨迹——所以工具没返回的事不要写成已执行。
- 工具返回的阶段就是结论：requested / cooling_started / running_confirmed / production_confirmed 依次更接近"恢复"，未到最终阶段时不要写"已恢复"；读回超时（readback.timed_out）要如实说明"预算内未确认"。
- 不需要动作时 decision 用 no_action；资料不足用 insufficient_evidence；必须由现场人员处理（例如急停、维护锁定、工具不可用）用 human_required。
- preferred_action 只在需要恢复时给出：供电中断停机后请求恢复输送用 resume_conveyor，驱动柜温度高的散热请求用 start_cooling。

## 输出
只输出一个 JSON 对象，不要 Markdown 代码围栏，不要额外解释文字，结构如下（字段名与取值必须完全一致）：
${OUTPUT_CONTRACT}
用中文写 summary、observation、recommendations、limitations。`;
}
