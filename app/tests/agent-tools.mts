/**
 * 受控设备工具（MCP）端到端检查 —— npm run check:agent。
 *
 * 起的是真实链路：应用自带的 MCP 客户端 → src/tools/wrapper-server.ts（stdio 服务进程）→
 * interfaces/ 下两个 Python 演示 MCP → 共享的演示状态库。只走工具调用，不调用任何模型。
 *
 * 断言的是"模型能真的调用、调用真的受控"：
 * - 只读工具不产生任何写：状态版本不变、接口审计里没有 write 行；
 * - 写工具执行一次就是一次（重试不会第二次执行），并带限时状态读回；
 * - 请求号纪律：同一个 request_id 绝不会配不同的 expected_revision（否则接口会判成冲突整条丢弃）；
 * - 反查不到案例时如实报错，不猜、不执行；
 * - 散热 → 再查许可 → 另行恢复输送的顺序在真实工具链上成立。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
// 只取类型：客户端的值在设置好环境变量之后再动态 import。
import type { McpStdioClient } from '../src/tools/mcp.ts';

const repo = path.resolve(import.meta.dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-agent-tools-'));
const database = path.join(temporary, 'device.sqlite3');

process.env.LINE_RECOVERY_STATE_DB = database;
process.env.LR_RUNTIME_DIR = path.join(temporary, 'runtime');
process.env.LR_DATA_ROOT = path.join(temporary, 'agent');
process.env.LR_INTERFACES_CONFIG = path.join(repo, 'app/config/interfaces.json');
process.env.DEEPSEEK_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
// 与生产一致：整个 app/ 可以搬走，路径与 cwd 无关。
process.chdir(repo);

/**
 * 本次演示 run 的 id：接口侧的审计行按 run 保留，reset 不会清掉旧行
 * （manage.py 的说明是 "Previous state and audit are retained on reset"），
 * 所以要断言"这次动作发了没有写"，必须只看当前 run 的行。
 */
let run = '';

/** 只能用 profile：manage.py 的 --profile 与 --fixture 互斥。 */
function manage(command: string, profile: string): void {
  run = runOf(
    execFileSync('python3', [path.join(repo, 'interfaces/manage.py'), '--db', database, command, '--profile', profile, '--time-scale', '100'], {
      encoding: 'utf8',
      env: { ...process.env, LINE_RECOVERY_MODE: 'dry_run' },
    }),
  );
}

/** 用接口侧自己的 profile 造一份带执行点竞态的 fixture（放在临时目录，不动仓库资料）。 */
function manageFixture(command: string, fixturePath: string): void {
  run = runOf(
    execFileSync('python3', [path.join(repo, 'interfaces/manage.py'), '--db', database, command, '--fixture', fixturePath, '--time-scale', '100'], {
      encoding: 'utf8',
      env: { ...process.env, LINE_RECOVERY_MODE: 'dry_run' },
    }),
  );
}

function runOf(output: string): string {
  return String(JSON.parse(output).run_id);
}

function pythonAudit(): any[] {
  return JSON.parse(execFileSync('python3', [path.join(repo, 'interfaces/manage.py'), '--db', database, 'audit'], { encoding: 'utf8' }));
}

let checks = 0;
function check(ok: unknown, message: string): void {
  checks += 1;
  assert(ok, message);
}

const { loadExample, caseDir } = await import('../src/case/store.ts');
const { McpStdioClient: McpClient } = await import('../src/tools/mcp.ts');
const { readAudit } = await import('../src/audit.ts');
const { readDecisions } = await import('../src/tools/decisions.ts');

manage('init', 'power-return');
const meta = loadExample();
const caseId = meta.caseId;
const workspace = caseDir(caseId);

