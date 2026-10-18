[English](README.md) | **中文**

# Dream

**一个以记忆为核心的 Agent。** Dream 的内核是一套仿生记忆系统——统一记忆空间 + 完整生命周期（编码 → 巩固 → 提取 → 再巩固 → 遗忘）。除此之外的一切——推理模型、工具、语音、界面——都是可插拔的插件。

> 一切皆插件，**唯独记忆不是**。记忆定义了 Agent 是谁。

![Dream —— orb 是工作记忆仪表，右侧为记忆时间线与实时对话](docs/assets/screenshot.png)

## 其他 Agent 的症结

主流的 Agent 每开一个会话就重启一次人生：一个对话一份记忆，每次都是全新人设。提示词、向量库、上下文窗口——窗口一关，学到的东西要么消失，要么变成检索索引里一条死数据。它永远不会在你反复交代的任务上变快，不会修正已过时的信念，也不会刻意忘记任何东西。

Dream 把架构颠倒过来：推理循环不是核心，**记忆才是**。模型是租来的、可替换的；记忆才是让 Dream 跨会话、跨天、跨模型升级仍然是同一个"它"的东西。

## 由此得到什么

| | 普通 Agent | Dream |
| --- | --- | --- |
| **记忆** | 按会话的上下文 + 检索 | 单一统一记忆空间；会话只是激活模式，不是容器 |
| **学习** | 微调或改提示词 | 记忆生命周期**本身就是**学习回路 |
| **技能** | 静态说明文件，每次重读 | 程序性记忆：从重复执行中自动归纳、参数槽位化、回放时**零 LLM 调用** |
| **纠正** | 过时认知一直留存 | 召回会打开再巩固窗口：窗口内原位改写，窗口外生成新的最新版本（旧版本保留在历史链中） |
| **遗忘** | 全部永久保留 | 经实验校准的适应性衰减（τ=90 天）；遗忘箱里的记忆仍可被强线索唤醒 |
| **空闲时** | 什么都不发生 | Dream 会**做梦**：回放情景、抽象模式、合并重复、归纳技能、强化重要记忆 |
| **安全** | 靠模型自觉 | 所有工具调用（含 MCP）走同一条管道、插件能力默认拒绝、审批 fail-closed、写入与读取双向脱敏、tombstone 审计 |
| **可诊断性** | 黑盒 | 每次操作一个 traceId；每条召回通道都有阶段事件；默认不存内容；`dream inspect` 可查 |
| **检索编排** | 单一相似度分数 | 向量 + BM25 + 实体 tag + episode 支持，可预留槽位并可选 RRF 融合 |
| **图** | 无类型近邻边 | 规则化类型边、可解释关系路径、可选类型先验 |
| **耐久性** | 重试会重复写入 | WAL + 写事务 + 幂等键；`dream doctor`、`backup`、`restore` |

## 用证据说话，而不是靠感觉

多数 Agent 项目只发布演示。Dream 附带一套**实验体系**——二十一个受控、确定性的实验（`pnpm experiments` → `EXPERIMENTS.md`），它们已经找出并修掉了真实 bug：

