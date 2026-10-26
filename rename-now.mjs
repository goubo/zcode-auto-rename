#!/usr/bin/env node
// 主动重命名当前会话：/rename-session 命令（或直接运行本脚本）触发，不受 mode 配置限制、强制写库改名。
// 当前会话识别：tasks 索引中最近更新的活跃会话——输入命令本身就会刷新该会话的 updated_at。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runOnce } from "./worker.mjs";

const execFileAsync = promisify(execFile);
const TASKS_DB = join(homedir(), ".zcode/v2/tasks-index.sqlite");

async function latestActiveSession() {
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-readonly", "-json", TASKS_DB, "SELECT task_id, title FROM tasks WHERE deleted=0 AND archived=0 ORDER BY updated_at DESC LIMIT 1;"],
    { encoding: "utf8" },
  );
  return JSON.parse(stdout.trim() || "[]")[0] ?? null;
}

const MESSAGES = {
  renamed: (r, old) => `已重命名：${old || "（无标题）"} → ${r.title}（引擎：${r.engine}）`,
  same_as_current: (r) => `标题已是最新：${r.title}`,
  unchanged: () => "无新内容，标题未变",
  manual_title: () => "当前会话为手动命名，按保护规则不覆盖",
  not_found: () => "未找到会话记录",
  archived: () => "会话已归档",
  skip_no_content: () => "会话无可用的命名依据（无实质输入）",
  disabled: () => "插件已停用（enabled=false）",
};

async function main() {
  const row = await latestActiveSession();
  if (!row) { console.log("没有活跃会话"); return; }
  // 不传 configPath：走完整配置层（UI userConfig + 用户配置文件），再强制 auto 应用
  const result = await runOnce({
    sessionId: row.task_id,
    overrides: { mode: "auto" },
    force: true, // 跳过指纹去重：允许重复触发
  });
  const render = MESSAGES[result.status];
  console.log(render ? render(result, row.title) : `状态：${result.status}${result.title ? "：" + result.title : ""}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("rename-now error:", e.message); process.exit(1); });
