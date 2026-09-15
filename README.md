# Line Recovery · 产线恢复助手

用 Penguin 制作中文应用：上传纸箱输送工位资料，分析异常；有工具侧许可时请求恢复，并依据新反馈说明结果。Penguin 已交付初版应用，两个演示 MCP 服务现已补齐并接好配置；Agent 自动调用与持续读回尚待联调。本次没有调用模型或真实设备，没有 Agent 分数。

## 两个业务故事

### 停电后已经来电，输送线仍未恢复

生产中的输送段突然停下。现场人员反馈刚才短时停电，现在已来电，但输送带仍没有转动，图片中纸箱分散排列。助手需要结合电压、驱动就绪、速度、计数、日志和生产任务核对经过，不能仅凭图片判定停机原因。

设备采用“不随来电自动重启”的规则。Agent 先查询最新可信状态；供电和运行许可、安全条件均满足时，通过 power-control 请求恢复输送，再核对带速及新的出口计数。不需要再次接通电源，更不能看到“已来电”就直接启动。

### 温度升高，开启散热后再核验

驱动柜温度升高，控制器按温控策略暂停输送，独立风机未开启。助手依据温度趋势、风机指令和反馈判断是否请求散热。cooling-control 只开启批准的风机模式，不修改温度、不解除保护、不启动输送。

风机开启后要观察温度。满足公开恢复条件并由后端重新给出运行许可后，才能通过受控启动入口请求恢复。风机不转、温度不降、状态过期或其他条件不满足时，说明失败/未确认并转人工。

这些是应用需求和公共设备规则，不是逐例答案。正常、计划停机、维护及资料不足也必须能正确处理。

## 给 Penguin 的材料与阅读顺序

1. 本 README：业务背景、功能和分工。
2. [输入格式](contracts/README.md)、[状态 Schema](contracts/device-state.schema.json)、[报告 Schema](contracts/report.schema.json) 和 [模板](contracts/report.template.json)。
3. [供电恢复 MCP](interfaces/power-control/README.md)、[散热 MCP](interfaces/cooling-control/README.md)。
4. 联调时看 [example](examples/README.md)：一份完整但无答案的输入，用来理解文件和数据格式，不是必须照抄的解题范文。

24 份输入在 [data/](data/README.md)，对应参考答案、动作约束和后端夹具已归档到 [evaluator/](data/dataset/evaluator/README.md)，可随仓库交给 Penguin 组织实验。初版制作仍只使用无答案 example，不读取评测答案；正式运行时由独立评分方加载夹具，被测 Agent 只看到当前案例输入。目录分开不是权限隔离。数据生成脚本仍保留在生产目录，不是使用这批成品的前置条件。

## 应用交付要求

- 上传 ZIP 或加载 example，浏览 CSV、日志、状态和图片。
- 分别展示历史异常判断、证据、动作请求、最新反馈及未确定事项。
- 先查询工具当前状态再决定是否执行，上传快照的许可不授予真实执行权限。
- 前端从实际后端审计记录展示动作，不把模型写出的计划当作已执行。
- 命令受理、风机转动、温度达标、输送运行、出口恢复产出是不同阶段。
- 没有服务时显示“工具未连接”；默认演示模式，不伪造真实恢复。
- Penguin 在 `app/` 编写 Agent、前后端、MCP 客户端和启动说明；MCP 服务已交付到 `interfaces/`。未初始化后端或未连接时，应用仍应如实显示不可用。

### 初版制作时使用的指令

工作区选择仓库根目录 `line-recovery`，勾选应用中的 `agent-creation` 技能，发送：

> 请使用 agent-creation，先读 README.md，再看 contracts/、interfaces/ 和 examples/input/，在 app/ 制作产线恢复助手，包括 Agent、后端、中文前端和启动说明。按现有契约实现两个 MCP 的客户端；服务未交付时明确显示未连接，不伪造动作成功。用 example 联调输入读取和页面，保留初始版本，本轮不扩充数据、不做优化或正式评分。

初版已完成，不需要重新创建。本地启动与设备工具配置见 [MCP 使用说明](interfaces/README.md)。

## 当前文件

```text
line-recovery/
├── README.md             # Penguin 的构建要求与业务说明
├── app/                  # Penguin 生成的 Agent、前后端与 MCP 客户端
├── examples/input/       # 一份无答案输入，未含恢复后的记录
├── data/dataset/         # 10份优化、14份测试输入；初版制作暂不读
│   └── evaluator/        # 24例参考答案、后端夹具、来源和校验清单；仅实验组织/评分方读取
├── contracts/            # 数据和报告结构、输出模板
└── interfaces/
    ├── power-control/    # 可运行的查询与恢复输送 MCP
    ├── cooling-control/  # 可运行的查询与散热 MCP
    └── shared/           # 共用演示后端、状态版本及操作审计
```

制作 example 为供电场景，保持不变；24份案例覆盖供电与散热，见 [数据说明](data/dataset/README.md)。两个 MCP 只操作独立的 dry_run 演示状态，不连接真实设备。旧 line-inspection 的数据、v4 和成绩不修改，也不迁移为本项目成绩。

资料是新制作的合成演示工位，使用独立控制供电与 24 V DC 驱动支路，不是电池设备。风机位于闭合控制柜内，不能凭图片判断其状态。生产草稿与生成过程仍留在仓库外 `../数据生产/新版数据-9.15/`；24 例评测所需成品已在仓库内，见 [评测组织入口](data/dataset/evaluator/README.md)。