| # | 实验 | 关键结果 |
| --- | --- | --- |
| E1 | 召回规模 × 嵌入消融 | 400 个同模板节点下 recall@4 仍为 100%；"嵌入会退化"的假设被**证伪**；性能剖析还暴露了一个 10 倍的存储瓶颈 |
| E2 | 巩固（做梦）功效 | 30 天后的模式型提问：抽象节点在 **3/3** 个主题上排第一（此前 0/3——该实验直接促成簇心嵌入、可提取性门控与词干化落地） |
| E3 | 遗忘校准 | τ 扫描**揪出衰减二次方复合的真 bug**；据数据把默认 τ 校准为 90 天；回放强化机制由此实现 |
| E4 | 技能参数漂移 | 冻结参数回放曾**6/6 次静默用错数据集**；槽位挖掘 + fail-closed 绑定后降到 **0/6** |
| E5 | 再巩固窗口 | 从 1 分钟到 24 小时全量程语义精确；优先级冲突裁决正确 |
| E6 | 上下文预算增长 | 记忆库 400 条时提示词只增加约 160 token——有界上下文，并用真实 API 的 `usage.prompt_tokens` 验证 |
| E7 | 迟到的纠正 × 版本链 | 窗口外纠正被拒绝时，两个月后过时事实仍排第一；改为版本链后，纠正内容排第一、过时记录退役、四代历史完整可查 |
| E8 | 混合检索 × 工作集多样性 | 标识符冲突：recall@1 **9% → 100%**；关键词堆砌日志：top-1 **0/20 → 20/20**；4 槽工作集的去重覆盖 **2 → 3.3**，召回成本约 1.8 倍 |
| E9 | 中文分词 | 旧 ASCII 分词：中文 recall@4 **0%**（零向量）；Intl.Segmenter + 汉字 bigram：**100%**，英文无回退 |
| E10 | 经验层 | 环境边界阻止 **1/1** 次错误复用；searchKeys 命中标签匹配不到的改写请求；details 原文随摘要返回 |
| E11 | 产物修订链 | 两次成功编辑挂上版本 1、2；失败编辑不入链；全程零 LLM |
| E12 | 种子/消融/留出语料 | 5 个种子平均 recall@1 **59.7% → 100%**；词法与多样性增益相互独立；留出语料无回退 |
| E13 | 用户/场景/意图/改写 | 跨用户槽位 **66.7% → 0**；场景 top-1 **5/10 → 10/10**；意图过期后仍可召回；同义查询命中正确事实 |
| E14 | 阶段级可观测性 | 一次操作一个 traceId 贯穿 encode/recall；所有通道都有阶段事件；trace **不含内容**；事件持久化供 `dream inspect` 查询 |
| E15 | 事件时间与证据 | as-of 召回排除过时/未来版本；5 次 reinforcement 把 evidenceCount 1→6、confidence 0.20→0.82，并改变排序 |
| E16 | TriLink 三层 | fact → experience、fact → revision、revision → fact、experience → fact 全部可遍历；每层展开上限 5 |
| E17 | 通道编排 | 仅靠 tag 的查询 **0 → 1 条结果**；31 分钟间隔切分 episode；同讨论锚定把 top-4 占比 **2/4 → 3/4**；配额让 procedural + episodic 进入语义主导的工作集 |
| E18 | 多仓库交错任务恢复（CMB-lite） | TypeScript + Python + 中文指令：仅摘要记忆 **0/4** 诊断且恢复用过时值；全栈 **4/4** 并成功恢复 |
| E19 | 类型化图记忆 | 规则线索生成 causal/contrast/temporal/elaborates/entity 边；关系路径包含 causal 跳；类型先验把 causal/similar 激活比 **1.00 → 1.80** |
| E20 | P10-lite 耐久性 | 同一幂等键只产生一个节点；失败事务与 journal 失败都不留半条记忆；WAL/完整性/孤立边检查通过 |
| E21 | 可执行多仓库恢复 | 三个真实临时仓库（Node/Python/JSON）；仅摘要记忆 **0/4** 诊断且恢复测试失败；全栈 **4/4** 并通过真实 `node test.js` |

整套实验离线运行、不需要 API key。E8/E12/E15 带可选真实嵌入检查，无 key 时跳过。大致分类：E1–E5/E7–E11/E13–E17/E19 是机制实验，E12/E18/E21 是基准，E6/E14/E20 是运维/耐久。

## 上手试试

```bash
git clone https://github.com/Fengrru/dream.git && cd dream
pnpm install

pnpm test          # 127 个单元测试
pnpm eval          # 4 套功能评估（离线、确定性）
pnpm experiments   # 二十一个实验 → EXPERIMENTS.md

# 1) 离线对话演示——无需 API key，记忆回路全真运行（回答为脚本人设）
pnpm demo
#   you › My name is Ada and I live in Seattle
#   you › What is my name?
#   dream › I remember: My name is Ada and I live in Seattle
#   /dream  → 立即运行一次巩固周期并打印梦报

# 2) 完整体验：实时网页 + DeepSeek 推理 + 持久记忆
pnpm cli serve --db memory.db --idle-dream 300   # 网关：ws://127.0.0.1:7333
pnpm --filter @dream/web dev                        # → http://localhost:5180
pnpm cli inspect --trace <traceId> --db memory.db  # 阶段级 trace，可用 --metrics / --json
pnpm cli doctor --db memory.db                      # 完整性、WAL、schema、孤立边检查
pnpm cli compact --db memory.db --days 7            # 清理旧 trace、checkpoint WAL
```

网页里：把 **Signal source 切到 Dream live**，对它说"我的航班是 QF27，我偏好靠过道座位"，之后在新会话里追问它，打开 **Timeline** 看记忆入库时的强度/重要性，放着不管五分钟看它自己做梦。用 **Mic** 按钮直接说话（浏览器语音，零配置），开启 **Voice** 让它念出回答。

