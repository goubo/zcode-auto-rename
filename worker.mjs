// 后台命名 worker：hook 派发后延迟执行（等宿主完成 turn 持久化）。
// 流程：读会话 → 保护检查（手动改名/指纹去重）→ 分析 → 生成 → 应用（notify/auto）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  readTaskRow, readSessionRow, readUserInputs, readToolPaths, readFingerprint,
  SESSION_DB, TASKS_DB, assertSessionId,
} from "./session.mjs";
import { countSubProjects, mainThread, buildTitle, normalizeTitle } from "./analyze.mjs";
import { generateTitleWithLLM } from "./llm.mjs";
import { notify, applyRename, logJson } from "./apply.mjs";

const DELAY_MS = 10000;
const PLUGIN_NAME = "zcode-auto-rename";
const DEFAULT_STATE_DIR = join(homedir(), ".zcode/auto-rename");
const STATE_DIR = process.env.AUTO_RENAME_STATE_DIR || DEFAULT_STATE_DIR;
const STATE_FILE = join(STATE_DIR, "state.json");
const LOG_FILE = join(STATE_DIR, "log.jsonl");
const CLI_CONFIG_PATH = join(homedir(), ".zcode/cli/config.json");
const INSTALLED_PLUGINS_PATH = join(homedir(), ".zcode/cli/plugins/installed_plugins.json");

async function readJsonSafe(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

// 显式配置文件：--config 参数或 AUTO_RENAME_CONFIG 环境变量（整文件覆盖，用于测试与工具链完全掌控）
export function resolveExplicitConfigPath() {
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--config" && process.argv[i + 1]) return resolve(process.argv[++i]);
  }
  return process.env.AUTO_RENAME_CONFIG ? resolve(process.env.AUTO_RENAME_CONFIG) : null;
}

// 插件详情页 Advanced 的 userConfig 值：宿主持久化于 cli config 的 plugins.options，
// 安装记录另存 configuredOptions（互为冗余）；键匹配 name 或 name@marketplace
export async function readUserConfigValues(cliConfigPath = CLI_CONFIG_PATH, installedPath = INSTALLED_PLUGINS_PATH) {
  const values = {};
  const cli = await readJsonSafe(cliConfigPath);
  for (const [key, val] of Object.entries(cli?.plugins?.options ?? {})) {
    if ((key === PLUGIN_NAME || key.startsWith(PLUGIN_NAME + "@")) && val && typeof val === "object") Object.assign(values, val);
  }
  if (Object.keys(values).length) return values;
  const scan = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) scan(n); return; }
    const id = node.id ?? node.name;
    if (typeof id === "string" && (id === PLUGIN_NAME || id.startsWith(PLUGIN_NAME + "@")) && node.configuredOptions) {
      Object.assign(values, node.configuredOptions);
    }
    for (const v of Object.values(node)) scan(v);
  };
  scan(await readJsonSafe(installedPath));
  return values;
}

// 配置合并：
//   显式文件（--config / AUTO_RENAME_CONFIG / runOnce 的 configPath 参数）＝ 整文件覆盖，跳过其余层
//   否则按 key 覆盖：UI userConfig > ~/.zcode/auto-rename/config.json > 插件目录 config.json（历史兼容）> 默认
//   AUTO_RENAME_API_KEY 环境变量单独覆盖 apiKey（敏感项不进 UI，见 plugin.json userConfig）
export async function loadEffectiveConfig({ explicitPath = null, overrides = {}, cliConfigPath, installedPath, userConfigPath } = {}) {
  const defaults = { mode: "notify", minOps: 2, maxLen: 32, delayMs: DELAY_MS, enabled: true };
  if (explicitPath) {
    const explicit = (await readJsonSafe(explicitPath)) ?? {};
    return { ...defaults, ...explicit, ...overrides };
  }
  const legacy = (await readJsonSafe(fileURLToPath(new URL("./config.json", import.meta.url)))) ?? {};
  const userFile = (await readJsonSafe(userConfigPath ?? join(DEFAULT_STATE_DIR, "config.json"))) ?? {};
  const uiValues = await readUserConfigValues(cliConfigPath, installedPath);
  const config = { ...defaults, ...legacy, ...userFile, ...uiValues };
  if (process.env.AUTO_RENAME_API_KEY) config.apiKey = process.env.AUTO_RENAME_API_KEY;
  return { ...config, ...overrides };
}

export async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { return {}; }
}

export async function saveState(state) {
  // 写前重读并按条目时间戳合并：并发 worker（多窗口 hook / 命令触发）共享同一个 state.json，
  // 整体覆盖会用启动时的旧快照冲掉其他进程刚写入的条目
  const latest = await loadState();
  const merged = { ...latest };
  for (const [k, v] of Object.entries(state)) {
    if (!merged[k] || (v.at ?? "") >= (merged[k].at ?? "")) merged[k] = v;
  }
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(merged, null, 2), "utf8");
}

