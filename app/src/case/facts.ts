/**
 * 资料事实提取：把上传资料里的客观记录整理成前端可读的"核对结果"。
 *
 * 这里**不做原因判断**，只回答"资料里记录了什么"：
 * 供电何时丢失/恢复、带速何时停稳、运行请求有无、计数增量、温度区间、缺失字段、
 * 快照与 CSV 末行是否一致。停机原因由 Agent 诊断给出（见 src/diagnosis/）。
 */
import type { ParsedCase, TelemetryRow } from "./parse.ts";

export interface Range<T> {
  first: T;
  last: T;
}

export interface Facts {
  window: {
    start: string | null;
    end: string | null;
    sampleIntervalS: number | null;
    rows: number;
    expectedRows: number | null;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    gaps: { after: string; before: string; missingSamples: number }[];
  };
  power: {
    lostAt: string | null;
    restoredAt: string | null;
    voltageMin: number | null;
    driveReadyLostAt: string | null;
    driveReadyBackAt: string | null;
    endUpstreamAvailable: boolean | null;
    endDrivePowerEnabled: boolean | null;
  };
  motion: {
    lastMovingAt: string | null;
    stoppedAt: string | null;
    endSpeed: number | null;
    endMotorCurrent: number | null;
  };
  runCommand: {
    transitions: { at: string; from: boolean | null; to: boolean | null }[];
    endValue: boolean | null;
  };
  counters: {
    infeed: Range<number | null> & { delta: number | null };
    outfeed: Range<number | null> & { delta: number | null };
    manualRemoved: Range<number | null> & { delta: number | null };
    workInProgress: number | null;
  };
  temperature: {
    min: number | null;
    max: number | null;
    last: number | null;
    samplesAtOrAboveWarning: number;
    samplesAtOrAbovePause: number;
  };
  missing: { field: string; count: number }[];
  snapshot: {
    source: string | null;
    capturedAt: string | null;
    expiresAt: string | null;
    revision: number | null;
    fields: Record<string, unknown>;
  };
  snapshotVsCsvEnd: { field: string; csv: unknown; snapshot: unknown }[];
  snapshotOnlyFields: { field: string; value: unknown; note: string }[];
}

const num = (row: TelemetryRow, field: string): number | null => {
  const value = row.values[field];
  return typeof value === "number" ? value : null;
};
const bool = (row: TelemetryRow, field: string): boolean | null => {
  const value = row.values[field];
  return typeof value === "boolean" ? value : null;
};

function timeDeltaSeconds(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 1000;
}

/** CSV 与快照字段对照（快照是上传时的独立记录，两者描述同一时点）。 */
const CROSS_CHECK_FIELDS = [
  "controller_online",
  "upstream_power_available",
  "drive_power_enabled",
  "drive_ready",
  "run_command",
  "infeed_enabled",
  "operating_mode",
  "production_requested",
  "belt_speed_m_s",
  "infeed_count_total",
  "outfeed_count_total",
  "manual_removed_count_total",
  "cabinet_temperature_c",
  "emergency_stop_active",
  "maintenance_lockout",
  "guard_closed",
  "zone_clear",
  "downstream_ready",
  "unresolved_accumulation",
];

const SNAPSHOT_ONLY_NOTES: Record<string, string> = {
  run_resume_permitted: "上传副本里的许可只是记录，不授予执行权限；执行前必须由工具重新查询",
  cooling_enabled: "风机命令，只有后端工具返回时才代表当前状态",
  cooling_fan_running: "风机实际运行反馈，只有后端工具返回时才代表当前状态",
  cooling_fan_fault: "风机故障反馈",
  cooling_control_permitted: "后端散热控制许可，上传副本不授权",
  thermal_pause_active: "温控暂停状态",
  temperature_recovery_ready: "由可信后端按连续温度计算，不由资料或模型自报",
  revision: "后端维护的状态版本，写调用前必须重新查询并匹配",
};

