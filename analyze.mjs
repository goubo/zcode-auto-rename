// 会话分析：聚合项目（一个 workspace 多个子目录/子项目）场景。
// 产出：子项目标签（按工具操作路径频次）+ 主线目标（首条实质输入 + 近期演化）。

const NOISE_DIRS = new Set(["node_modules", ".git", ".zcode", "dist", "build", "vendor", "tmp", "temp"]);

// workspace 下一级目录即子项目；排除噪声目录、根下散文件与 workspace 根本身
export function subProjectFromPath(path, workspacePath) {
  if (!workspacePath) return null;
  const ws = workspacePath.replace(/\/+$/, "");
  if (!path.startsWith(ws + "/")) return null;
  const rest = path.slice(ws.length + 1);
  if (!rest.includes("/")) return null; // 根下直接文件，无子项目归属
  const first = rest.split("/")[0];
  if (!first || first.startsWith(".") || NOISE_DIRS.has(first)) return null;
  return first;
}

export function countSubProjects(paths, workspacePath) {
  const counts = new Map();
  for (const p of paths) {
    const name = subProjectFromPath(p, workspacePath);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// 清洗用户输入：去 markdown 标记、URL、本地路径、代码块围栏、多行折叠
// 标题是给人扫视的，路径与凭据形状的内容一律剥离
export function cleanInput(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(?:\/(?:Users|home|opt|etc|var|tmp)\/|~\/)[^\s，。；,;）)】"']*/g, "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "")
    .replace(/[#*_>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LEAD_WORDS = [
  "帮我","帮忙","麻烦","请你","请","麻烦你","能不能","可以不可以","是否可以","我想","我要","我需要","我想要",
  "需要","今天","现在","继续","接下来","然后","继续使用","使用一下","看一下","看一下这个","查一下","查查","看看",
  "帮我看看","调研一下","调查一下","了解一下","整理一下","梳理一下","处理一下","搞一下","弄一下","做一下","试一下","分析一下",
];
const TAIL_WORDS = ["谢谢", "多谢", "辛苦了", "麻烦了", "尽快", "urgent", "急"];

// 从一条用户输入提炼目标短语：去引导词、取首句、限长。
// 提炼结果过短（如"清理掉吧"这类上下文延续句）视为无效，返回空串。
export function distillGoal(text, maxLen = 20) {
  let t = cleanInput(text);
  if (!t) return "";
  for (const w of [...LEAD_WORDS].sort((a, b) => b.length - a.length)) {
    if (t.startsWith(w)) { t = t.slice(w.length); break; }
  }
  for (const w of TAIL_WORDS) t = t.split(w)[0];
  t = t.trim().replace(/^[，。,.\s]+/, "");
  // 首句（中英文标点）
  const sentence = t.split(/[。！？!?\n；;]/)[0] || t;
  if (sentence.length < 6) return "";
  if (sentence.length <= maxLen) return sentence;
  // 截断避免硬切词：优先退到标点或空格，退无可退才硬切
  const cut = sentence.slice(0, maxLen);
  const lastBreak = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf(","), cut.lastIndexOf(" "), cut.lastIndexOf("、"));
  return lastBreak >= maxLen * 0.5 ? cut.slice(0, lastBreak) : cut;
}

// 惰性消息：过短或纯确认，不参与主线判断
export function isSubstantive(text) {
  const t = cleanInput(text);
  if (t.length < 6) return false;
  return !/^(好|好的|嗯|ok|继续|可以|行|对|是的|收到|明白|go|next)[。!！\s]*$/i.test(t);
}

// 中日韩+ASCII 的统一字符长度
export const charLen = (s) => [...s].length;

// 两条文本的字符重合率（粗粒度主线漂移判断）
function overlapRatio(a, b) {
  const ga = new Set([...a]), gb = new Set([...b]);
  let hit = 0;
  for (const c of ga) if (gb.has(c)) hit++;
  return ga.size ? hit / ga.size : 0;
}

// 主线：首条可提炼的实质输入定目标；会话变长且近期明显换主题时，目标跟随近期（体现演进）。
// 首条输入常是上下文延续句（"清理掉吧"），逐条回退直到拿到有效目标。
export function mainThread(userInputs) {
  const substantive = userInputs.filter((u) => isSubstantive(u.text));
  if (!substantive.length) return null;
  const recent = substantive[substantive.length - 1];
  let firstGoal = "";
  let firstIdx = 0;
  for (; firstIdx < substantive.length; firstIdx++) {
    firstGoal = distillGoal(substantive[firstIdx].text);
    if (firstGoal) break;
  }
  let goal = firstGoal;
  let evolved = false;
  if (substantive.length >= 4) {
    const recentGoal = distillGoal(recent.text);
    if (recentGoal && firstGoal && overlapRatio(recentGoal, firstGoal) < 0.35) {
      goal = recentGoal;
      evolved = true;
    }
  }
  if (!goal) return null;
  return { goal, firstGoal, evolved, turns: substantive.length };
}

// 操作类型推断：无子项目证据时的前缀。按优先级取首个命中。
const TYPE_RULES = [
  ["Bug修复", /bug|报错|异常|崩溃|失败|不工作|不能用|修复|fix/i],
  ["环境配置", /安装|卸载|配置|环境|升级|更新版本|setup|install/i],
  ["文档整理", /文档|整理|归档|笔记|readme|目录文件/i],
  ["调研", /调研|调查|了解|对比|评估|选型|分析一下/i],
  ["测试验证", /测试|验证|验收|检查一下|检查并/i],
  ["数据处理", /数据|导出|导入|迁移|清洗|统计/i],
  ["代码开发", /开发|实现|编写|重构|新功能|写一个|建一个|创建一个/i],
];

export function inferType(text) {
  for (const [name, re] of TYPE_RULES) if (re.test(text)) return name;
  return null;
}

// 生成标题：[前缀]｜目标。前缀优先子项目（操作频次 >= minOps），否则推断操作类型。
export function buildTitle({ subProjects, thread, minOps = 2, maxLen = 32 }) {
  if (!thread?.goal) return null;
  const goal = thread.goal;
  const parts = [];
  const qualified = subProjects.filter(([, n]) => n >= minOps).slice(0, 2);
  if (qualified.length) parts.push(qualified.map(([name]) => name).join("+"));
  else {
    const type = inferType(thread.goal) ?? inferType(thread.firstGoal ?? "");
    if (type && !goal.startsWith(type)) parts.push(type);
  }
  parts.push(goal);
  let title = parts.join("｜");
  // 超长时优先压缩目标段，不动前缀
  if (charLen(title) > maxLen) {
    const budget = maxLen - (parts.length > 1 ? charLen(parts[0]) + 1 : 0);
    title = (parts.length > 1 ? parts[0] + "｜" : "") + goal.slice(0, Math.max(6, budget));
  }
  return title;
}

// 规范化比较：忽略空白与分隔符差异，判断标题是否已等价
export function normalizeTitle(t) {
  return (t ?? "").replace(/[\s｜|·・:：]/g, "").toLowerCase();
}
