// 分析器与命名规则单测（node --test）
import test from "node:test";
import assert from "node:assert/strict";
import {
  subProjectFromPath, countSubProjects, cleanInput, distillGoal,
  isSubstantive, buildTitle, normalizeTitle, charLen,
} from "../analyze.mjs";

const WS = "/workspaces/daily-work";

test("子项目识别：workspace 内一级目录，排除噪声与根", () => {
  assert.equal(subProjectFromPath(`${WS}/公司事务/绩效.md`, WS), "公司事务");
  assert.equal(subProjectFromPath(`${WS}/.zcode/x`, WS), null);
  assert.equal(subProjectFromPath(`${WS}/node_modules/y`, WS), null);
  assert.equal(subProjectFromPath(WS + "/file.md", WS), null); // 根文件不属于子项目
  assert.equal(subProjectFromPath("/etc/passwd", WS), null);
  assert.equal(subProjectFromPath(`${WS}子目录/z`, WS), null); // 前缀相同但非子路径
});

test("子项目按频次排序", () => {
  const paths = [`${WS}/海淀/a.md`, `${WS}/海淀/b.md`, `${WS}/公司事务/c.md`, "/tmp/other"];
  assert.deepEqual(countSubProjects(paths, WS), [["海淀", 2], ["公司事务", 1]]);
});

test("输入清洗：去 markdown/URL/换行", () => {
  const out = cleanInput("帮我看下 ```go\nfmt.Println()\n``` 以及 https://x.com/y 的 **配置**");
  assert.ok(!out.includes("```"));
  assert.ok(!out.includes("https"));
  assert.ok(out.includes("配置"));
});

test("目标提炼：去引导词、取首句、限长", () => {
  assert.equal(distillGoal("帮我整理一下周报，顺便看下邮件"), "整理一下周报，顺便看下邮件".slice(0, 20));
  assert.equal(distillGoal("调研一下zcode 有没有什么推荐的插件，值得安装。包括提速"), "zcode 有没有什么推荐的插件");
  assert.equal(distillGoal("继续。"), "");
});

test("惰性消息识别", () => {
  assert.equal(isSubstantive("好的"), false);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("帮我检查一下部署脚本的权限问题"), true);
});

test("标题组装：子项目/类型前缀+目标，超长截断", () => {
  const thread = { goal: "修复登录超时", turns: 5 };
  assert.equal(buildTitle({ subProjects: [["海淀OA", 3]], thread }), "海淀OA｜修复登录超时");
  assert.equal(
    buildTitle({ subProjects: [["海淀OA", 3], ["公司事务", 2], ["其他", 2]], thread }),
    "海淀OA+公司事务｜修复登录超时"
  );
  // 频次不足时无子项目标签，退到操作类型前缀
  assert.equal(buildTitle({ subProjects: [["海淀OA", 1]], thread }), "Bug修复｜修复登录超时");
  // 目标已以类型词开头时不重复加前缀
  assert.equal(buildTitle({ subProjects: [], thread: { goal: "调研zcode插件", turns: 5 } }), "调研zcode插件");
  // 无任何可推断前缀时裸目标
  assert.equal(buildTitle({ subProjects: [], thread: { goal: "把周报模板换掉", turns: 5 } }), "把周报模板换掉");
  const long = buildTitle({ subProjects: [["海淀OA", 3]], thread: { goal: "一".repeat(40), turns: 5 } });
  assert.ok(charLen(long) <= 32 && long.startsWith("海淀OA｜"));
});

test("标题等价判断忽略分隔符与空白", () => {
  assert.equal(normalizeTitle("海淀OA ｜ 修复登录"), normalizeTitle("海淀oa|修复登录"));
});

test("导入 worker 与 hook 模块不产生副作用", async () => {
  const hook = await import("../hook.mjs");
  assert.equal(hook.validatePayload({ stop_hook_active: true }).action, "skipped_stale");
  assert.equal(hook.validatePayload(null).action, "ignored_invalid");
  assert.equal(hook.validatePayload({ session_id: "session_abc", workspace_path: "/x" }).action, "dispatched");
  assert.equal(hook.validatePayload({ session_id: "bad id", workspace_path: "/x" }).action, "ignored_invalid");
});
