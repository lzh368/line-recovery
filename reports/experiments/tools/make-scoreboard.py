"""Assemble <experiment>/scoreboard.yaml from the per-split score files.

Field shape follows the `agent-optimization` Skill's scoreboard record (time / version / provider /
model_id / thinking_level / summary_title / summary / score / cost / duration_ms / cases[].runs[]).
Additional fields for this Benchmark:
  * `split` — a dataset version can carry more than one fixed group, so an entry has to say which
    one it evaluated;
  * every value is computed here from the stored per-case scores and run.json files, and averages
    ignore null costs (rounding: score 2dp, cost 6dp, duration_ms nearest integer).
Cost is null everywhere: the app's session traces record token usage but no cost, and the Skill
forbids inferring cost from external prices.

Usage:
  python3 make-scoreboard.py --experiment <experiment dir> [--out <path>] <version>:<split>[:<title>:<summary>] ...
  python3 make-scoreboard.py --experiment reports/experiments/round2 --out reports/experiments/round2/scoreboard.yaml v1:test v2:test
"""
import argparse, json, pathlib, datetime

PROVIDER = "deepseek"
MODEL = "deepseek-flash"
THINKING = "xhigh"


def num(x, nd):
    """Round to `nd` decimals; emit ints for whole numbers so `score: 100` stays readable."""
    if x is None:
        return None
    v = round(x + 0.0, nd)
    return int(v) if float(v).is_integer() else v


def mean_int(values):
    known = [v for v in values if v is not None]
    return None if not known else round(sum(known) / len(known))


def root_trace_session(run_dir):
    """Fallback binding: the single root Test Trace of that Run (same binding rule as the worker)."""
    traces = sorted((run_dir / "data").glob("**/traces/*/*.jsonl"))
    return traces[0].name.split("_")[0] if len(traces) == 1 else None


def run_meta(run_dir):
    """session_id / duration_ms of one Run, straight from that Run's run.json."""
    p = run_dir / "run.json"
    if not p.exists():
        return None, None
    d = json.loads(p.read_text("utf8"))
    sid = (d.get("runtime") or {}).get("session_id") or d.get("session_id") or root_trace_session(run_dir)
    return sid, d.get("duration_ms")


def entry_for(exp, version, split, title, summary):
    data = json.loads((exp / "scores" / version / f"{split}-cases.json").read_text("utf8"))
    cases = []
    for c in data["cases"]:
        cid = c["case_id"]
        sid, dur = run_meta(exp / "runs" / version / cid)
        cases.append(
            {
                "case": cid,
                "score": num(c["score"], 2),
                "cost": None,
                "duration_ms": dur,
                "runs": [{"score": num(c["score"], 2), "cost": None, "duration_ms": dur, "session_id": sid}],
            }
        )
    scores = [c["score"] for c in cases]
    return {
        "time": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "version": version,
        "split": split,
        "dataset": data.get("dataset"),
        "provider": PROVIDER,
        "model_id": MODEL,
        "thinking_level": THINKING,
        "summary_title": title,
        "summary": summary,
        "score": num(sum(scores) / len(scores), 2),
        "cost": None,
        "duration_ms": mean_int([c["duration_ms"] for c in cases]),
        "cases": cases,
    }


def block(key, txt, indent):
    lines = txt.strip().splitlines() or [""]
    out = [f"{indent}{key}: >-"]
    out += [f"{indent}  {ln}" for ln in lines]
    return "\n".join(out)


def render(entries):
    chunks = []
    for e in entries:
        case_lines = []
        for c in e["cases"]:
            case_lines += [
                f"    - case: {c['case']}",
                f"      score: {c['score']}",
                f"      cost: {'null' if c['cost'] is None else c['cost']}",
                f"      duration_ms: {c['duration_ms']}",
                "      runs:",
                f"        - score: {c['runs'][0]['score']}",
                f"          cost: {'null' if c['runs'][0]['cost'] is None else c['runs'][0]['cost']}",
                f"          duration_ms: {c['runs'][0]['duration_ms']}",
                f"          session_id: {c['runs'][0]['session_id']}",
            ]
        chunks.append(
            "\n".join(
                [
                    f"- time: {e['time']}",
                    f"  version: {e['version']}",
                    f"  split: {e['split']}",
                    f"  dataset: {e['dataset']}",
                    f"  provider: {e['provider']}",
                    f"  model_id: {e['model_id']}",
                    f"  thinking_level: {e['thinking_level']}",
                    block("summary_title", e["summary_title"], "  "),
                    block("summary", e["summary"], "  "),
                    f"  score: {e['score']}",
                    f"  cost: {'null' if e['cost'] is None else e['cost']}",
                    f"  duration_ms: {e['duration_ms']}",
                    "  cases:",
                    *case_lines,
                ]
            )
        )
    return "\n".join(chunks) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--experiment", required=True)
    ap.add_argument("--out")
    ap.add_argument("specs", nargs="+")
    a = ap.parse_args()
    exp = pathlib.Path(a.experiment).resolve()
    out = pathlib.Path(a.out) if a.out else exp / "scoreboard.yaml"
    entries = []
    for spec in a.specs:
        parts = spec.split(":", 3)
        version, split = parts[0], parts[1]
        title = parts[2] if len(parts) > 2 else f"{version} · {split} 评测"
        summary = parts[3] if len(parts) > 3 else ""
        entries.append(entry_for(exp, version, split, title, summary))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(entries), "utf8")
    print(out)
    for e in entries:
        print(f"  {e['version']}/{e['split']}: score={e['score']} cases={len(e['cases'])} duration_ms={e['duration_ms']}")


if __name__ == "__main__":
    main()
