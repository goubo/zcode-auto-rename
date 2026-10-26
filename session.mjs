// 会话数据读取：ZCode 本地 SQLite（只读）。
// cli/db/db.sqlite：session + message + part（完整会话内容）
// v2/tasks-index.sqlite：tasks（桌面端会话列表索引）
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export const SESSION_DB = join(homedir(), ".zcode/cli/db/db.sqlite");
export const TASKS_DB = join(homedir(), ".zcode/v2/tasks-index.sqlite");

const SESSION_ID_RE = /^sess(?:ion)?_[A-Za-z0-9_-]+$/;

export function assertSessionId(sessionId) {
  if (!SESSION_ID_RE.test(sessionId ?? "")) throw new Error("无效的 session_id");
}

async function queryJson(db, sql) {
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = stdout.trim();
  return text ? JSON.parse(text) : [];
}

export async function readTaskRow(sessionId, tasksDb = TASKS_DB) {
  assertSessionId(sessionId);
  const rows = await queryJson(
    tasksDb,
    `SELECT task_id, workspace_path, title, task_status, title_overridden, archived, deleted
     FROM tasks WHERE task_id='${sessionId}';`
  );
  return rows[0] ?? null;
}

export async function readSessionRow(sessionId, sessionDb = SESSION_DB) {
  assertSessionId(sessionId);
  const rows = await queryJson(
    sessionDb,
    `SELECT id, title, title_source, directory, time_updated
     FROM session WHERE id='${sessionId}';`
  );
  return rows[0] ?? null;
}

// 真实用户输入：message.semantics.origin='real_user' 且 kind='user_prompt'，
// 文本在 part（type=text、非 synthetic）。
export async function readUserInputs(sessionId, sessionDb = SESSION_DB) {
  assertSessionId(sessionId);
  const rows = await queryJson(
    sessionDb,
    `SELECT p.data AS part_data, m.time_created
     FROM part p JOIN message m ON p.message_id = m.id
     WHERE p.session_id='${sessionId}'
       AND p.sequence IS NOT NULL AND p.sequence >= 0
       AND json_extract(m.data,'$.semantics.origin')='real_user'
       AND json_extract(m.data,'$.semantics.kind')='user_prompt'
       AND json_extract(p.data,'$.type')='text'
       AND json_extract(p.data,'$.synthetic') IS NULL
     ORDER BY m.time_created, p.sequence;`
  );
  return rows.map((r) => ({ text: JSON.parse(r.part_data).text ?? "", time: r.time_created })).filter((r) => r.text);
}

// 工具调用中的本地路径（file_path/filePWD/command 里的绝对路径），用于识别子项目。
export async function readToolPaths(sessionId, sessionDb = SESSION_DB, limit = 400) {
  assertSessionId(sessionId);
  const rows = await queryJson(
    sessionDb,
    `SELECT p.data AS part_data
     FROM part p
     WHERE p.session_id='${sessionId}'
       AND json_extract(p.data,'$.type')='tool'
       AND json_extract(p.data,'$.state.input') IS NOT NULL
     ORDER BY p.time_created DESC LIMIT ${limit};`
  );
  const paths = [];
  for (const r of rows) {
    const input = JSON.parse(r.part_data)?.state?.input ?? {};
    for (const value of [input.file_path, input.filePath, input.notebook_path, input.path]) {
      if (typeof value === "string" && value.startsWith("/")) paths.push(value);
    }
    // Bash/命令类没有结构化路径，跳过：命令文本噪声大，误判子项目的代价高于收益
  }
  return paths;
}

// 会话指纹：消息数 + 最新消息时间。无新内容时跳过命名。
export async function readFingerprint(sessionId, sessionDb = SESSION_DB) {
  assertSessionId(sessionId);
  const rows = await queryJson(
    sessionDb,
    `SELECT COUNT(*) AS n, COALESCE(MAX(time_created),0) AS last FROM message WHERE session_id='${sessionId}';`
  );
  return rows[0] ? `${rows[0].n}:${rows[0].last}` : "0:0";
}
