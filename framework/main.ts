// ============================================================
// AI SDK 7 版:用框架重写同样的 agent。
// 对照 src/ 里的手写版(零依赖),体会框架帮你省了什么:
//
//   手写版                          AI SDK 版
//   ─────────────────────────────   ─────────────────────────────
//   chatStream ≈ 150 行             streamText 一行
//   (SSE 解析 + 工具调用分片拼接)     fullStream 直接给 text-delta /
//                                   tool-call / tool-result 事件
//
//   TOOLS(JSON Schema)              tool({ inputSchema: z.object(...),
//   + runTool(switch)                   execute })
//                                   声明式 + 自动参数校验
//
//   for 循环 + 手动 push messages    stopWhen: isStepCount(8)
//                                   自动多步循环 + 结果回填
//
// 但工具逻辑本身(getWeather、calculate...)和框架无关,直接复用 src/tools.js。
// 这就是框架的本质:它省的是「协议/编排的脏活」,不是你的业务逻辑。
// ============================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { streamText, tool, isStepCount } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { z } from "zod";

// 切到项目根(和手写版一致的 cwd,.env 在这里)
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

import { loadEnv } from "../src/env.js";
import { getWeather, calculate, getCurrentTime, readTextFile, searchWeb } from "../src/tools.js";

loadEnv();

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ 缺少 OPENAI_API_KEY。请先 cp .env.example .env 并填入 key。");
  process.exit(1);
}

const deepSeek = createDeepSeek({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT =
  "你是一个能使用工具的智能助手。当用户的问题需要查天气、算数、读文件、看时间或联网搜索时,调用对应的工具;拿到工具结果后,组织成自然语言回答。不需要工具就直接回答。回答用简体中文。";

const userInput = process.argv.slice(2).join(" ").trim() || "悉尼和襄阳现在各几度";

const result = streamText({
  model: deepSeek(process.env.MODEL ?? "deepseek-chat"),
  system: SYSTEM_PROMPT,
  prompt: userInput,
  tools: {
    get_weather: tool({
      description: "查询某个城市当前的天气(温度、天气状况、风速)。",
      inputSchema: z.object({ city: z.string().describe("城市名,如「悉尼」「襄阳」") }),
      execute: async ({ city }) => getWeather(city),
    }),
    calculate: tool({
      description: "计算一个数学表达式,支持四则运算和小括号。",
      inputSchema: z.object({ expression: z.string().describe("数学表达式,如 (3+4)*5") }),
      execute: async ({ expression }) => String(calculate(expression)),
    }),
    get_current_time: tool({
      description: "获取当前日期时间,可选时区。",
      inputSchema: z.object({ timezone: z.string().optional().describe("IANA 时区,默认 Asia/Shanghai") }),
      execute: async ({ timezone }) => getCurrentTime(timezone),
    }),
    read_file: tool({
      description: "读取当前项目目录内的文本文件内容。",
      inputSchema: z.object({ path: z.string().describe("相对项目根目录的文件路径,如 README.md") }),
      execute: async ({ path: p }) => readTextFile(p),
    }),
    search_web: tool({
      description: "联网搜索一个主题,返回相关条目标题和摘要(基于维基百科)。",
      inputSchema: z.object({
        query: z.string().describe("搜索关键词,如「DeepSeek」"),
        limit: z.number().optional().describe("返回条数,默认 3"),
      }),
      execute: async ({ query, limit }) => searchWeb(query, limit ?? 3),
    }),
  },
  stopWhen: isStepCount(8),
});

// 消费 fullStream:工具调用过程打印出来,最终答案流式吐出
for await (const chunk of result.fullStream) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.text);
  } else if (chunk.type === "tool-call") {
    console.log(`\n  🔧 调用 ${chunk.toolName}(${JSON.stringify(chunk.input)})`);
  } else if (chunk.type === "tool-result") {
    const out = typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output);
    console.log(`  📄 结果:${out}`);
  }
}
console.log();
