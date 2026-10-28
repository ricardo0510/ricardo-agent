// 调用 OpenAI 兼容的 Chat Completions API(非流式 + 流式两种)。
// OpenAI / DeepSeek / 各种国产模型只要是 OpenAI 兼容接口,都能通过换 BASE_URL 直接接上。

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema,给模型看,告诉它怎么填参数
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments 是 JSON 字符串
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  usage?: Usage; // 非流式 chat 附加的 token 用量(可观测性统计用)
}

// OpenAI 兼容接口返回的 token 用量
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// 每次调用时读 env(而不是模块加载时):因为调用方可能先 chdir + loadEnv,
// env 的加载晚于 import,模块级常量会拿到默认值。
function apiConfig() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    model: process.env.MODEL ?? "deepseek-chat",
  };
}

// ---------- 带超时 + 重试的 fetch(生产级必做)----------
// 两个坑,裸 fetch 都不管:
//   1. 请求挂死 —— 用 AbortController 加超时,到点主动中断
//   2. 瞬时故障 —— 网络抖动 / 429 限流 / 5xx 服务错误,指数退避重试;
//      4xx 客户端错误(参数错、鉴权错)不重试,因为重试也不会变对
const FETCH_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 180_000; // 整个流式响应（含 body 读取）的上限
const MAX_RETRIES = 2; // 共 3 次尝试

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 合并调用方信号与本次尝试的超时信号；任一触发都中止请求。
function combineSignals(a?: AbortSignal | null, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.aborted || b.aborted) return AbortSignal.abort();
  const merged = new AbortController();
  const onAbort = () => merged.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return merged.signal;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: combineSignals(init.signal, controller.signal) });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) return res;
      lastError = new Error(`HTTP ${res.status}(可重试)`);
    } catch (e) {
      lastError = e;
      // 调用方主动取消（或整条流超时）时不再重试
      if (init.signal?.aborted || controller.signal.aborted) throw e;
      if (attempt === MAX_RETRIES) throw e;
    } finally {
      clearTimeout(timer);
    }
    await sleep(500 * 2 ** attempt); // 指数退避:500ms → 1s
  }
  throw lastError;
}

// ---------- 非流式:一次拿到完整回复 ----------

export async function chat(messages: Message[], tools?: ToolDef[]): Promise<Message> {
  const { baseUrl, model } = apiConfig();
  const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API 错误 ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as { choices: { message: Message }[]; usage?: Usage };
  const message = data.choices[0].message;
  if (data.usage) message.usage = data.usage;
  return message;
}

// ---------- 流式:内容逐字吐,工具调用分片拼接 ----------

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage; // 流式最后一块带 usage(需 stream_options.include_usage)
}

export async function chatStream(
  messages: Message[],
  tools: ToolDef[] | undefined,
  onContent: (chunk: string) => void
): Promise<StreamResult> {
  const { baseUrl, model } = apiConfig();
  // 超时必须覆盖「建立连接 + 读完整个流」，否则 body 卡住会永久挂起。
  const streamController = new AbortController();
  const streamTimer = setTimeout(() => streamController.abort(), STREAM_TIMEOUT_MS);

  try {
    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      signal: streamController.signal,
      body: JSON.stringify({
        model,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        temperature: 0.2,
        stream: true, // 关键:开流式
        stream_options: { include_usage: true }, // 让最后一块带上 token 用量
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API 错误 ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error("API 响应没有 body");

    // SSE 格式:每行一个 `data: {...}`,空行分隔,结束标记是 `data: [DONE]`
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage: Usage | undefined;
    const toolCalls: ToolCall[] = []; // 按 index 累积(模型可能同时调多个工具)

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 最后一行可能被截断,留下次拼
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;

        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        // 最后一个 chunk:choices 为空,只带 usage(因为开了 include_usage)
        if (json.usage) {
          usage = json.usage;
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          onContent(delta.content); // 逐字回调,驱动打字机效果
        }

        // 工具调用是「分片」来的:name/arguments 拆成一段段,按 index 拼起来
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.type) toolCalls[idx].type = tc.type;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    return { content, toolCalls: toolCalls.filter(Boolean), usage };
  } finally {
    clearTimeout(streamTimer);
  }
}
