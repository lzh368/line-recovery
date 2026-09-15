/**
 * 评测入口（批量组织）：把冻结案例集跑成一个版本的运行矩阵。
 *
 * 纪律（data/dataset/evaluator/README.md）：
 * - 每例一个独立数据库（夹具只由本脚本读入，不进 Agent 工作区）；
 * - 每例一份独立 Agent State 副本（来自版本快照，快照本身只读）；
 * - 每例一次运行（runs=1），失败不剔除、不无限重试；
 * - 基础设施失败单独记成 status=infrastructure_failed，不伪装成有效 Agent 得分。
 *
 * 用法：
 *   npx tsx eval/run-suite.mts --split optimization --version v1 \
 *     --experiment ../reports/experiments/round1 [--dataset dataset] \
 *     [--cases lr_101,lr_102] [--concurrency 3]
 *
 * --dataset 选择案例清单（默认 dataset）；输入和夹具从清单的 data_source 读取，
 * 未指定时使用自身目录。请使用新的 --experiment 输出目录，保留历史成绩。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { APP_ROOT, REPO_ROOT, datasetRoot, datasetCases, parseArgs, required, writeJson } from "./lib.mts";

function runOne(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_ROOT, "node_modules", "tsx", "dist", "cli.mjs"), ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const split = required(args, "split");
  const version = required(args, "version");
  const experiment = path.resolve(required(args, "experiment"));
  const dataset = args.dataset ?? "dataset";
  const concurrency = Number(args.concurrency ?? "1");
  const only = args.cases ? args.cases.split(",").map((c) => c.trim()) : null;

  const stateSnapshot = path.join(experiment, "states", version);
  if (!fs.existsSync(path.join(stateSnapshot, "system_config.yaml"))) {
    throw new Error(`找不到 ${version} 的 Agent State 快照：${stateSnapshot}`);
  }

  const datasetDir = datasetRoot(dataset);
  const selected = datasetCases(dataset, split).filter((c) => !only || only.includes(c.case_id));
  const results: Record<string, unknown>[] = [];
  const queue = [...selected];

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const inputDir = path.join(datasetDir, item.input);
      const fixture = path.join(datasetDir, "evaluator", split, item.case_id, "backend-fixture.json");
      const runDir = path.join(experiment, "runs", version, item.case_id);
      const started = Date.now();
      const outcome = await runOne(
        [
          path.join(APP_ROOT, "eval", "run-case.mts"),
          "--case",
          item.case_id,
          "--input",
          inputDir,
          "--state",
          stateSnapshot,
          "--run",
          runDir,
          "--fixture",
          fixture,
          "--version",
          version,
        ],
        APP_ROOT,
      );
      const record = {
        case_id: item.case_id,
        version,
        exit_code: outcome.code,
        wall_ms: Date.now() - started,
        stdout: outcome.stdout.trim(),
        stderr: outcome.stderr.trim(),
      };
      results.push(record);
      process.stdout.write(`${item.case_id} exit=${outcome.code} ${outcome.stdout.trim() || outcome.stderr.trim()}\n`);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  results.sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)));
  writeJson(path.join(experiment, "runs", version, `suite-${split}.json`), {
    split,
    version,
    dataset,
    dataset_split_manifest: path.relative(REPO_ROOT, path.join(datasetDir, "split-manifest.json")),
    runs_per_case: 1,
    state_snapshot: stateSnapshot,
    state_sha256: fs.existsSync(path.join(experiment, "states", `${version}.sha256`))
      ? path.join(experiment, "states", `${version}.sha256`)
      : null,
    cases: results,
  });
  const failed = results.filter((r) => r.exit_code !== 0);
  process.stdout.write(`完成 ${results.length} 例，非零退出 ${failed.length} 例\n`);
  if (failed.length) process.exitCode = 1;
}

await main();
