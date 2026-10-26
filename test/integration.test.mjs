// 集成测试：真实库只读 + 库副本上验证 auto 改名。
// 运行：node --test test/integration.test.mjs（需要本机存在 ZCode 会话数据）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readSessionRow, readTaskRow, readUserInputs, readToolPaths, SESSION_DB, TASKS_DB } from "../session.mjs";
import { runOnce, saveState, loadState } from "../worker.mjs";

const execFileAsync = promisify(execFile);
const sql = async (db, s) => {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", db, s], { encoding: "utf8" });
  return JSON.parse(stdout.trim() || "[]");
};

// 选一个有真实对话、generated 标题、未手动改名的旧会话
async function pickSession() {
  const rows = await sql(
    TASKS_DB,
    `SELECT task_id, workspace_path FROM tasks
     WHERE deleted=0 AND title_overridden=0 AND workspace_path LIKE '%日常工作%'
     ORDER BY updated_at DESC LIMIT 5;`
  );
  for (const r of rows) {
    const s = await readSessionRow(r.task_id);
    if (s && s.title_source === "generated") return r.task_id;
  }
  return null;
}

test("真实库：能读取用户输入、指纹与任务行", { skip: false }, async () => {
  const sid = await pickSession();
  if (!sid) return; // 无合适样本时跳过
  const inputs = await readUserInputs(sid);
  assert.ok(inputs.length >= 1, "应至少有一条用户输入");
  const task = await readTaskRow(sid);
  assert.equal(task.task_id, sid);
});

test("notify 模式端到端：生成建议并记录状态，不动真实库", async () => {
  const sid = await pickSession();
  if (!sid) return;
  const stateDir = mkdtempSync(join(tmpdir(), "ar-state-"));
  process.env.AUTO_RENAME_STATE_DIR = stateDir;
  const result = await runOnce({ sessionId: sid, configPath: null });
  assert.ok(["suggested", "same_as_current", "unchanged", "skip_no_content", "manual_title"].includes(result.status));
  if (result.status === "suggested") {
    assert.ok(result.title && result.title.length > 3);
    const again = await runOnce({ sessionId: sid, configPath: null });
    assert.equal(again.status, "unchanged", "指纹去重：第二次应跳过");
  }
  delete process.env.AUTO_RENAME_STATE_DIR;
});

test("manual 模式：runOnce 直接跳过，不分析不改名", async () => {
  const sid = await pickSession();
  if (!sid) return;
  const dir = mkdtempSync(join(tmpdir(), "ar-manual-"));
  process.env.AUTO_RENAME_STATE_DIR = dir;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ mode: "manual" }));
  const r = await runOnce({ sessionId: sid, configPath });
  assert.equal(r.status, "manual_mode");
  delete process.env.AUTO_RENAME_STATE_DIR;
});

