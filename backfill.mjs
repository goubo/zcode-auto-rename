#!/usr/bin/env node
// 存量会话批量回填：按新命名规则重命名历史会话。
// 用法：
//   node backfill.mjs --dry-run                 # 预览（不写库、不通知、不记指纹）
//   node backfill.mjs --workspace 日常工作       # 只处理路径包含该串的工作区
//   node backfill.mjs --days 30                 # 只处理近 N 天有更新的会话
//   node backfill.mjs --limit 20                # 最多处理 N 个
//   node backfill.mjs                           # 全量执行（写库改名）
// 手动改过名（title_overridden=1）与归档/删除的会话自动跳过；活跃会话由 Stop hook 正常处理。
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// worker 的 STATE_DIR 在 import 时求值：必须先设 env 再动态 import，
// 否则回填会读到 hook 的共享 state，把曾被宿主覆盖的会话误判为 unchanged 跳过。
// 状态放用户目录（~/.zcode/auto-rename/）：插件目录在市场安装下是缓存，更新会被整体覆盖
const STATE_BASE = join(homedir(), ".zcode/auto-rename");
process.env.AUTO_RENAME_STATE_DIR ||= join(STATE_BASE, "backfill-state");

const execFileAsync = promisify(execFile);
const TASKS_DB = resolve(homedir(), ".zcode/v2/tasks-index.sqlite");
let runOnce, loadEffectiveConfig; // 动态 import 填充

function parseArgs(argv) {
  const args = { dryRun: false, workspace: null, days: null, limit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--workspace" && argv[i + 1]) args.workspace = argv[++i];
    else if (argv[i] === "--days" && argv[i + 1]) args.days = Number(argv[++i]);
    else if (argv[i] === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.dryRun) process.env.AUTO_RENAME_STATE_DIR += "-dry";
  ({ runOnce, loadEffectiveConfig } = await import("./worker.mjs"));
  const baseConfig = await loadEffectiveConfig();

  // 与 worker 同源的基础配置 + 固定模式：dry-run 预览（mode:dry）、真跑批量改名（mode:auto，回填的目的就是重命名）。
  // 两种模式都走临时配置文件（用户状态目录），结束后删除；dry-run 另用独立 state（不记指纹，后续真跑不受影响）
  const configPath = join(STATE_BASE, "backfill-config.json");
  await mkdir(STATE_BASE, { recursive: true });
  await writeFile(configPath, JSON.stringify({ ...baseConfig, mode: args.dryRun ? "dry" : "auto" }));

  const clauses = ["deleted=0", "archived=0", "title_overridden=0"];
  if (args.workspace) clauses.push(`workspace_path LIKE '%${args.workspace.replace(/'/g, "''")}%'`);
  if (args.days) clauses.push(`updated_at > ${Date.now() - args.days * 86400_000}`);
  let sql = `SELECT task_id, title, workspace_path FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC`;
  if (args.limit) sql += ` LIMIT ${args.limit}`;
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", TASKS_DB, sql], { encoding: "utf8" });
  const rows = JSON.parse(stdout.trim() || "[]");
  if (!rows.length) { console.log("没有待处理的会话"); return; }

  console.log(`待处理 ${rows.length} 个会话，模式: ${args.dryRun ? "预览（--dry-run，不写库）" : "写库改名"}\n`);
  let done = 0, skipped = 0, failed = 0;
  try {
    for (const row of rows) {
      process.stdout.write(`[${done + skipped + failed + 1}/${rows.length}] ${row.title.slice(0, 24).padEnd(26)} → `);
      try {
        const r = await runOnce({ sessionId: row.task_id, configPath });
        if (["renamed", "suggested"].includes(r.status)) {
          console.log(r.title ?? "-");
          done++;
        } else {
          console.log(`跳过（${r.status}）`);
          skipped++;
        }
      } catch (e) {
        console.log(`失败：${e.message.slice(0, 60)}`);
        failed++;
      }
    }
  } finally {
    await unlink(configPath).catch(() => {});
    console.log(`\n完成：改名 ${done}，跳过 ${skipped}，失败 ${failed}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("backfill error:", e.message); process.exit(1); });
