# dsh-handoff

在 DeepSeek Harness 会话之间传递开发上下文。

## 项目简介

DeepSeek Harness 的会话通常很长，换新会话时难以把上一个会话已经确认的结论、当前进度和下一步计划完整带过去。本插件提供两个命令来解决这个问题：

- `/handoff save` 把当前线程的有效状态总结成一份文档，写入 `docs/handoffs/current.md`，并让 assistant 回一句话确认。
- `/handoff load` 把这份文档作为 durable recall 注入一个新线程，立即显示为一条可见的召回节点，并让 assistant 回一句话确认已加载。

它是一份**交接快照**，不是对当前线程上下文的压缩、删除或替换。`save` 不修改原线程已有的消息，`load` 也不会删除或压缩新线程里的其他上下文。

## 前置条件

- DeepSeek Harness 已安装并可运行。
- Node.js 版本满足 `^22.19.0 || >=24.0.0`（与 `package.json` 的 `engines` 一致）。
- 插件记录 Git 仓库状态，并生成可由用户检查和提交的交接文档。
- 安装 `@deepseek-ai/*` 的 rc/beta 依赖需要用户自己的 npm 权限；认证应配置在用户级 `~/.npmrc`，不要把认证配置行或令牌写入仓库或文档。

## 安装

通过 GitHub 分发安装，无需 npm scope：

```bash
dsh plugin --profile web add github:0mn1si2i5/dsh-handoff
```

安装的是仓库里已提交的构建产物（`lib/`），无需在安装时执行构建脚本。

## 本地打包验证（开发用）

在改代码时，用本地 tarball 安装最接近真实的发布结果，而不是直接链接源码目录：

```bash
pnpm install
pnpm check
pnpm pack --pack-destination <临时目录>
dsh plugin --profile web add <tarball 的绝对路径>
dsh --profile web --dump-config
```

最后一条命令用于确认 `dsh-handoff` 已出现在配置中。安装的是打包后的产物，而不是源码目录，因此能验证发布包的实际内容。

## 快速使用

1. 在**原线程**执行 `/handoff save`。
2. 查看或提交生成的 `docs/handoffs/current.md`。
3. 在同一仓库的**新线程**执行 `/handoff load`。
4. `load` 会把交接文档作为一条可见的召回节点立即显示出来，并唤醒模型回一句话确认；之后用户发送下一条开发指令即可继续。
5. 当前代码与当前用户指令优先于历史 handoff 文档。

## Commands

- `/handoff save` — 总结当前会话，写入 `docs/handoffs/current.md`，并让 assistant 确认。
- `/handoff load` — 把 `docs/handoffs/current.md` 作为 `recall` 上下文注入当前会话，显示为一条召回节点，并让 assistant 确认。

两个命令都要求 agent 处于 idle 状态，且不接受额外参数。

## Configuration

| 字段 | 说明 |
| --- | --- |
| `summarizationProvider` | 保存时做总结所使用的 provider。与 `summarizationModel` 一起配置，二者要么都设置、要么都不设置。省略时依次回退到会话最近一次请求的 provider/model，再到 agent 的默认 provider/model。 |
| `summarizationModel` | 保存时做总结所使用的 model。与 `summarizationProvider` 一起配置。 |
| `maxTokens` | 总结请求的输出 token 上限。默认 `4096`。 |
| `maxDocumentBytes` | 交接文档的 UTF-8 字节上限。默认 `32768`。 |
| `gitTimeoutMs` | 捕获 Git 状态的超时时间（毫秒）。默认 `10000`。 |

所有数值字段必须是正整数（安全整数范围内）。未知配置键会被拒绝。

## 文档格式与 Git 行为

- 文档固定在 `docs/handoffs/current.md`（相对仓库根目录），格式为 `dsh-handoff/v1`。只有用户提交 `current.md` 后，Git 历史才会保留旧版本。
- `save` 会捕获当前的 Git 分支、HEAD 和变更文件列表，并据此计算一个状态摘要（state digest）。
- handoff 文档自身不计入这个 stale digest，因此一次 save/load 往返不会被误判为“仓库状态已变化”。
- `load` 时若仓库状态与文档记录不一致，只产生告警，不阻止注入；当前文件始终优先。
- 写入使用带版本的原子写与并发保护，旧版本不会覆盖胜出的版本。

## 安全边界

保存时会对输入消息、模型输出、Git 文件名和动态 Git 元数据做确定性脱敏。主要覆盖的类别包括：私钥、npm token、`Authorization` 值、密码、常见 API token，以及敏感环境变量的值，统一替换为 `<redacted:...>` 一类的占位符。

脱敏是一道安全防线，但不是对所有可能秘密格式的绝对保证。建议用户在提交 handoff 文档前自行检查一遍内容。

- Git 命令使用固定参数、有界输出和超时，不经过 shell。
- 错误、文档和告警不会回显秘密值。

## Token 与模型行为

- `save` 会发起一次独立的总结调用，外加一次确认回复，各消耗一次输入加输出的 token；它不会减少原线程的 token 占用。
- `load` 会唤醒模型一次，让 assistant 确认已加载，同样消耗少量 token。
- 交接文档本体在下一轮请求开始时才进入模型上下文。
- 插件不承诺任何供应商的 KV cache 命中。

## 限制

- 仅文本：总结不包含图片或工具 schema。
- 只有单一固定的 `current.md`，没有时间戳或多个槽位。
- 除 Git 历史外没有归档或备份。
- 不会自动 save 或 load。
- 没有跨工具交接格式，也没有 UI。
- 对仓库状态变化采用保守的告警，不做合并或冲突解决。
- 不是完整会话日志的替代品。

## 开发与验证

```bash
pnpm install
pnpm check
pnpm pack --dry-run
```

## License

BSD-3-Clause
