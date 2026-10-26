// 配置合并层单测（node --test）：UI userConfig > 用户文件 > 默认；显式文件整文件覆盖；apiKey 环境变量
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEffectiveConfig, readUserConfigValues } from "../worker.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ar-cfg-"));
const j = (dir, name, obj) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};

test("readUserConfigValues：cli config 的 plugins.options，name 与 name@market 均命中", async () => {
  const dir = tmp();
  const cli = j(dir, "cli.json", { plugins: { options: {
    "zcode-auto-rename@dev-market": { mode: "auto", minOps: 5 },
    "other-plugin@dev-market": { mode: "dry" },
  } } });
  const vals = await readUserConfigValues(cli, join(dir, "none.json"));
  assert.deepEqual(vals, { mode: "auto", minOps: 5 });
});

test("readUserConfigValues：options 为空时回退安装记录 configuredOptions", async () => {
  const dir = tmp();
  const cli = j(dir, "cli.json", { plugins: { options: {} } });
  const installed = j(dir, "installed.json", { plugins: [{ id: "zcode-auto-rename@off", configuredOptions: { maxLen: 24 } }] });
  const vals = await readUserConfigValues(cli, installed);
  assert.deepEqual(vals, { maxLen: 24 });
});

test("合并优先级：UI 值 > 用户文件 > 默认；未覆盖的键沿用下层", async () => {
  const dir = tmp();
  const cli = j(dir, "cli.json", { plugins: { options: { "zcode-auto-rename@off": { mode: "auto" } } } });
  const userFile = j(dir, "user.json", { mode: "manual", maxLen: 20, apiKey: "file-key" });
  const c = await loadEffectiveConfig({ cliConfigPath: cli, installedPath: join(dir, "none.json"), userConfigPath: userFile });
  assert.equal(c.mode, "auto", "UI 覆盖用户文件");
  assert.equal(c.maxLen, 20, "UI 未涉及的键沿用用户文件");
  assert.equal(c.apiKey, "file-key", "apiKey 从用户文件透传");
  assert.equal(c.minOps, 2, "无人配置的键用默认");
});

test("显式配置文件＝整文件覆盖：跳过 UI 与用户文件层", async () => {
  const dir = tmp();
  const cli = j(dir, "cli.json", { plugins: { options: { "zcode-auto-rename@off": { mode: "auto", minOps: 9 } } } });
  const userFile = j(dir, "user.json", { mode: "manual", maxLen: 20 });
  const explicit = j(dir, "explicit.json", { mode: "notify" });
  const c = await loadEffectiveConfig({ explicitPath: explicit, cliConfigPath: cli, installedPath: join(dir, "none.json"), userConfigPath: userFile });
  assert.equal(c.mode, "notify");
  assert.equal(c.minOps, 2, "显式文件未含的键回到默认，不读 UI/用户文件");
  assert.equal("apiKey" in c, false);
});

test("AUTO_RENAME_API_KEY 环境变量覆盖 apiKey", async () => {
  const dir = tmp();
  const userFile = j(dir, "user.json", { apiKey: "file-key" });
  process.env.AUTO_RENAME_API_KEY = "env-key";
  try {
    const c = await loadEffectiveConfig({ cliConfigPath: join(dir, "n1"), installedPath: join(dir, "n2"), userConfigPath: userFile });
    assert.equal(c.apiKey, "env-key");
  } finally {
    delete process.env.AUTO_RENAME_API_KEY;
  }
});