export async function runOnce({ sessionId, configPath, sessionDb = SESSION_DB, tasksDb = TASKS_DB, now = Date.now, force = false, overrides = {} }) {
  assertSessionId(sessionId);
  const config = await loadEffectiveConfig({ explicitPath: configPath, overrides });
  const log = (entry) => logJson(LOG_FILE, { sessionId, ...entry });
  if (config.enabled === false) return { status: "disabled" };
  // manual 模式：Stop hook 不做任何处理，仅 /rename-session 命令按需触发（rename-now.mjs 用 overrides 覆盖）
  if (config.mode === "manual") return { status: "manual_mode" };

  const [taskRow, sessionRow] = await Promise.all([
    readTaskRow(sessionId, tasksDb),
    readSessionRow(sessionId, sessionDb),
  ]);
  if (!sessionRow && !taskRow) return { status: "not_found" };
  if (taskRow?.archived || taskRow?.deleted) return { status: "archived" };

  const fingerprint = await readFingerprint(sessionId, sessionDb);
  const state = await loadState();
  const prev = state[sessionId];
  const currentTitle = taskRow?.title ?? sessionRow?.title ?? "";
  // 手动改名保护：title_source=custom / title_overridden=1 视为用户意志，永不覆盖。
  // 例外：任一库仍保留本插件上次写入的标题（applied=renamed）时，overridden/custom 标记只是
  // 防宿主回写的副作用（宿主可能只回写 tasks 表并重置标记），允许随演进继续更新；
  // 用户手动改名会同时更新两库标题，不会误入此分支
  const pluginOwned = prev?.applied === "renamed" &&
    (prev.title === currentTitle || prev.title === sessionRow?.title);
  if (!pluginOwned && (sessionRow?.title_source === "custom" || taskRow?.title_overridden === 1)) return { status: "manual_title" };
  // 指纹去重：无新消息不重复命名；force 供 /rename-session 主动触发
  if (!force && prev?.fingerprint === fingerprint) return { status: "unchanged" };

  const workspacePath = sessionRow?.directory ?? taskRow?.workspace_path;
  const [userInputs, toolPaths] = await Promise.all([
    readUserInputs(sessionId, sessionDb),
    readToolPaths(sessionId, sessionDb),
  ]);
  const subProjects = countSubProjects(toolPaths, workspacePath);
  const thread = mainThread(userInputs);
  let title = null;
  let engine = "rule";
  if (config.apiKey) {
    engine = "llm";
    try {
      title = await generateTitleWithLLM({
        userInputs, subProjects,
        workspaceName: workspacePath?.split("/").filter(Boolean).pop() ?? "",
        apiKey: config.apiKey,
        model: config.llmModel ?? "GLM-5.3",
      });
    } catch (e) { log({ action: "llm_error", error: String(e.message).slice(0, 120) }).catch(() => {}); }
    if (!title) engine = "rule(fallback)";
  }
  if (!title) title = buildTitle({ subProjects, thread, minOps: config.minOps, maxLen: config.maxLen });
  if (!title) { await log({ action: "skip_no_content" }); return { status: "skip_no_content" }; }

  if (normalizeTitle(title) === normalizeTitle(currentTitle)) {
    // 保留 prev 的 applied/engine：same_as_current 不改名，所有权记录不能丢
    state[sessionId] = { ...prev, fingerprint, title, at: new Date(now()).toISOString() };
    await saveState(state);
    return { status: "same_as_current", title };
  }

  let applied = "suggested";
  let error = null;
  if (config.mode === "auto") {
    try {
      await applyRename({ sessionId, title, sessionDb, tasksDb });
      applied = "renamed";
    } catch (e) { error = String(e.message).slice(0, 200); applied = "rename_failed"; }
  }
  if (applied !== "renamed" && config.mode !== "dry") {
    // notify 模式或 auto 失败兜底：macOS 通知提示 + 建议落日志，用户自行决定是否手动改名
    await notify({
      title: applied === "rename_failed" ? "会话命名建议（自动改名失败）" : "会话命名建议",
      subtitle: currentTitle.slice(0, 24),
      body: title,
    });
  }
  state[sessionId] = { fingerprint, title, applied, engine, at: new Date(now()).toISOString() };
  await saveState(state);
  await log({ action: applied, title, oldTitle: currentTitle, engine, subProjects: subProjects.slice(0, 3), turns: thread?.turns ?? 0, evolved: thread?.evolved ?? false, error });
  return { status: applied, title, engine, evolved: thread?.evolved ?? false };
}

// 配置查找顺序：--config 参数 > AUTO_RENAME_CONFIG 环境变量 > 用户配置（~/.zcode/auto-rename/config.json，
// 独立于插件目录，市场安装/升级不丢失）> 插件目录 config.json。返回首个存在的路径；都不存在返回 null（内置默认值）。
export async function resolveConfigPath() {
  const candidates = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--config" && process.argv[i + 1]) candidates.push(resolve(process.argv[++i]));
  }
  if (process.env.AUTO_RENAME_CONFIG) candidates.push(resolve(process.env.AUTO_RENAME_CONFIG));
  candidates.push(join(DEFAULT_STATE_DIR, "config.json"));
  candidates.push(fileURLToPath(new URL("./config.json", import.meta.url)));
  for (const p of candidates) {
    try {
      await readFile(p, "utf8");
      return p;
    } catch {}
  }
  return null;
}

export async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const event = JSON.parse(raw);
  const config = await loadEffectiveConfig({ explicitPath: resolveExplicitConfigPath() });
  if (config.mode === "manual") {
    // manual 模式：不延迟、不分析、不通知，标题只在 /rename-session 命令触发时更新
    process.stderr.write("auto-rename: manual mode, hook skipped\n");
    return;
  }
  // 等 Stop 收尾窗口：此刻宿主仍在持久化 turn 边界，立即读会指纹漂移
  await new Promise((r) => setTimeout(r, config.delayMs ?? DELAY_MS));
  const result = await runOnce({ sessionId: event.session_id ?? event.sessionId, configPath });
  process.stderr.write(`auto-rename: ${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { process.stderr.write(`auto-rename error: ${e.message}\n`); process.exit(0); });
