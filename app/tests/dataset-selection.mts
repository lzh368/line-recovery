import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { datasetCases, datasetRoot, REPO_ROOT } from "../eval/lib.mts";

const root = datasetRoot("dataset");
const selected = datasetCases("gate-set-7", "test");
assert.equal(datasetRoot("gate-set-7"), root);
assert.deepEqual(selected.map((item) => item.case_id), [
  "lr_201", "lr_203", "lr_204", "lr_205", "lr_206", "lr_302", "lr_306",
]);
assert.equal(datasetCases("dataset", "optimization").length, 10);
assert.equal(datasetCases("dataset", "test").length, 14);
assert.equal(datasetCases("gate-set-7", "optimization").length, 0);
assert.deepEqual(fs.readdirSync(path.join(REPO_ROOT, "data/gate-set-7")).sort(), [
  "README.md", "split-manifest.json",
]);
const all = new Map(datasetCases("dataset", "test").map((item) => [item.case_id, item]));
for (const item of selected) {
  assert.deepEqual(item, all.get(item.case_id));
  const bytes = fs.readFileSync(path.join(root, item.input, "manifest.json"));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), item.input_manifest_sha256);
  for (const file of ["reference.json", "backend-fixture.json", "source.json"]) {
    const value = JSON.parse(fs.readFileSync(path.join(root, "evaluator", item.split, item.case_id, file), "utf8"));
    assert.equal(value.case_id, item.case_id);
  }
}
console.log(JSON.stringify({ passed: true, optimization_cases: 10, test_cases: 14, regression_cases: 7, model_calls: 0 }));
