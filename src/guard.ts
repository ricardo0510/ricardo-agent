// Kev 决策模型「安全门」——分层防御。
//
// 执行「有副作用」的工具之前,先判断这个操作安不安全,阈值以上拦截、以下放行。
// 和硬编码 if/正则比,它的好处是「懂语义」:不靠关键词匹配,靠理解命令意图。
//
// 分层防御(关键设计):
//   第 1 层「硬规则黑名单」—— 绝对危险的命令(rm -rf、del /s、format、动系统目录),
//     不赌模型、直接拦。因为 0.8B 模型会误判(实测 `del /s /q C:\Windows\System32\*`
//     只给了 0.49 的危险分,差点放行),这类「一看就危险」的必须用规则兜底。
//   第 2 层「Kev 语义判断」—— 规则没命中的「模糊」命令,交给 Kev 看意图。
//     它能在规则之外理解「这条命令到底要干嘛」。
//
// 要点:
//   1. fail-safe —— Kev 挂了/超时,一律按「危险」处理(宁可误拦,不放行危险命令)。
//   2. 阈值可配 —— KEV_GUARD_THRESHOLD(默认 0.5),按出错成本调。
//   3. 只 gate 白名单里的危险工具,普通工具(查天气、算数)零开销直接放行。

const KEV_URL = process.env.KEV_URL || "http://127.0.0.1:8009";
const THRESHOLD = Number(process.env.KEV_GUARD_THRESHOLD || 0.5);

// 需要过安全门的工具:有副作用、可能造成破坏的那些。
// 加新危险工具时,把名字加进来即可。
const GUARDED_TOOLS = new Set(["run_shell"]);

// 第 1 层:硬规则黑名单。这些是「绝对危险」的操作,直接拦,不给模型误判的机会。
// 只匹配明确的破坏性命令,不碰 dir/echo/type 这类安全命令。
const HARD_BLOCK: { pattern: RegExp; why: string }[] = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*)\b/i, why: "rm 递归/强制删除" },
  { pattern: /\brmdir\s+\/(s|q)\b/i, why: "rmdir 递归删除" },
  { pattern: /\bdel\s+\/[sfq]/i, why: "del 递归/强制删除" },
  { pattern: /\bformat\s+[a-z]:/i, why: "格式化磁盘" },
  { pattern: /\bmkfs(\.\w+)?\b/i, why: "mkfs 格式化" },
  { pattern: /\bshutdown\s+\/(s|r|p)/i, why: "关机/重启" },
  { pattern: /\bdd\s+if=.*of=\/dev\//i, why: "dd 写设备" },
  { pattern: /\bSystem32\b/i, why: "碰 Windows 系统目录" },
  { pattern: /--no-preserve-root/i, why: "绕过 rm 根目录保护" },
  { pattern: /(^|[^\w])rm\s+\/\s*$/i, why: "rm 根目录" },
];

export interface GuardResult {
  tool: string;
  guarded: boolean; // 是否真的过了安全门(普通工具 = false,直接放行)
  allowed: boolean; // 最终是否放行
  score?: number; // Kev 的 noul 概率(危险度,0~1;硬规则命中时为 1)
  reason: string;
}

// 提取工具调用里真正的「命令文本」作为 Kev 的 state。
function extractState(args: string): string {
  try {
    const parsed = JSON.parse(args);
    return typeof parsed.command === "string" ? parsed.command : args;
  } catch {
    return args;
  }
}

// 问 Kev:这条命令危不危险。返回 noul 概率(0~1)。
async function askKev(command: string): Promise<number> {
  try {
    const res = await fetch(`${KEV_URL}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "kev-latest",
        state: command,
        questions: {
          dangerous: {
            type: "noul",
            instructions:
              "这条 shell 命令会不会造成破坏性或不可逆的后果(删除/覆盖文件、修改系统配置、泄露敏感信息)?",
            criteria: {
              true: "破坏性、不可逆、危险",
              false: "安全、只读、可逆",
            },
          },
        },
      }),
    });
    if (!res.ok) return 1; // fail-safe
    const data = (await res.json()) as { answers: { dangerous: { noul: number } } };
    return data.answers.dangerous.noul;
  } catch {
    return 1; // fail-safe
  }
}

// 统一入口:agent 每次要执行工具前先调这里。
export async function guardToolCall(name: string, args: string): Promise<GuardResult> {
  if (!GUARDED_TOOLS.has(name)) {
    return { tool: name, guarded: false, allowed: true, reason: "普通工具,无需安全门" };
  }

  const command = extractState(args);

  // 第 1 层:硬规则黑名单(不赌模型)
  const hit = HARD_BLOCK.find((r) => r.pattern.test(command));
  if (hit) {
    return {
      tool: name,
      guarded: true,
      allowed: false,
      score: 1,
      reason: `硬规则命中「${hit.why}」,直接拦截`,
    };
  }

  // 第 2 层:Kev 语义判断
  const score = await askKev(command);
  const allowed = score < THRESHOLD;

  return {
    tool: name,
    guarded: true,
    allowed,
    score,
    reason: allowed
      ? `Kev 判定安全(危险概率 ${score.toFixed(2)} < ${THRESHOLD}),放行`
      : `Kev 判定危险(危险概率 ${score.toFixed(2)} ≥ ${THRESHOLD}),拦截`,
  };
}
