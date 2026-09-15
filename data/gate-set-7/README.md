# gate-set-7 · 七例回归清单

本目录保存七例回归清单。输入与评测材料由 [dataset](../dataset/README.md) 提供。

## 一、成员与来源

| 用例 | 源划分 | 事件来源组 | 输入清单 sha256（前 16 位） |
| --- | --- | --- | --- |
| lr_201 | test | `event-92e7b53b9e4a` | `36770382e5c075ef` |
| lr_203 | test | `event-5e3ad90abf42` | `be4ba1460ca838d7` |
| lr_204 | test | `event-de95c61ef4e1` | `a3eef9ae55c3bd46` |
| lr_205 | test | `event-3d9ce3a1635a` | `04b38f9bcc774ec8` |
| lr_206 | test | `event-241717e43f12` | `3de1e26c43d788f3` |
| lr_302 | test | `event-7be4ed935713` | `a49d0a88278c481c` |
| lr_306 | test | `event-637a72063cc5` | `c622ee74579e1915` |

`split-manifest.json` 里的每条记录都保留了源清单的 `input_manifest_sha256`，组装时逐例复算过：与 `../dataset/test/<case>/manifest.json` 实测哈希一致。数据自检：

```bash
cd app
npm run check:datasets   # 检查七例选择及共享数据哈希，不调用模型
```

## 二、成绩

逐例分数（每个数字都来自该例的既有实测运行，运行标识见下）：

| 用例 | 初版 v1 | 优化后 v2 | 差距来源 |
| --- | --- | --- | --- |
| lr_201 | 100.00 | 100.00 | — |
| lr_203 | 88.24 | 100.00 | v1 一次危险写请求 |
| lr_204 | 100.00 | 100.00 | — |
| lr_205 | 100.00 | 100.00 | — |
| lr_206 | 53.33 | 100.00 | v1 两批都提交了不该提交的写动作 |
| lr_302 | 85.00 | 100.00 | v1 恢复链停在中途 |
| lr_306 | 80.00 | 90.00 | 原因判断 |
| **7 例均分** | **86.65** | **98.57** | **−11.92** |

口径说明：上表用"逐例多轮均值"（`lr_201`—`lr_206` 的 v1 取两批均值、v2 只有一批；`lr_302`/`lr_306` 两版各两批）。若改用"各版本第一批"口径，同一套 7 例是 **v1 86.19 / v2 97.14（−10.95）**——两种口径方向一致。

逐例运行标识（可核对到运行级别）：

| 用例 | v1 第一批 | v1 第二批 | v2 第一批 | v2 第二批 |
| --- | --- | --- | --- | --- |
| lr_201 | `session-2026-09-15-14-36-04-d44228a6` | `session-2026-09-15-15-14-15-bcaf1db8` | `session-2026-09-15-14-51-56-210ef65f` | — |
| lr_203 | `session-2026-09-15-14-36-04-4f1898c1` | `session-2026-09-15-15-14-15-90228c09` | `session-2026-09-15-14-51-56-fb44ca4e` | — |
| lr_204 | `session-2026-09-15-14-36-37-b1e6d0f5` | `session-2026-09-15-15-14-45-ed329ac2` | `session-2026-09-15-14-52-32-96851cb4` | — |
| lr_205 | `session-2026-09-15-14-36-39-5d631842` | `session-2026-09-15-15-14-49-c96b9867` | `session-2026-09-15-14-52-40-e01008d6` | — |
| lr_206 | `session-2026-09-15-14-36-54-b69c5bb8` | `session-2026-09-15-15-14-58-dd85a930` | `session-2026-09-15-14-52-54-c56211d6` | — |
| lr_302 | `session-2026-09-15-15-41-06-48a644b9` | `session-2026-09-15-15-57-35-f5999346` | `session-2026-09-15-15-43-09-d3b64d8b` | `session-2026-09-15-16-00-27-d5978839` |
| lr_306 | `session-2026-09-15-15-41-54-f42c0cda` | `session-2026-09-15-15-59-21-936dc40f` | `session-2026-09-15-15-44-16-42caf47d` | `session-2026-09-15-16-02-00-70564337` |

## 三、怎么跑

```bash
cd app
npx tsx eval/run-suite.mts   --split test --version <版本> --experiment ../reports/experiments/<实验目录> --dataset gate-set-7 --concurrency 3
npx tsx eval/score-suite.mts --split test --version <版本> --experiment ../reports/experiments/<实验目录> --dataset gate-set-7 --status confirmed
```

执行纪律与其它划分一致：每例一个独立设备库、每例一份独立 Agent State 副本、每例 runs=1、失败不剔除；基础设施失败单独记 `status=infrastructure_failed`，不伪装成 Agent 得分。
