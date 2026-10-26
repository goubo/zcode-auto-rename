# zcode-auto-rename

[![Plugin](https://img.shields.io/badge/ZCode-Plugin-blue)](./.zcode-plugin/plugin.json) [![Version](https://img.shields.io/badge/version-1.1.0-green)](./.zcode-plugin/plugin.json) [![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

ZCode 会话自动重命名插件：每轮对话结束后分析用户输入与工具操作，自动生成「子项目｜主线目标」格式的会话标题；也支持 `manual` 模式 + `/rename-session` 命令按需主动重命名。

设计参考 [ONEGAYI/ZCode-Plugins](https://github.com/ONEGAYI/ZCode-Plugins) 的 suian-zcode-title，大幅简化并增强。

## 解决什么问题

1. **只在首轮命名**：ZCode 桌面端标题生成仅在 `turnNumber===0` 触发一次（源码核实），后续会话演化不再更新标题；
2. **聚合项目难辨认**：一个 workspace 挂多个子项目（如 `日常工作/` 下的公司事务、各业务线目录）时，宿主标题不含"在哪个子项目上干活"。

## 工作机制

```
Stop hook（每轮对话结束）
  → 校验 payload → 立即派发后台 worker（不阻塞对话）
  → 延迟 delayMs（等宿主持久化 turn 边界）
  → 只读会话库：完整用户输入 + 工具操作路径 + 当前标题
  → manual 模式：到此为止，不做任何处理（由 /rename-session 命令按需触发）
  → 保护检查：用户手动改名永不覆盖（title_source=custom / title_overridden=1；
    插件自己写入的标题除外，可随会话演进继续更新）
  → 指纹去重：无新消息不重复命名
  → 分析：子项目标签（操作频次）+ 主线目标（首条实质输入，近期明显转向时跟随）
  → 生成标题：[子项目]｜目标（规则引擎；配置 apiKey 后用 GLM 生成，失败回退规则）
  → 应用：notify（macOS 通知）或 auto（双库事务写入）
```

- 标题格式：`子项目｜目标`，如 `公司事务｜绩效材料整理`、`海淀+海办｜周报汇总`；无子项目操作时退化为操作类型前缀（如 `Bug修复｜...`）或只写目标。
- 纯本地运行：除可选的 LLM 命名请求外不访问网络，不收集数据。

## 安装

### 方式一：插件市场（推荐）

本仓库根目录自带 `marketplace.json`（插件源即仓库根目录）：

1. ZCode → **设置 → 插件市场** → **添加** → **添加插件市场**，粘贴本仓库绝对路径（`/Users/bo/my/git/zcode-auto-rename`）；
2. 在 **个人** 页签找到 `zcode-auto-rename` → **安装**；
3. 安装后 hook 由插件自动注册（`hooks/hooks.json`），插件贡献 hook 时宿主自动启用 hook runner。

### 方式二：手动注册（无需市场）

编辑 `~/.zcode/cli/config.json`，在 `hooks.events.Stop` 数组追加：

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "node \"/Users/bo/my/git/zcode-auto-rename/hook.mjs\""
    }
  ]
}
```

注意 `hooks.enabled` 需为 `true`（纯 config hook 默认关闭；已有其他 hook 在跑则通常已开启）。

> 两种方式**二选一**，同时注册会导致同一会话触发两次命名。

确认当前机器生效的注册来源与配置文件：

```bash
grep -c 'auto-rename/hook.mjs' ~/.zcode/cli/config.json    # >0 = 方式二手动注册生效
ls -d ~/.zcode/cli/plugins/cache/*/zcode-auto-rename 2>/dev/null # 有输出 = 市场安装生效
node -e 'import(process.env.HOME+"/my/git/zcode-auto-rename/worker.mjs").then(async m=>console.log(await m.resolveConfigPath()))' # 实际生效的配置文件
```

## 配置

配置文件位于 `~/.zcode/auto-rename/config.json`（状态目录，插件升级不丢失），从 `config.example.json` 复制修改。不存在的字段用默认值，文件缺失时全默认。

查找顺序：`--config` 参数 > `AUTO_RENAME_CONFIG` 环境变量 > `~/.zcode/auto-rename/config.json` > 插件目录 `config.json`。

| 字段       | 默认    | 说明                                                                                          |
| ---------- | ------- | --------------------------------------------------------------------------------------------- |
| `enabled`  | `true`  | 总开关，`false` 时 hook 空跑                                                   |
| `mode`     | `notify`| `notify`：每轮结束 macOS 通知建议标题；`auto`：每轮结束直接写库改名；`manual`：每轮不处理，仅 `/rename-session` 命令按需触发；`dry`：只生成不提示 |
| `apiKey`   | 空      | BigModel 开放平台 API key（<https://bigmodel.cn/usercenter/apikeys>），配置后启用 GLM 命名引擎 |
| `llmModel` | `GLM-5.3` | LLM 引擎模型                                                                                |
| `baseUrl`  | BigModel v4 | 兼容 OpenAI 协议的 API 地址，可替换为其他兼容服务                                        |
| `minOps`   | `2`     | 子目录被操作多少次才进标题（防误判）                                                          |
| `maxLen`   | `32`    | 标题长度上限（Unicode 字符）                                                                  |
| `delayMs`  | `10000` | Stop 后延迟读取毫秒数（等宿主持久化 turn 边界；示例配置用 6000 亦可）                        |

**不要把 apiKey 写进插件目录**：插件目录可能被市场更新整体覆盖或随仓库分发。

## 主动重命名（/rename-session）

不想每轮都处理、只在想要时刷新标题：把 `mode` 设为 `manual`，然后随时在输入框输入 `/rename-session`（命令面板可搜索点选），插件立即为**当前会话**生成并应用标题。

- 主动触发不受 `mode` 配置影响，一律写库改名（这正是"主动"的含义）
- 可重复触发：跳过指纹去重；插件自己改过的标题允许再次更新
- 用户手动命名的会话仍受保护，不会被覆盖
- 当前会话识别：会话库中最近更新的活跃会话（输入命令本身即刷新该会话的时间戳）
- 也可不经命令直接运行：`node ~/my/git/zcode-auto-rename/rename-now.mjs`

手动注册（安装方式二）的用户：slash 命令需要在命令根下才可发现，请将 `commands/rename-session.md` 复制到 `~/.zcode/commands/`（市场安装则自动生效）。命令文件新增后需新开会话或重启客户端才会出现在 `/` 菜单。

## auto 模式风险与边界

- 直接 UPDATE 本地 SQLite（`tasks-index.sqlite` + `cli/db/db.sqlite`），单事务、改后读回验证、置 `title_overridden=1` / `title_source='custom'` 防宿主回写。
- **已知边界**：桌面端可能缓存会话列表，写库后 UI 未必即时刷新（切换工作区或重启可见）。
- **活跃会话的宿主回写**：正在进行的会话，宿主会在 turn 持久化时用内存中的标题回写 tasks 表（并重置 `title_overridden`），改名在会话列表的显示可能被暂时还原；轮次结束、Stop hook 再次改名后恢复稳定。空闲会话的插件标题长期保留（实测验证）。
- 用户手动改过名的会话永久跳过，用户意志优先；插件自己写入的标题不锁死，可随会话演进继续更新（防宿主回写的 `title_overridden=1` 标记不视为手动改名）。
- ZCode 升级可能改变库 schema；出错时 worker 静默记日志（`~/.zcode/auto-rename/log.jsonl`），不影响对话。

## 存量回填

```bash
node backfill.mjs --dry-run            # 预览（不写库、不通知、不记指纹）
node backfill.mjs --workspace 日常工作 # 只处理路径包含该串的工作区
node backfill.mjs --days 30            # 只处理近 N 天有更新的会话
node backfill.mjs --limit 20           # 最多处理 N 个
node backfill.mjs                      # 批量写库改名（强制 auto 模式）
```

手动改过名（`title_overridden=1`）与归档/删除的会话自动跳过；回填使用独立状态目录 `.backfill-state/`，不影响 hook 的指纹去重。

## 开发与测试

```bash
node --test test/*.mjs # 单测 + 真实库集成测试（auto 模式在库副本上验证，不动真实数据）
```

仅依赖 Node ≥ 18 标准库与本机 `sqlite3` 命令，无第三方依赖。

## 目录结构

```
zcode-auto-rename/
├── .zcode-plugin/plugin.json   # 插件清单（名称、版本、关键词标签、hooks 声明）
├── marketplace.json            # 本地插件市场条目（源指向仓库根）
├── hooks/hooks.json            # Stop hook 声明（${ZCODE_PLUGIN_ROOT} 定位插件根）
├── commands/rename-session.md  # /rename-session 主动重命名命令
├── hook.mjs                    # Stop hook 入口（校验、派发、记录插件根路径）
├── worker.mjs                  # 命名编排（保护检查、指纹、双引擎、应用、配置解析）
├── rename-now.mjs              # 主动重命名（定位当前会话，强制应用、可重复触发）
├── session.mjs                 # 会话库只读访问
├── analyze.mjs                 # 规则引擎（子项目识别、主线提炼、标题组装）
├── llm.mjs                     # GLM 命名引擎（可选）
├── apply.mjs                   # 通知 + 双库改名
├── backfill.mjs                # 存量会话批量回填
├── config.example.json         # 配置模板（实际配置在 ~/.zcode/auto-rename/）
└── test/                       # node --test 单测与集成测试
```

运行期产物：`~/.zcode/auto-rename/`（config.json、state.json、log.jsonl、hook.log.jsonl、plugin-root）。

## 卸载

1. 移除注册来源：插件市场安装的在 **设置 → 插件管理** 卸载；手动注册的从 `~/.zcode/cli/config.json` 的 `hooks.events.Stop` 删除本插件条目；
2. 删除命令副本 `~/.zcode/commands/rename-session.md`（方式二用户）；
3. 删除 `~/.zcode/auto-rename/` 与本仓库目录。

## License

MIT
