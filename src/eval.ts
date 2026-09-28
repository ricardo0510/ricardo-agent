// eval:给 agent 建一组「带断言」的评测题,量化它的表现。
//
// 三个断言维度,越往后越「深」:
//   expectTools       应该调用哪些工具(测「工具选择」)
//   expectToolResults 工具返回的结果应包含什么(直接测「工具本身」)
//   expectContains    最终答案应包含什么(测「模型综合能力」)
//
// 为什么必须测「工具结果」而不只测「最终答案」:
// 强模型会「自我纠正」明显错误的工具结果(自己心算、交叉验证),
// 让最终答案看起来对,从而掩盖工具的真实 bug。只有直接断言工具结果,
// 才能抓到「工具坏了但模型兜住了」这种情况。

import { createConversation, runAgent } from "./agent.js";
import { loadEnv } from "./env.js";

loadEnv();

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ 缺少 OPENAI_API_KEY。请先 cp .env.example .env 并填入 key。");
  process.exit(1);
}

interface EvalCase {
  name: string;
  question: string;
  expectTools?: string[]; // 应调用的工具;[] = 不应调任何工具;缺省 = 不检查
  expectToolResults?: { tool: string; contains: string }[]; // 工具结果应包含(至少一个)
  expectContains?: string[]; // 最终答案应包含(至少一个)
}

const CASES: EvalCase[] = [
  {
    name: "算数-基础",
    question: "帮我算 (48+52)*3",
    expectTools: ["calculate"],
    expectToolResults: [{ tool: "calculate", contains: "300" }],
    expectContains: ["300"],
  },
  {
    name: "算数-除法",
    question: "100 除以 4 等于多少",
    expectTools: ["calculate"],
    expectToolResults: [{ tool: "calculate", contains: "25" }],
    expectContains: ["25"],
  },
  { name: "天气", question: "悉尼现在几度", expectTools: ["get_weather"] },
  { name: "时间", question: "现在悉尼是几点", expectTools: ["get_current_time"] },
  { name: "读文件", question: "读一下 README.md 开头写了什么", expectTools: ["read_file"], expectContains: ["agent"] },
  { name: "搜索", question: "搜一下 DeepSeek 是什么", expectTools: ["search_web"], expectContains: ["DeepSeek"] },
  { name: "两城市天气", question: "悉尼和襄阳现在各几度", expectTools: ["get_weather"] },
  { name: "纯对话", question: "你好,简单介绍一下你自己", expectTools: [] },
];

interface CaseResult {
  name: string;
  pass: boolean;
  toolPass: boolean | null; // null = 未检查
  toolResultPass: boolean | null;
  contentPass: boolean | null;
  toolsCalled: string[];
  answer: string;
  error?: string;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const conv = createConversation();
  let answer = "";
  const toolsCalled: string[] = [];
  const toolResults: { tool: string; result: string }[] = [];
  let currentTool = "";

  try {
    await runAgent(conv, c.question, {
      onToken: (chunk) => {
        answer += chunk;
      },
      onToolCall: (name) => {
        currentTool = name;
        toolsCalled.push(name);
      },
      onToolResult: (result) => {
        toolResults.push({ tool: currentTool, result }); // 工具串行执行,onToolCall 先于 onToolResult,所以能配对
      },
      onDone: () => {},
    });
  } catch (e) {
    return { name: c.name, pass: false, toolPass: null, toolResultPass: null, contentPass: null, toolsCalled, answer, error: (e as Error).message };
  }

  // 工具选择断言
  let toolPass: boolean | null = null;
  if (c.expectTools) {
    toolPass =
      c.expectTools.length === 0
        ? toolsCalled.length === 0
        : c.expectTools.every((t) => toolsCalled.includes(t));
  }

  // 工具结果断言:直接测工具本身,不受模型自我纠错影响
  let toolResultPass: boolean | null = null;
  if (c.expectToolResults) {
    toolResultPass = c.expectToolResults.every(({ tool, contains }) =>
      toolResults.some((tr) => tr.tool === tool && tr.result.includes(contains))
    );
  }

  // 最终答案断言
  let contentPass: boolean | null = null;
  if (c.expectContains) {
    contentPass = c.expectContains.some((k) => answer.includes(k));
  }

  const pass = (toolPass === null || toolPass) && (toolResultPass === null || toolResultPass) && (contentPass === null || contentPass);
  return { name: c.name, pass, toolPass, toolResultPass, contentPass, toolsCalled, answer };
}

async function main() {
  console.log(`跑 ${CASES.length} 道评测题(串行,避免限流)...\n`);
  const results: CaseResult[] = [];
  for (const c of CASES) {
    const r = await runCase(c);
    results.push(r);
    console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}${r.error ? `  (报错:${r.error})` : ""}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const rate = Math.round((passed / results.length) * 100);
  console.log(`\n========== Eval 报告 ==========`);
  console.log(`通过 ${passed}/${results.length} (${rate}%)\n`);

  for (const r of results) {
    const checks: string[] = [];
    if (r.toolPass !== null) checks.push(`工具选择${r.toolPass ? "✓" : "✗"}`);
    if (r.toolResultPass !== null) checks.push(`工具结果${r.toolResultPass ? "✓" : "✗"}`);
    if (r.contentPass !== null) checks.push(`最终答案${r.contentPass ? "✓" : "✗"}`);
    console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}  [${checks.join(" ")}]`);
    if (!r.pass) {
      console.log(`     实际工具:${r.toolsCalled.length ? r.toolsCalled.join(", ") : "(无)"}`);
      console.log(`     答案:${r.answer.slice(0, 80) || "(空)"}`);
    }
  }
}

main();
