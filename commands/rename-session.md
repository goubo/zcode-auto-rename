---
description: 主动重命名当前会话（zcode-auto-rename 插件）
allowed-tools: Bash
---

为当前会话生成并应用新标题。运行以下命令并把输出结果转述给用户：

```bash
ROOT="$(cat ~/.zcode/auto-rename/plugin-root 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(ls -d ~/.zcode/cli/plugins/cache/*/zcode-auto-rename/*/ 2>/dev/null | sort -V | tail -1)"
node "${ROOT%/}/rename-now.mjs"
```

把脚本输出如实转述给用户：成功时报告新标题；`manual_title` 表示会话为手动命名、按用户意志不覆盖；其余状态按输出解释。除运行该脚本和转述结果外，不要执行任何其他操作。
