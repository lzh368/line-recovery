# 契约 v0.1

- `device-state.schema.json`：上传状态与后续工具状态共用字段，用 source 区分来源；null 表示未知，不可按 false/0 处理。
- `action-result.schema.json`：工具执行结果；accepted 不是 confirmed；模式和状态来源必须一致。
- `request.schema.json`：上传请求元数据及采集完整性说明。
- `report.schema.json`：历史诊断与恢复记录分开，定义供电中断停机和驱动柜温控暂停两个词汇。定义散热词汇不代表已完成散热案例或服务。
- `report.template.json`：占位布局，不是答案，不应通过 Schema。

Schema 使用 JSON Schema 2020-12，相对 `$ref` 只解析本目录文件，启用 date-time 格式验证，不访问网络解析引用。

证据统一用 `file + locator + observation`，locator 写时间段、事件编号或字段路径；后端还需检查路径是否存在、引用是否属于当前输入、事件/时间是否真实。不能仅靠格式合法判定证据正确。

Schema 不独自承担设备安全或事实核验：后端须检查 device_id 绑定、时间先后与新鲜度、权限、版本、幂等性、真实工具轨迹及恢复阶段对应证据。禁止把报告里手写的 operations 当作已经执行的动作。

# 输入格式

每份案例是一个独立目录或 ZIP。ZIP 根目录直接包含 request.json，不嵌套额外目录；拒绝绝对路径、..、软链接及超限文件。

| 文件 | 内容 |
| --- | --- |
| README.md | 操作人员提出的业务问题；不是参考答案或执行授权 |
| request.json | 案例、设备、观察时间和采集说明，见 contracts/request.schema.json |
| device.json | 设备范围、驱动/控制供电关系、几何和公开操作参数 |
| device_state.json | 上传结束时快照，见 contracts/device-state.schema.json |
| data_dictionary.json | CSV 字段、单位、缺失和状态字段定义 |
| operating_guide.md | 参考范围、任务工况、散热规则与动作边界 |
| telemetry.csv | UTF-8、英文逗号、1 Hz，时间窗 120 s 含首尾 121 行 |
| events.jsonl | 每行一个事件：event_id、timestamp、source、level、code、message |
| images.json | file、timestamp、camera_id、view、synthetic、observation_scope |
| images/*.png | 静态工位图片，只支持可见物料和外观判断 |
| manifest.json | 除自身外各输入文件的相对路径、字节数、SHA-256 |

## 公共语义

CSV 布尔用 0/1；空值表示未观测。JSON 用 true/false/null，null 不作 false 或零。时间包含时区；计数为累计值，人工移出不能算出口产出。
设备状态 source=uploaded_snapshot 时只是历史资料。后续 MCP 返回 demo_backend 或 live_backend，由后端生成 captured_at、expires_at、revision，不能由上传输入重定义。

production_requested、run_command、run_resume_permitted 分别是生产需求、运行请求及运行许可，不可互相替代。供电恢复后 run_command 仍可为 false。

温控读数与指令分开：cooling_enabled 是风机命令，cooling_fan_running 是实际反馈。temperature_recovery_ready 由可信后端依据连续时间和公开条件计算，不由 Agent 自报。

dataset-v0.1 在原example的CSV列基础上增加7个已定义状态字段的历史序列：run_resume_permitted、cooling_enabled、cooling_fan_running、cooling_fan_fault、cooling_control_permitted、thermal_pause_active、temperature_recovery_ready。逐例data_dictionary.json给出实际列；旧example不变，解析器不要假定所有输入只有旧列。

## 诊断词汇与证据

power_interruption_stop：该窗出现过供电中断并导致停机；结束时可以已经来电但仍停机。
cabinet_overtemperature_pause：达到公开温控暂停条件并有对应暂停记录；不能仅凭温度高就排除其他原因。
若原因证据不足，fault_types 留空并在 limitations 说明；不能为了凑两类而猜测。

报告证据统一用 file、locator、observation；locator 写输入中的时间区间、事件编号或字段路径。动作后的状态不要混写成原窗口末态。

## 不随输入提供

参考答案、未来工具响应、私有后端状态及训练/测试标签不在上传包，也不进入制作工作区。新增优化/测试输入放data/，制作阶段暂不读；一个 example 只展示输入格式和联调资料，不提供执行答案。
