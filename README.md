# zcode-auto-rename

[![Plugin](https://img.shields.io/badge/ZCode-Plugin-blue)](./.zcode-plugin/plugin.json) [![Version](https://img.shields.io/badge/version-1.2.0-green)](./.zcode-plugin/plugin.json) [![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

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

通过插件市场安装（唯一支持方式）。本插件收录在 [goubo/zcode-plugins](https://github.com/goubo/zcode-plugins) 市场：

1. ZCode → **设置 → 插件管理 → Discover 页签 → `+` → 添加插件市场**，粘贴市场仓库地址：<https://github.com/goubo/zcode-plugins>；
2. 在市场列表找到 `zcode-auto-rename` → **Get**，安装后默认启用，Stop hook 与 `/rename-session` 命令自动注册；
3. 新开会话生效。更新：插件管理界面刷新市场后按提示升级。

运行依赖：系统 `node ≥ 18` 与 `sqlite3` 命令（macOS 自带 sqlite3；hook 进程由宿主以 `node` 启动）。

> 历史说明：v1.1 及之前支持在 `~/.zcode/cli/config.json` 手动注册 Stop hook，该方式已不再维护；仍在使用的，安装本插件后请删除手动注册条目，避免同一会话双重触发。

## 配置

两层配置，按 key 合并，**插件设置（UI）优先**。日常调整（切 notify/auto/manual 模式、阈值、延迟、模型、API 地址）全部在设置页面完成；**只有更换 apiKey 才需要动一次配置文件**——宿主目前没有凭据存储，敏感值无法经设置页持久化。

### 1. 插件设置（推荐）

**设置 → 插件管理 → 已安装 → zcode-auto-rename → Advanced**：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| 命名模式 `mode` | `notify` | `notify`：每轮结束 macOS 通知建议标题；`auto`：直接写库改名（见风险）；`manual`：每轮不处理，仅 `/rename-session` 按需触发；`dry`：只生成不提示 |
| `minOps` | `2` | 子目录被工具操作多少次才进标题前缀（防误判） |
| `maxLen` | `32` | 标题长度上限（Unicode 字符） |
| `delayMs` | `10000` | Stop 后延迟读取会话库的毫秒数 |
| `llmModel` | `GLM-5.3` | GLM 命名引擎模型 |
| `baseUrl` | BigModel v4 | 兼容 OpenAI 协议的 API 地址 |

### 2. 用户配置文件 `~/.zcode/auto-rename/config.json`

放 UI 无法承载的项（模板见 `config.example.json`）：

- **`apiKey`**（BigModel 开放平台 <https://bigmodel.cn/usercenter/apikeys>）：启用 GLM 命名引擎；设置页无法承载敏感值（宿主暂无凭据存储），仅更换 key 时编辑此文件，或改用环境变量 `AUTO_RENAME_API_KEY`
- `enabled`：总开关（与插件启停独立）
- 上述任何 key 也都可写在这里（会被 UI 同名值覆盖）

合并顺序：`--config` / `AUTO_RENAME_CONFIG` 显式文件（整文件覆盖，测试与工具链用）> 插件设置（UI）> `~/.zcode/auto-rename/config.json` > 插件目录 `config.json`（历史兼容）> 默认值。

## 主动重命名（/rename-session）

不想每轮都处理、只在想要时刷新标题：把命名模式设为 `manual`，然后随时在输入框输入 `/rename-session`（命令面板可搜索点选），插件立即为**当前会话**生成并应用标题。

- 主动触发不受 `mode` 配置影响，一律写库改名（这正是"主动"的含义）
- 可重复触发：跳过指纹去重；插件自己改过的标题允许再次更新
- 用户手动命名的会话仍受保护，不会被覆盖
- 当前会话识别：会话库中最近更新的活跃会话（输入命令本身即刷新该会话的时间戳）

## auto 模式风险与边界

- 直接 UPDATE 本地 SQLite（`tasks-index.sqlite` + `cli/db/db.sqlite`），单事务、改后读回验证、置 `title_overridden=1` / `title_source='custom'` 防宿主回写。
- **已知边界**：桌面端可能缓存会话列表，写库后 UI 未必即时刷新（切换工作区或重启可见）。
- **活跃会话的宿主回写**：正在进行的会话，宿主会在 turn 持久化时用内存中的标题回写 tasks 表（并重置 `title_overridden`），改名在会话列表的显示可能被暂时还原；轮次结束、Stop hook 再次改名后恢复稳定。空闲会话的插件标题长期保留（实测验证）。
- 用户手动改过名的会话永久跳过；插件自己写入的标题不锁死，可随会话演进继续更新。
- ZCode 升级可能改变库 schema；出错时 worker 静默记日志（`~/.zcode/auto-rename/log.jsonl`），不影响对话。

## 存量回填

```bash
node backfill.mjs --dry-run            # 预览（不写库、不通知、不记指纹）
node backfill.mjs --workspace 日常工作 # 只处理路径包含该串的工作区
node backfill.mjs --days 30            # 只处理近 N 天有更新的会话
node backfill.mjs --limit 20           # 最多处理 N 个
node backfill.mjs                      # 批量写库改名（强制 auto 模式）
```

手动改过名（`title_overridden=1`）与归档/删除的会话自动跳过；回填配置与状态在 `~/.zcode/auto-rename/backfill-state/`，不影响 hook 的指纹去重。

## 开发与测试

```bash
node --test test/*.mjs # 单测 + 真实库集成测试（auto 模式在库副本上验证，不动真实数据）
```

仅依赖 Node ≥ 18 标准库与本机 `sqlite3` 命令，无第三方依赖。

## 目录结构

```
zcode-auto-rename/
├── .zcode-plugin/plugin.json   # 插件清单（版本、关键词标签、hooks/commands/userConfig 声明）
├── hooks/hooks.json            # Stop hook 声明（${ZCODE_PLUGIN_ROOT} 定位插件根）
├── commands/rename-session.md  # /rename-session 主动重命名命令
├── hook.mjs                    # Stop hook 入口（校验、派发、记录插件根路径）
├── worker.mjs                  # 命名编排（保护检查、指纹、双引擎、应用、配置合并）
├── rename-now.mjs              # 主动重命名（定位当前会话，强制应用、可重复触发）
├── session.mjs                 # 会话库只读访问
├── analyze.mjs                 # 规则引擎（子项目识别、主线提炼、标题组装）
├── llm.mjs                     # GLM 命名引擎（可选）
├── apply.mjs                   # 通知 + 双库改名
├── backfill.mjs                # 存量会话批量回填
├── config.example.json         # 配置模板（实际配置在 ~/.zcode/auto-rename/）
└── test/                       # node --test 单测与集成测试
```

运行期产物全部在 `~/.zcode/auto-rename/`（config.json、state.json、log.jsonl、hook.log.jsonl、plugin-root、backfill-state/），插件安装目录可被市场更新整体覆盖而无损。

## 卸载

1. **设置 → 插件管理 → 已安装 → zcode-auto-rename** → 卸载；
2. 删除 `~/.zcode/auto-rename/` 与本仓库目录。

## License

MIT
