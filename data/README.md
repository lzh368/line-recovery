# 数据目录

- [dataset](dataset/README.md)：完整数据集，包含 10 份优化案例和 14 份测试案例。
- [gate-set-7](gate-set-7/README.md)：七例回归清单，复用 dataset 的输入与评测材料，成绩来自历史运行汇总。

评测参数 `--dataset dataset` 选择完整数据集，`--dataset gate-set-7` 选择七例集合。默认使用 `dataset`。

[examples/input](../examples/input/README.md) 是构建与联调使用的独立示例，不计入上述数据集。
