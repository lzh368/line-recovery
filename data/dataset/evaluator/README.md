# 参考答案与模拟设备状态

本目录保存数据集的 24 份评测材料：优化集 10 份、测试集 14 份，每例包含以下三个文件，共 72 份 JSON。

| 文件 | 用途 |
| --- | --- |
| reference.json | 诊断参考、动作约束与预期反馈 |
| backend-fixture.json | 模拟设备初始状态和后续响应 |
| source.json | 原始案例来源与划分 |

它们是评测输入，不是 Agent 实际生成的报告或操作记录。每份材料与 `../optimization/` 或 `../test/` 中同编号的输入对应。`manifest.json` 记录文件哈希与绑定关系。

在仓库根目录检查：

```bash
python3 tools/check_evaluation_bundle.py
python3 tools/check_backend_fixtures.py --fixtures data/dataset/evaluator
```

为单个案例装载模拟状态：

```bash
python3 interfaces/manage.py --db /absolute/run/lr_101/state.sqlite3 init --fixture data/dataset/evaluator/optimization/lr_101/backend-fixture.json --time-scale 20
```

每例、每次运行使用独立数据库和 Agent 配置副本，两个 MCP 连接同一案例的数据库。
