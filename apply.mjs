// 标题应用：notify（默认，macOS 通知 + 建议记录）与 auto（双库写入）。
// auto 模式直接 UPDATE 本地 SQLite：短事务、双库同步（tasks 索引 + cli 会话库）。
// 已知边界：桌面端可能缓存会话列表，写库后 UI 未必即时刷新（重开列表可见）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export async function notify({ title, body, subtitle }) {
  const esc = (s) => (s ?? "").replace(/["\\]/g, "\\$&");
  const sub = subtitle ? ` with subtitle "${esc(subtitle)}"` : "";
  const script = `display notification "${esc(body)}"${sub} with title "${esc(title)}"`;
  try {
    await execFileAsync("osascript", ["-e", script]);
    return true;
  } catch {
    return false; // 无通知权限等场景静默失败，不影响主流程
  }
}

async function writeDb(db, sql) {
  // 不用 -readonly；单条语句即单事务，WAL 下短写安全
  await execFileAsync("sqlite3", [db, sql], { encoding: "utf8", maxBuffer: 1024 * 1024 });
}

// 单引号 SQL 转义
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

export async function applyRename({ sessionId, title, sessionDb, tasksDb, settleMs = 4000 }) {
  const verify = async (db, sql) => {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8" });
    return JSON.parse(stdout.trim() || "[]");
  };
  const write = async () => {
    const now = Date.now();
    // tasks 索引是桌面端列表数据源；title_overridden=1 防止宿主自动命名回写
    await writeDb(tasksDb, `UPDATE tasks SET title=${q(title)}, title_overridden=1, updated_at=${now} WHERE task_id=${q(sessionId)};`);
    // cli 会话库保持同步，title_source='custom' 同样阻止宿主覆盖
    await writeDb(sessionDb, `UPDATE session SET title=${q(title)}, title_source='custom', time_title_updated=${now} WHERE id=${q(sessionId)};`);
  };
  await write();
  // 活跃会话的宿主在 Stop 后仍会写 task 行，可能用内存旧标题覆盖本次改名；
  // 等收尾窗口过后复查，被覆盖则重写一次
  await new Promise((r) => setTimeout(r, settleMs));
  const [t, s] = await Promise.all([
    verify(tasksDb, `SELECT title FROM tasks WHERE task_id=${q(sessionId)};`),
    verify(sessionDb, `SELECT title FROM session WHERE id=${q(sessionId)};`),
  ]);
  if (t[0]?.title !== title || s[0]?.title !== title) {
    await write();
    const [t2, s2] = await Promise.all([
      verify(tasksDb, `SELECT title FROM tasks WHERE task_id=${q(sessionId)};`),
      verify(sessionDb, `SELECT title FROM session WHERE id=${q(sessionId)};`),
    ]);
    if (t2[0]?.title !== title || s2[0]?.title !== title) throw new Error("改名后被宿主覆盖且重写失败");
    return { retried: true };
  }
  return { retried: false };
}

export async function logJson(path, entry) {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await appendFile(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}
