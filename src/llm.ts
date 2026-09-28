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
}

// 每次调用时读 env(而不是模块加载时):因为调用方可能先 chdir + loadEnv,
// env 的加载晚于 import,模块级常量会拿到默认值。
function apiConfig() {
  return {
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    model: process.env.MODEL ?? "deepseek-chat",
  };
}

// ---------- 非流式:一次拿到完整回复 ----------

export async function chat(messages: Message[], tools?: ToolDef[]): Promise<Message> {
  const { baseUrl, model } = apiConfig();
  const res = await fetch(`${baseUrl}/chat/completions`, {
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

  const data = (await res.json()) as { choices: { message: Message }[] };
  return data.choices[0].message;
}

// ---------- 流式:内容逐字吐,工具调用分片拼接 ----------

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
}

export async function chatStream(
  messages: Message[],
  tools: ToolDef[] | undefined,
  onContent: (chunk: string) => void
): Promise<StreamResult> {
  const { baseUrl, model } = apiConfig();
  const res = await fetch(`${baseUrl}/chat/completions`, {
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
      stream: true, // 关键:开流式
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API 错误 ${res.status}: ${text.slice(0, 500)}`);
  }

  // SSE 格式:每行一个 `data: {...}`,空行分隔,结束标记是 `data: [DONE]`
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
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

  return { content, toolCalls: toolCalls.filter(Boolean) };
}
