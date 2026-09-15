# 产线恢复数据集

包含 24 份合成案例：10 份优化案例、14 份测试案例。

| 目录 | 案例 | 用途 |
| --- | --- | --- |
| optimization/ | lr_101—lr_110，共 10 份 | 发现问题和调整 Agent |
| test/ | lr_201—lr_207、lr_301—lr_307，共 14 份 | 在版本固定后检验表现 |
| evaluator/ | 对应的 24 份评测材料 | 参考答案、动作约束和模拟设备状态 |
| split-manifest.json | 完整案例清单 | 划分、原始来源及文件哈希 |
| preview.html | 优化资料预览 | 查看优化案例输入 |
| test-preview.html | 测试资料入口 | 只列测试输入链接 |

每个案例包含运行记录、操作日志、工位图片、状态快照、字段字典和设备说明。

输入每例包含 120 秒、121 行运行记录、14 条日志和一张图片。案例覆盖供电中断、温控暂停、计划停机、条件变化和资料缺失等场景。优化资料与测试资料不共享基础图片，原制作示例仍位于 `examples/input/`。

## 检查与打包

在仓库根目录执行：

```bash
python3 tools/datasets.py check
python3 tools/check_evaluation_bundle.py
python3 tools/datasets.py zip
python3 tools/check_supplemental.py zip
python3 tools/check_backend_fixtures.py --fixtures data/dataset/evaluator
```

`datasets.py` 检查或打包全部 24 例，也可用 `--split optimization` 或 `--split test` 选择划分。`check_supplemental.py` 继续检查 lr_301—lr_307 的时序、日志、图片和响应一致性。ZIP 位于 `uploads/<split>/`，不包含参考答案。

## 评测入口

运行和评分时使用 `--dataset dataset`；默认也是 `dataset`。选择 `--split optimization` 会运行 10 例，`--split test` 会运行 14 例。请使用新的实验输出目录。

[gate-set-7](../gate-set-7/README.md) 只保留七例回归清单，复用此目录中的输入和评测材料，使用 `--dataset gate-set-7`。