test("插件自改名会话不被 manual 保护误锁，force 可重复触发", async () => {
  const sid = await pickSession();
  if (!sid) return;
  const dir = mkdtempSync(join(tmpdir(), "ar-force-"));
  const sessionDb = join(dir, "db.sqlite");
  const tasksDb = join(dir, "tasks.sqlite");
  await execFileAsync("sqlite3", [SESSION_DB, `.backup '${sessionDb}'`]);
  await execFileAsync("sqlite3", [TASKS_DB, `.backup '${tasksDb}'`]);
  await execFileAsync("sqlite3", [sessionDb, "PRAGMA journal_mode=DELETE;"]);
  await execFileAsync("sqlite3", [tasksDb, "PRAGMA journal_mode=DELETE;"]);
  const stateDir = mkdtempSync(join(tmpdir(), "ar-state-"));
  process.env.AUTO_RENAME_STATE_DIR = stateDir;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ mode: "auto", minOps: 0, maxLen: 32 }));

  const first = await runOnce({ sessionId: sid, configPath, sessionDb, tasksDb });
  assert.equal(first.status, "renamed", "首次 auto 改名");
  // 改名后 title_overridden=1：因标题是插件自己写入的（state 记录），不得按 manual_title 锁死；
  // 指纹未变 → unchanged（而不是 manual_title）
  const second = await runOnce({ sessionId: sid, configPath, sessionDb, tasksDb });
  assert.equal(second.status, "unchanged", "插件自改名放行，指纹去重生效");
  // force（/rename-session 路径）：跳过指纹去重重新生成；标题不变则 same_as_current
  const third = await runOnce({ sessionId: sid, configPath, sessionDb, tasksDb, force: true, overrides: { mode: "auto" } });
  assert.ok(["same_as_current", "renamed"].includes(third.status), `force 应重新生成，实际 ${third.status}`);
  // 宿主只回写 tasks 表（重置标题与标记，session 库保留插件标题）：不得误判 manual_title
  await execFileAsync("sqlite3", [tasksDb, `UPDATE tasks SET title='宿主回写标题', title_overridden=0 WHERE task_id='${sid}';`]);
  const fourth = await runOnce({ sessionId: sid, configPath, sessionDb, tasksDb });
  assert.equal(fourth.status, "unchanged", "session 库保留插件标题时放行");
  delete process.env.AUTO_RENAME_STATE_DIR;
});

test("saveState 并发合并：旧快照不冲掉更新的条目", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-merge-"));
  process.env.AUTO_RENAME_STATE_DIR = dir;
  await saveState({ a: { at: "2026-01-01T00:00:00Z", title: "新", applied: "renamed" } });
  // 模拟另一 worker 用启动时的旧快照写回：a 是旧版本，b 是它自己的新条目
  await saveState({ a: { at: "2025-12-31T00:00:00Z", title: "旧", applied: "renamed" }, b: { at: "2026-01-01T00:00:01Z", title: "x" } });
  const s = await loadState();
  assert.equal(s.a.title, "新", "旧快照不得覆盖更新的条目");
  assert.ok(s.b, "其他进程刚写入的条目被保留");
  delete process.env.AUTO_RENAME_STATE_DIR;
});

test("auto 模式在库副本上改写标题且读回一致", async () => {
  const sid = await pickSession();
  if (!sid) return;
  const dir = mkdtempSync(join(tmpdir(), "ar-db-"));
  const sessionDb = join(dir, "db.sqlite");
  const tasksDb = join(dir, "tasks.sqlite");
  // 源库带活跃 WAL；.backup 快照仍为 WAL 模式，-readonly 打开需 shm——写模式打开一次转为 DELETE
  await execFileAsync("sqlite3", [SESSION_DB, `.backup '${sessionDb}'`]);
  await execFileAsync("sqlite3", [TASKS_DB, `.backup '${tasksDb}'`]);
  await execFileAsync("sqlite3", [sessionDb, "PRAGMA journal_mode=DELETE;"]);
  await execFileAsync("sqlite3", [tasksDb, "PRAGMA journal_mode=DELETE;"]);
  const stateDir = mkdtempSync(join(tmpdir(), "ar-state-"));
  process.env.AUTO_RENAME_STATE_DIR = stateDir;
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ mode: "auto", minOps: 0, maxLen: 32 }));

  const before = await readTaskRow(sid, tasksDb);
  const result = await runOnce({ sessionId: sid, configPath, sessionDb, tasksDb });
  if (result.status === "renamed") {
    const task = await readTaskRow(sid, tasksDb);
    const session = await readSessionRow(sid, sessionDb);
    assert.equal(task.title, result.title);
    assert.equal(task.title_overridden, 1);
    assert.equal(session.title, result.title);
    assert.equal(session.title_source, "custom");
    assert.notEqual(task.title, before.title);
    // 改名后再次运行：标题是插件写入的（非用户手动），不锁死，走指纹去重返回 unchanged
    const after = await runOnce({ sessionId: sid, configPath, sessionDb, tasksDb });
    assert.equal(after.status, "unchanged");
  }
  delete process.env.AUTO_RENAME_STATE_DIR;
});
