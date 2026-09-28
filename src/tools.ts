// 工具定义 + 执行器。
// 每个工具 = 两样东西:
//   1. 一段 JSON Schema 描述(TOOLS,给模型看,模型据此决定「要不要调、参数怎么填」)
//   2. 一个真正的 JS 函数(模型说调,我们就跑它,结果再喂回模型)
// 想加新工具:写个函数 + 在 TOOLS 和 runTool 里各登记一次。
//
// 注意:工具实现(下面这些函数)是「纯逻辑」,和框架无关。
// framework/ 里的 AI SDK 版直接 import 这些函数复用,只换「定义方式」。

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ToolCall, ToolDef } from "./llm.js";

const execAsync = promisify(exec);

// ---------- 工具实现(真实逻辑) ----------

export async function getWeather(city: string): Promise<string> {
  // 用 Open-Meteo(免费、无需 key)。第一步:地理编码,城市名 → 经纬度。
  const geo = (await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`
  ).then((r) => r.json())) as { results?: { latitude: number; longitude: number; name: string; country: string }[] };

  const hit = geo.results?.[0];
  if (!hit) return `没找到「${city}」,换个城市名试试。`;

  const { latitude, longitude, name, country } = hit;
  const w = (await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`
  ).then((r) => r.json())) as { current: { temperature_2m: number; weather_code: number; wind_speed_10m: number } };

  const c = w.current;
  return `${name}(${country}) 当前 ${c.temperature_2m}°C,${describeWeatherCode(c.weather_code)},风速 ${c.wind_speed_10m} km/h`;
}

function describeWeatherCode(code: number): string {
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "有雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67].includes(code)) return "下雨";
  if ([71, 73, 75, 77].includes(code)) return "下雪";
  if ([80, 81, 82].includes(code)) return "阵雨";
  if ([95, 96, 99].includes(code)) return "雷暴";
  return "天气不明";
}

export function calculate(expr: string): number {
  // 不用 eval,自己写递归下降求值,只允许四则运算和小括号。
  if (!/^[\d+\-*/().\s]+$/.test(expr)) {
    throw new Error("只支持数字、+ - * / 和小括号");
  }
  const s = expr.replace(/\s+/g, "");
  let i = 0;

  function parseExpr(): number {
    let v = parseTerm();
    while (i < s.length && (s[i] === "+" || s[i] === "-")) {
      const op = s[i++];
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (i < s.length && (s[i] === "*" || s[i] === "/")) {
      const op = s[i++];
      const r = parseFactor();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function parseFactor(): number {
    if (s[i] === "(") {
      i++;
      const v = parseExpr();
      if (s[i] !== ")") throw new Error("括号不匹配");
      i++;
      return v;
    }
    const start = i;
    if (s[i] === "-") i++; // 负号
    while (i < s.length && /[\d.]/.test(s[i])) i++;
    const num = parseFloat(s.slice(start, i));
    if (Number.isNaN(num)) throw new Error("无效数字");
    return num;
  }

  const result = parseExpr();
  if (i < s.length) throw new Error(`无法解析「${s.slice(i)}」`);
  return result;
}

export function getCurrentTime(timezone?: string): string {
  const tz = timezone || "Asia/Shanghai";
  try {
    return new Date().toLocaleString("zh-CN", { timeZone: tz });
  } catch {
    return `无效时区「${tz}」`;
  }
}

// 项目根 = src/ 的上一级,用 import.meta.url 定位(不依赖进程 cwd,任何目录启动都对)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function readTextFile(relativePath: string): Promise<string> {
  // 安全:只允许读项目目录内的文件,拒绝越界路径
  const abs = path.resolve(PROJECT_ROOT, relativePath);
  if (!abs.startsWith(PROJECT_ROOT)) {
    return "拒绝:只能读当前项目目录内的文件。";
  }
  try {
    return await readFile(abs, "utf-8");
  } catch (e) {
    return `读文件失败:${(e as Error).message}`;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\displaystyle[^}]*\}/g, "") // 维基数学公式残留,如 {\displaystyle x}
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "");
}