配置放在 `.env`（见 [`.env.example`](.env.example)）：

```bash
DREAM_API_KEY=sk-...                  # 任何 OpenAI 兼容的对话接口
DREAM_BASE_URL=https://api.deepseek.com/v1
DREAM_MODEL=deepseek-chat
DREAM_EMBED_MODEL=text-embedding-3-small   # 可选：接入真实嵌入模型
DREAM_MCP_CONFIG=mcp-servers.json          # 可选：MCP 服务器（stdio）
```

## 工作原理

```plaintext
┌──────────────────────────────────────────────────────────────┐
│  orb-ui 界面 —— orb = 工作记忆仪表；                            │
│  记忆时间线 · 遗忘箱 · 梦报 · 语音                              │
└──────────────────────────┬───────────────────────────────────┘
                           │  WebSocket（认知状态流）
┌──────────────────────────▼───────────────────────────────────┐
│  插件层（单管道，能力默认拒绝）                                  │
│  感知 · 推理（DeepSeek 等）· 工具（MCP）                        │
│  语音 · 策略 · 巩固 pass                                       │
└──────────────────────────┬───────────────────────────────────┘
                           │  插件间唯一交换介质：
┌──────────────────────────▼───────────────────────────────────┐
│  DREAMCORE —— 特权记忆内核                                     │
│  工作记忆（4±1 组块 = 认知总线）                                │
│  统一长期记忆：情景 · 语义 · 程序性 · 自我                       │
│  生命周期引擎 = 学习引擎                                        │
│  仅追加日志（tombstone 审计）                                   │
└──────────────────────────────────────────────────────────────┘
```

完整设计——激活数学、巩固步骤、技能绑定、安全不变量——见
[ARCHITECTURE.md](ARCHITECTURE.md) 与 [SAFETY.md](SAFETY.md)。

## 包结构

| 包 | 职责 |
| --- | --- |
| `@dream/core` | 记忆内核：节点模型、存储、工作记忆总线、扩散激活、编码门控、生命周期引擎、技能绑定、自我模型 |
| `@dream/kernel` | 编排：插件宿主、能力约束、单管道、执行器会话循环 |
| `@dream/policies` | 默认拒绝的权限预设、fail-closed 审批、密钥脱敏、注入隔离 |
| `@dream/store-sqlite` | libSQL 持久化——本地优先：一个完全属于你的文件 |
| `@dream/plugin-reasoning-openai` | OpenAI 兼容推理策略 |
| `@dream/plugin-mcp` | stdio MCP 桥——MCP 工具走同一条管道 |
| `@dream/plugin-scripted` | 确定性推理 + 模拟工具（测试/评估/演示） |
| `@dream/eval` | 度量标尺：评估套件 + 实验体系 |
| `@dream/web` | orb-ui 界面、记忆面板、语音 v1 |
| `@dream/cli` | `dream chat / serve / dream / stats / eval / experiments` |

## 状态与路线图

v0.1.0 —— 已完成 P0–P9 记忆路线图 + P10-lite 耐久性的可用骨架。已验证：127 个单元测试、4/4 评估套件、实验 20×WORKS + 1×PARTIAL、类型检查零错误、浏览器实况会话（DeepSeek）。

- ✅ 多用户 `userId` 分区、版本化纠正、时间有效性、类型化图边、CMB-lite 任务恢复
- ✅ retrieval profile（offline/balanced/deep）、trace retention、可执行 CMB 基准
- 🔜 耐久写入队列 / 受管 Runtime（多宿主产品化）
- 🔜 流式语音适配器（经 orb-ui adapters 接 Pipecat / OpenAI Realtime）
- 🔜 超过 ~10⁴ 节点后引入 `sqlite-vec`；基于 LLM 的抽象与重要性评估
- 🔜 插件 SDK 与清单格式，对齐 dsh 生态

已知局限如实记录在 [ARCHITECTURE.md §8](ARCHITECTURE.md)（参数记忆与外部记忆的冲突、信用分配 v1、面向本地嵌入器校准的相似度阈值）。

## 开发

```bash
pnpm typecheck     # 全仓严格 TypeScript
pnpm test          # vitest
pnpm eval          # 功能评估
pnpm experiments   # 研究报告 → EXPERIMENTS.md
```

内核零依赖（`@dream/core` 只用 node 内置模块）；采用 internal-packages 模式（直接导出源码；发布 npm 前再加打包步骤）。参与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