/** 包装服务进程的环境与生产一致：SDK 的安全白名单 + 条目里显式声明的 LR_*。 */
function wrapperEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LINE_RECOVERY_MODE: 'dry_run',
    LINE_RECOVERY_STATE_DB: database,
  };
  for (const key of ['LR_RUNTIME_DIR', 'LR_INTERFACES_CONFIG', 'LR_DATA_ROOT', 'LR_INTERFACES_DIR', 'LR_CONTRACTS_DIR', 'LR_EXAMPLE_DIR']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function wrapperClient(cwd: string): McpStdioClient {
  return new McpClient({
    command: process.execPath,
    args: [path.join(repo, 'app/node_modules/tsx/dist/cli.mjs'), path.join(repo, 'app/src/tools/wrapper-server.ts')],
    cwd,
    env: wrapperEnv(),
    timeoutMs: 90_000,
  });
}

async function callTool(client: McpStdioClient, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; payload: any }> {
  const result = await client.callTool(name, args, 90_000);
  return { isError: result.isError, payload: result.structured ?? null };
}

function agentAudit(): any[] {
  return readAudit(caseId).filter((r) => r.actor === 'agent');
}

const writes = (status?: string) =>
  pythonAudit().filter((r) => r.run_id === run && r.phase === 'write' && (status ? r.result?.status === status : true));

const client = wrapperClient(workspace);
const stray = wrapperClient(temporary);

try {
  /* ── 工具清单 ─────────────────────────────────────────────────────────── */
  const tools = await client.connect();
  check(tools.length === 4, `工具清单 4 项，实际 ${tools.length}`);
  check(
    ['get_cooling_status', 'get_device_status', 'resume_conveyor', 'start_cooling'].every((n) => tools.some((t) => t.name === n)),
    '四个受控工具都在：' + tools.map((t) => t.name).join(','),
  );
  for (const tool of tools) {
    const readOnly = tool.annotations?.readOnlyHint === true;
    const expectedReadOnly = tool.name.startsWith('get_');
    check(readOnly === expectedReadOnly, `${tool.name} readOnlyHint=${String(tool.annotations?.readOnlyHint)}`);
    check(JSON.stringify(tool.inputSchema) === JSON.stringify({ type: 'object', additionalProperties: false, properties: {} }), `${tool.name} 只接受空入参`);
  }
  const withArgs = await callTool(client, 'resume_conveyor', { device_id: 'CV-01', expected_revision: 200 });
  check(withArgs.isError && withArgs.payload.error === 'TOOL_REJECTED', '写工具拒绝任何入参：' + JSON.stringify(withArgs.payload).slice(0, 160));

  /* ── 只读查询不产生写 ─────────────────────────────────────────────────── */
  manage('reset', 'power-return');
  const beforeStatus = await callTool(client, 'get_device_status');
  check(!beforeStatus.isError, '读状态成功：' + JSON.stringify(beforeStatus.payload).slice(0, 200));
  check(beforeStatus.payload.state.source === 'demo_backend', 'source=demo_backend');
  check(beforeStatus.payload.state.device_id === 'CV-01', 'device_id=CV-01');
  const coolingStatus = await callTool(client, 'get_cooling_status');
  check(!coolingStatus.isError && coolingStatus.payload.state.cabinet_temperature_c === 35, '读散热状态共享同一份状态');
  check(beforeStatus.payload.state.revision === coolingStatus.payload.state.revision, '两次查询同一版本');
  check(writes().length === 0, `只读查询后没有任何写：write 行 ${writes().length}`);
  const queryRows = agentAudit().filter((r) => r.phase === 'query');
  check(queryRows.length >= 2, `只读查询各留一条 query 审计（${queryRows.length} 条）`);
  check(queryRows.every((r) => r.request_id === null && r.expected_revision === null), 'query 审计里没有请求号/版本，即没有隐式写');

  /* ── 写工具：执行一次、限时读回、结果进报告用的决策记录 ───────────────── */
  const revisionBefore = beforeStatus.payload.state.revision;
  const resume = await callTool(client, 'resume_conveyor');
  check(!resume.isError, '恢复请求受理：' + JSON.stringify(resume.payload).slice(0, 200));
  check(resume.payload.status === 'production_confirmed', `限时读回达到生产恢复：${resume.payload.status}`);
  check(resume.payload.readback.polls >= 1 && resume.payload.readback.polls <= resume.payload.readback.polls_limit, '读回轮询在预算内：' + JSON.stringify(resume.payload.readback));
  check(resume.payload.readback.timed_out === false, '读回到达最终阶段，未超预算');
  check(resume.payload.latest_state.outfeed_count_total > 1019, '产出计数有新证据：' + resume.payload.latest_state.outfeed_count_total);
  check(resume.payload.replayed === false, '第一次请求不是幂等重放');
  check(writes('accepted').filter((r) => r.action === 'resume_conveyor').length === 1, '接口侧只受理了一次恢复写');
  const requestRows = agentAudit().filter((r) => r.phase === 'request' && r.action === 'resume_conveyor');
  check(requestRows.length === 1 && requestRows[0].expected_revision === revisionBefore, `写调用带上了动作前版本 ${revisionBefore}`);
  check(agentAudit().some((r) => r.phase === 'feedback' && r.readback), '反馈阶段记下了读回预算与次数');

  /* ── 重试不会第二次执行动作 ───────────────────────────────────────────── */
  const retry = await callTool(client, 'resume_conveyor');
  check(writes('accepted').filter((r) => r.action === 'resume_conveyor').length === 1, '重试后接口侧仍然只受理过一次恢复写');
  check(retry.payload.reason_code !== 'COMMAND_ACCEPTED', `重试没有再次受理：${retry.payload.reason_code}`);

  /* ── 请求号纪律：同号不同版本会被接口整条丢掉，这里不允许发生 ─────────── */
  const byRequest = new Map<string, Set<number>>();
  for (const row of agentAudit()) {
    if (!row.request_id) continue;
    const set = byRequest.get(row.request_id) ?? new Set<number>();
    set.add(row.expected_revision as number);
    byRequest.set(row.request_id, set);
  }
  check(byRequest.size >= 1, '审计里出现了写请求号');
  check([...byRequest.values()].every((s) => s.size === 1), '同一个 request_id 只配同一个 expected_revision');

  /* ── 反查不到案例：如实报错，不猜不执行 ──────────────────────────────── */
  await stray.connect();
  const orphan = await callTool(stray, 'get_device_status');
  check(orphan.isError && orphan.payload.error === 'CASE_NOT_RESOLVED', '非案例目录下的调用被如实拒绝：' + JSON.stringify(orphan.payload).slice(0, 160));
  const writesBeforeOrphan = writes().length;
  const orphanWrite = await callTool(stray, 'resume_conveyor');
  check(orphanWrite.isError && orphanWrite.payload.error === 'CASE_NOT_RESOLVED', '非案例目录下不执行任何动作');
  check(writes().length === writesBeforeOrphan, '拒绝时没有产生任何写');

  /* ── 散热 → 再查许可 → 另行恢复输送 ──────────────────────────────────── */
  manage('reset', 'cooling');
  const hot = await callTool(client, 'get_cooling_status');
  check(hot.payload.state.temperature_recovery_ready === false && hot.payload.state.run_resume_permitted === false, '散热案例初始温度未达标、许可未恢复');
  const blockedResume = await callTool(client, 'resume_conveyor');
  check(blockedResume.payload.attempted === false && blockedResume.payload.reason_code === 'PRECONDITION_FAILED', '温度未达标时先请求恢复会被挡住：' + JSON.stringify(blockedResume.payload).slice(0, 160));
  check(writes().filter((r) => r.action === 'resume_conveyor').length === 0, '被挡住时没有发出写');
  const cooling = await callTool(client, 'start_cooling');
  check(!cooling.isError, '散热请求受理：' + JSON.stringify(cooling.payload).slice(0, 200));
  check(cooling.payload.status === 'temperature_ready', `限时读回到达温度恢复条件：${cooling.payload.status}`);
  check(cooling.payload.readback.polls >= 1, '散热读回按真实时间等：' + JSON.stringify(cooling.payload.readback));
  const afterCooling = await callTool(client, 'get_cooling_status');
  check(afterCooling.payload.state.run_resume_permitted === true, '后端自行恢复了运行许可');
  const resumeAfterCooling = await callTool(client, 'resume_conveyor');
  check(resumeAfterCooling.payload.status === 'production_confirmed', `散热后可另行恢复输送：${resumeAfterCooling.payload.status}`);
  const coolingWrites = writes('accepted');
  check(coolingWrites.filter((r) => r.action === 'start_cooling').length === 1, '散热动作也只执行一次');
  check(coolingWrites.filter((r) => r.action === 'resume_conveyor').length === 1, '散热后的恢复输送是另一次真实动作');
  check(readDecisions(caseId).resume_conveyor?.request_id !== readDecisions(caseId).start_cooling?.request_id, '两个动作各有请求号');

  /* ── 同一请求的重试：接口按请求号幂等返回原结果，不重复执行 ───────────── */
  // 用接口侧自己的 power-return 初始状态加一步"执行点竞态"：地址电压掉到允许范围外，
  // 而这一步只在第一次写调用时生效，于是能得到"同一版本上的失败请求"，正是重试要覆盖的场景。
  const fixturePath = path.join(temporary, 'replay-fixture.json');
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import json,sys',
        `sys.path.insert(0, ${JSON.stringify(path.join(repo, 'interfaces'))})`,
        'from shared.profiles import profile',
        "f=profile('power-return')",
        "state=dict(f['initial_state']); state['drive_supply_voltage_v']=22.0",
        "f['steps']=[{'trigger':'before_first_resume_write','action':'resume_conveyor','state':state}]",
        `json.dump(f, open(${JSON.stringify(fixturePath)}, 'w'))`,
      ].join('\n'),
    ],
    { stdio: 'pipe' },
  );
  manageFixture('reset', fixturePath);
  const first = await callTool(client, 'resume_conveyor');
  check(first.payload.status === 'rejected' && first.payload.reason_code === 'REVISION_CONFLICT', `执行点竞态让第一次请求被拒：${first.payload.reason_code}`);
  const second = await callTool(client, 'resume_conveyor');
  check(second.payload.status === 'rejected' && second.payload.reason_code === 'PRECONDITION_FAILED', `重读后仍不满足后端条件：${second.payload.reason_code}`);
  const third = await callTool(client, 'resume_conveyor');
  // 重放时 reason_code 仍是接口返回的原结果，是否重放由 replayed / replay_note 明说。
  check(
    third.payload.replayed === true && third.payload.reason_code === 'PRECONDITION_FAILED',
    `同一版本的重试命中幂等重放、结果与上次一致：${third.payload.reason_code}`,
  );
  check(typeof third.payload.replay_note === 'string', '重放时明确说明本次没有第二次执行动作');
  const thirdRow = agentAudit().filter((r) => r.phase === 'request').at(-1);
  check(thirdRow?.outcome === 'IDEMPOTENT_REPLAY', '审计如实记成 IDEMPOTENT_REPLAY');
  check(writes('accepted').length === 0, '这三个请求没有任何一次被受理执行');
  await pause(50);
  check(readDecisions(caseId).resume_conveyor?.operation_id !== null, '决策记录保留了接口返回的操作号，供重试对照');

  console.log(JSON.stringify({ passed: true, checks, transport: 'MCP stdio', model_calls: 0, live_device_calls: 0 }));
} finally {
  await client.close().catch(() => {});
  await stray.close().catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