export async function searchWeb(query: string, limit = 3): Promise<string> {
  // 用维基百科 API 做零 key 的联网搜索(标题 + 摘要)。
  // 生产环境建议换 Tavily(https://tavily.com)或 Brave Search——全网搜索、质量高、带 key,
  // 但返回结构类似,只改这一个函数 + schema 里的 description 即可。
  const url =
    `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}` +
    `&format=json&srlimit=${limit}&srprop=snippet`;
  const data = (await fetch(url).then((r) => r.json())) as {
    query?: { search?: { title: string; snippet: string }[] };
  };
  const results = data.query?.search ?? [];
  if (results.length === 0) return `「${query}」没搜到结果,换个说法试试。`;
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${stripHtml(r.snippet)}`).join("\n");
}

export async function runShell(command: string): Promise<string> {
  // ⚠️ 危险工具:执行任意 shell 命令。
  // 它必须经过 guard 安全门(见 agent.ts)——破坏性命令会在执行前被 Kev 拦截。
  // 不要绕过 guard 直接调用这个函数。
  const MAX_OUTPUT = 4000;
  try {
    // Windows 上 cmd 默认代码页是 GBK,中文文件名输出是 GBK 字节;
    // node 默认按 UTF-8 解会乱码。这里拿原始字节,按 GBK 解(英文 ASCII 在 GBK 下不受影响)。
    const { stdout, stderr } = await execAsync(command, {
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
    const dec = new TextDecoder(process.platform === "win32" ? "gbk" : "utf-8");
    const out = (dec.decode(stdout) + (stderr.length ? `\n[stderr]\n${dec.decode(stderr)}` : "")).trim();
    return out.slice(0, MAX_OUTPUT) || "(命令执行成功,无输出)";
  } catch (e) {
    return `命令执行出错:${(e as Error).message}`;
  }
}

// ---------- 工具注册表 ----------

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询某个城市当前的天气(温度、天气状况、风速)。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "城市名,如「悉尼」「襄阳」「墨尔本」" },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "计算一个数学表达式,支持四则运算和小括号。",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式,如 (3+4)*5" },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前日期时间,可选时区。",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA 时区,如 Asia/Shanghai、Australia/Sydney,默认 Asia/Shanghai" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取当前项目目录内的文本文件内容。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对项目根目录的文件路径,如 README.md" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "联网搜索一个主题,返回相关条目标题和摘要(基于维基百科)。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词,如「DeepSeek」「澳洲留学」" },
          limit: { type: "number", description: "返回条数,默认 3" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "执行一条 shell 命令(Windows 用 cmd)。⚠️ 破坏性命令会被安全门拦截。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令,如 dir、echo hello" },
        },
        required: ["command"],
      },
    },
  },
];

export async function runTool(call: ToolCall): Promise<string> {
  // 关键习惯:工具内部出错(参数格式错、输入非法、网络失败)不要抛出,
  // 而是把错误消息作为结果返回,喂回模型——模型看到报错会自己调整参数重试。
  try {
    const args = JSON.parse(call.function.arguments || "{}");
    switch (call.function.name) {
      case "get_weather":
        return getWeather(String(args.city));
      case "calculate":
        return String(calculate(String(args.expression)));
      case "get_current_time":
        return getCurrentTime(args.timezone ? String(args.timezone) : undefined);
      case "read_file":
        return readTextFile(String(args.path));
      case "search_web":
        return searchWeb(String(args.query), args.limit ? Number(args.limit) : 3);
      case "run_shell":
        // ⚠️ 这里只负责「执行」;「该不该执行」由 agent.ts 里的安全门先判。
        // 所以 runShell 被调用时,命令已经过了 Kev 检查。
        return runShell(String(args.command));
      default:
        return `未知工具:${call.function.name}`;
    }
  } catch (e) {
    return `工具执行出错:${(e as Error).message}`;
  }
}
