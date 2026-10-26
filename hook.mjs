#!/usr/bin/env node
// ZCode Stop Hook 入口：校验 payload 后立即派发后台 worker（hook 内联执行，不能阻塞对话）。
// stdout 不输出 JSON（避免被宿主解析为 hook 决策）；结果走 state/log 文件。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(homedir(), ".zcode/auto-rename");

export function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return { action: "ignored_invalid" };
  if (payload.stop_hook_active === true) return { action: "skipped_stale" };
  const sessionId = payload.session_id ?? payload.sessionId;
  const workspacePath = payload.workspace_path ?? payload.cwd;
  if (!/^sess(?:ion)?_[A-Za-z0-9_-]+$/.test(sessionId ?? "") || !workspacePath) return { action: "ignored_invalid" };
  return { action: "dispatched", sessionId, workspacePath };
}

function spawnWorker({ sessionId, workspacePath }) {
  const args = [join(pluginRoot, "worker.mjs")];
  if (process.env.AUTO_RENAME_CONFIG) args.push("--config", process.env.AUTO_RENAME_CONFIG);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env },
  });
  child.stdin.end(JSON.stringify({ session_id: sessionId, workspace_path: workspacePath }));
  child.unref();
}

export async function dispatch(payload) {
  const validated = validatePayload(payload);
  if (validated.action !== "dispatched") return validated;
  spawnWorker(validated);
  return validated;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload = null;
  try { payload = JSON.parse(raw); } catch {}
  let result;
  try {
    result = await dispatch(payload);
  } catch (error) {
    result = { action: "error", error: String(error.message).slice(0, 200) };
  }
  // 非 JSON 前缀输出，防止宿主把日志当 hook 决策解析
  process.stdout.write(`auto-rename hook: ${result.action}\n`);
  try {
    await mkdir(STATE_DIR, { recursive: true });
    // 记录插件根路径：/rename-session 命令据此定位脚本，兼容源码目录与市场安装缓存两种位置
    await writeFile(join(STATE_DIR, "plugin-root"), pluginRoot + "\n", "utf8");
    await appendFile(join(STATE_DIR, "hook.log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n", "utf8");
  } catch {}
  process.exit(0);
}
