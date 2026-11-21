# dsh-lcbf-memory

> 给 DeepSeek Harness 用的**分桶 + 权重 + 遗忘 + 更新**长期记忆插件。
>
> LCBF+U 五机制：**L**evel（core/cold 分层）、**C**hart（实体关联）、**B**ucket（entity/event/concept 分桶）、**F**orget（衰减/保胎/冷存储/复活）、**U**pdate（状态更新去重 + 矛盾失效）。

## 为什么

常见记忆插件（如七层 SQLite + BM25）只会「越攒越多」：检索被稀释、旧事实压过新事实、没有「什么该忘」。本插件把记忆当作**会演化**的东西：重要的留下、过期的沉底、更新的覆盖、相关的互连。

## 机制

| 机制 | 说明 |
|---|---|
| **L 分层** | core（永久核心，固定注入）→ 桶（entity 75 / event 120 / concept 90）→ cold（冷存储 450，可复活） |
| **C 关联** | 实体为锚点建边；超级节点自动降级为标签；别名表 |
| **B 分桶** | 实体事实 / 事件 / 概念三类，各自权重上限 |
| **F 遗忘** | 权重 × 时间衰减（保胎 6 个月、floor 0.7 防误删）、冷存储循环压缩、双通道复活（实体 + 文本重叠） |
| **U 更新** | 近重复合并时**数字不同 = 状态更新**（新值覆盖旧值，刷新 eventDate）；规则矛盾检测（反义词对）标记旧记忆失效 |

## 安装

1. 复制到 profile 的 node_modules：
   ```powershell
   Copy-Item -Recurse dsh-lcbf-memory "$env:USERPROFILE\.dsh\profiles\web\node_modules\"
   ```
2. 在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里加 `"dsh-lcbf-memory"`：
   ```json
   "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-lcbf-memory"]
   ```
3. 重启 DSH。

**注意**：写 JSON 时不要用 PowerShell 的 `Set-Content -Encoding UTF8`（会加 BOM，JSON 解析失败）。用 node 或 `[IO.File]::WriteAllText`。

## 配置

默认存储目录：`~/.dsh/lcbf-memory/`，可用环境变量 `LCBF_DIR` 覆盖。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_lcbf_search` | 检索长期记忆（query, k） |
| `memory_lcbf_remember` | 写入一条记忆（text, bucket, importance, event_date） |
| `memory_lcbf_update` | 更新/归档记忆（query 精确短语 → 改 text/importance/archive） |
| `memory_lcbf_project` | 项目全景（按层分组 + 条目） |

## 自动提炼（condense）

- 每轮对话累积到内存；**静默 30 分钟**或**累计 2 小时**时触发提炼（调 DeepSeek API，从 `~/.dsh/.credentials.yaml` 读 key）
- 提炼结果自动分桶、去重、冲突标记、软淘汰

## 注入

- 会话首轮（带真实用户消息的 `agent/pre-step`）注入一次：`[长期记忆]` 块（core 全量 + 相关 topN）
- 注入消息满足 DSH v4 会话格式：`source.kind = "plugin:lcbf-memory"` + 非空 `id`

## 基准（LongMemEval v1，500 题）

跑分用的是同一份引擎的 LME 镜像（`memory-lme.js`，参数与存储隔离），回答模型 `deepseek-chat`，严格 LLM 判官（事实一致才判对），4 分片并行。

| 题型 | 得分 |
|---|---|
| single-session-user | 67/70（95.7%） |
| knowledge-update | 73/78（93.6%） |
| single-session-preference | 28/30（93.3%） |
| single-session-assistant | 49/56（87.5%） |
| temporal-reasoning | 116/133（87.2%） |
| multi-session | 108/133（81.2%） |
| **总计** | **441/500（88.2%）** |

### 错题归因（59 道逐题人工复核）

| 归因 | 数量 | 说明 |
|---|---|---|
| 题目 / gold 有问题 | 36 | gold 与原文冲突、日期张冠李戴、口径不明，已从分母剔除 |
| 真引擎错误 | 16 | 提炼丢限定词、计划误记为已完成、回答层退缩、选错数据源 |
| 回答抖动 | 3 | 同一份注入重跑能答对 |
| 判官误判 | 2 | 模型答对、判官按「数值不等」判错（判官口径未改，保持与官方一致） |
| 已修待验证 | 2 | 改完规则等重跑确认 |

剔除题目问题后为 **441/464（95.0%）**。

### 关于这个分数

- LME 每题只有 20–50 条记忆，bench 采用**全注入**；同一策略换到长历史基准会爆上下文（中位 1354 条 / 50k 字，最大 201k 字），所以插件默认仍是「core + 检索 top 20」，不做全注入。
- 这是引擎在 LME 上的参考上限，不是插件在 DSH 日常会话里的实测分。

## 文件

```
index.mjs    # cordis 插件（钩子 + 工具 + condense）
engine.cjs   # 记忆引擎（分桶/权重/遗忘/更新，无第三方依赖）
```

## 许可

MIT
