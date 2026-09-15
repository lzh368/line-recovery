# main 分支保护配置

本目录保存两份 GitHub 分支 Ruleset。**文件入库不等于远端规则已启用**；必须在 GitHub 导入或通过 API 应用，并读回确认 `enforcement=active`。

2026-09-15 配置时，仓库仍为私有。GitHub Rulesets API 返回 403，提示升级套餐或公开仓库后才能启用。仓库可见性只由所有者手动修改；CI 不使用管理令牌，不会自动公开仓库或修改保护规则。

## 两条独立规则

- `main-safety.json`：禁止删除、强推和新增合并提交，要求 GitHub Actions 的 `offline-checks` 成功，且分支基于最新 main。没有旁路账号，包括所有者也不能绕过。
- `main-review.json`：必须走 PR、获得一次 CODEOWNER 批准、修改后重新审核、解决讨论，只允许 Squash 合并。`.github/CODEOWNERS` 指定 `@lzh368` 负责所有文件。
- 审核规则只为 Repository admin（角色 ID 5）保留 **For pull requests only** 旁路，用于所有者自己创建、无法自己 Approve 的 PR。配置时仓库唯一管理员是 `lzh368`；不要向外部贡献者授予管理员权限。旁路不影响独立的 safety 规则。

## 启用前后核对

1. 先完成代码安全、许可证和发布材料修订。CI 通过不代表此前审核问题已经修复，也不是 Agent 分数。
2. `.github/workflows/ci.yml` 至少成功运行一次，检查名称为 `offline-checks`，来源为 GitHub Actions（应用 ID 15368）。它只运行类型检查、离线应用/MCP 测试和数据校验，不调用模型或真实设备。
3. 仓库支持 Rulesets 后，在 Settings → Rules → Rulesets → New ruleset → Import a ruleset 导入两份 JSON。若已有同名规则，编辑现有规则，避免重复创建。
4. 确认两条规则均为 Active，目标均为 `refs/heads/main`；safety 无旁路，review 旁路仅为管理员且只允许 PR。
5. 公开后将 Settings → Actions → General 的外部 Fork 工作流审批设置为所有外部贡献者均需批准；保持默认 workflow token 为只读，禁止 Actions 创建或批准 PR。批准 CI 运行不等于批准 PR 合并。

维护者也可用 `gh api repos/lzh368/line-recovery/rulesets` 查看远端规则，再按 ID 更新已有规则或用 `--method POST --input <文件>` 创建缺失规则。创建成功后仍需核对有效分支规则：

```bash
gh api repos/lzh368/line-recovery/rules/branches/main
```

本目录不包含管理令牌、模型密钥或自动绕过保护的工作流。