export function computeFacts(parsed: ParsedCase): Facts {
  const rows = parsed.telemetry;
  const request = parsed.request ?? {};
  const snapshot = parsed.deviceState ?? {};

  const expectedRows = (() => {
    const start = Date.parse(String(request.window_start ?? ""));
    const end = Date.parse(String(request.window_end ?? ""));
    const interval = Number(request.sample_interval_s ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !interval) return null;
    return Math.round((end - start) / 1000 / interval) + 1;
  })();

  const gaps: Facts["window"]["gaps"] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const interval = Number(request.sample_interval_s ?? 1) || 1;
    const diff = timeDeltaSeconds(rows[i - 1]!.timestamp, rows[i]!.timestamp);
    if (diff > interval) {
      gaps.push({
        after: rows[i - 1]!.timestamp,
        before: rows[i]!.timestamp,
        missingSamples: Math.round(diff / interval) - 1,
      });
    }
  }

  // 供电：以"上游电源有效反馈"由 1 变 0 作为断电记录。
  let lostAt: string | null = null;
  let restoredAt: string | null = null;
  let driveReadyLostAt: string | null = null;
  let driveReadyBackAt: string | null = null;
  let voltageMin: number | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const available = bool(row, "upstream_power_available");
    if (available === false && lostAt === null) lostAt = row.timestamp;
    if (available === true && lostAt !== null && restoredAt === null) restoredAt = row.timestamp;
    const ready = bool(row, "drive_ready");
    const previousReady = i > 0 ? bool(rows[i - 1]!, "drive_ready") : null;
    if (ready === false && previousReady === true && driveReadyLostAt === null) driveReadyLostAt = row.timestamp;
    if (ready === true && driveReadyLostAt !== null && driveReadyBackAt === null) driveReadyBackAt = row.timestamp;
    if (lostAt !== null && restoredAt === null) {
      const voltage = num(row, "drive_supply_voltage_v");
      if (voltage !== null && (voltageMin === null || voltage < voltageMin)) voltageMin = voltage;
    }
  }

  // 运动：带速 > 0.02 视为运动，≤ 0.02 视为停稳（operating_guide 的公开参考）。
  let lastMovingAt: string | null = null;
  let stoppedAt: string | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const speed = num(rows[i]!, "belt_speed_m_s");
    if (speed !== null && speed > 0.02) lastMovingAt = rows[i]!.timestamp;
  }
  if (rows.length && num(rows[0]!, "belt_speed_m_s") !== null && (num(rows[0]!, "belt_speed_m_s") ?? 0) > 0.02) {
    for (let i = 0; i < rows.length; i += 1) {
      const speed = num(rows[i]!, "belt_speed_m_s");
      const previous = i > 0 ? num(rows[i - 1]!, "belt_speed_m_s") : null;
      if (speed !== null && speed <= 0.02 && previous !== null && previous > 0.02) {
        stoppedAt = rows[i]!.timestamp;
        break;
      }
    }
  }

  const transitions: Facts["runCommand"]["transitions"] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const previous = bool(rows[i - 1]!, "run_command");
    const current = bool(rows[i]!, "run_command");
    if (previous !== current) transitions.push({ at: rows[i]!.timestamp, from: previous, to: current });
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const infeed = { first: first ? num(first, "infeed_count_total") : null, last: last ? num(last, "infeed_count_total") : null };
  const outfeed = { first: first ? num(first, "outfeed_count_total") : null, last: last ? num(last, "outfeed_count_total") : null };
  const manual = { first: first ? num(first, "manual_removed_count_total") : null, last: last ? num(last, "manual_removed_count_total") : null };
  const delta = (r: { first: number | null; last: number | null }) =>
    r.first === null || r.last === null ? null : r.last - r.first;

  const temperatures = rows.map((r) => num(r, "cabinet_temperature_c")).filter((v): v is number => v !== null);
  const warning = Number(parsed.device?.cooling?.warning_temperature_c ?? 50);
  const pause = Number(parsed.device?.cooling?.pause_temperature_c ?? 60);

  const missing = parsed.telemetryHeader
    .filter((field) => field !== "timestamp")
    .map((field) => ({
      field,
      count: rows.filter((r) => r.values[field] === null || r.values[field] === undefined).length,
    }))
    .filter((entry) => entry.count > 0);

  const snapshotVsCsvEnd: Facts["snapshotVsCsvEnd"] = [];
  if (last) {
    for (const field of CROSS_CHECK_FIELDS) {
      const csvValue = last.values[field];
      const snapshotValue = snapshot[field];
      if (csvValue === undefined || snapshotValue === undefined) continue;
      if (String(csvValue) !== String(snapshotValue)) {
        snapshotVsCsvEnd.push({ field, csv: csvValue, snapshot: snapshotValue });
      }
    }
  }

  const snapshotOnlyFields = Object.keys(SNAPSHOT_ONLY_NOTES)
    .filter((field) => snapshot[field] !== undefined)
    .map((field) => ({ field, value: snapshot[field], note: SNAPSHOT_ONLY_NOTES[field]! }));

  const snapshotFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (["schema_version", "device_id", "source", "captured_at", "expires_at"].includes(key)) continue;
    snapshotFields[key] = value;
  }

  return {
    window: {
      start: (request.window_start as string) ?? null,
      end: (request.window_end as string) ?? null,
      sampleIntervalS: Number.isFinite(Number(request.sample_interval_s)) ? Number(request.sample_interval_s) : null,
      rows: rows.length,
      expectedRows,
      firstTimestamp: first?.timestamp ?? null,
      lastTimestamp: last?.timestamp ?? null,
      gaps,
    },
    power: {
      lostAt,
      restoredAt,
      voltageMin,
      driveReadyLostAt,
      driveReadyBackAt,
      endUpstreamAvailable: last ? bool(last, "upstream_power_available") : null,
      endDrivePowerEnabled: last ? bool(last, "drive_power_enabled") : null,
    },
    motion: {
      lastMovingAt,
      stoppedAt,
      endSpeed: last ? num(last, "belt_speed_m_s") : null,
      endMotorCurrent: last ? num(last, "motor_current_a") : null,
    },
    runCommand: {
      transitions,
      endValue: last ? bool(last, "run_command") : null,
    },
    counters: {
      infeed: { ...infeed, delta: delta(infeed) },
      outfeed: { ...outfeed, delta: delta(outfeed) },
      manualRemoved: { ...manual, delta: delta(manual) },
      workInProgress:
        infeed.last !== null && outfeed.last !== null && manual.last !== null
          ? infeed.last - outfeed.last - manual.last
          : null,
    },
    temperature: {
      min: temperatures.length ? Math.min(...temperatures) : null,
      max: temperatures.length ? Math.max(...temperatures) : null,
      last: temperatures.length ? temperatures[temperatures.length - 1]! : null,
      samplesAtOrAboveWarning: temperatures.filter((t) => t >= warning).length,
      samplesAtOrAbovePause: temperatures.filter((t) => t >= pause).length,
    },
    missing,
    snapshot: {
      source: (snapshot.source as string) ?? null,
      capturedAt: (snapshot.captured_at as string) ?? null,
      expiresAt: (snapshot.expires_at as string) ?? null,
      revision: typeof snapshot.revision === "number" ? snapshot.revision : null,
      fields: snapshotFields,
    },
    snapshotVsCsvEnd,
    snapshotOnlyFields,
  };
}
