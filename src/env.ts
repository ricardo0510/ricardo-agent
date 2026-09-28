// 极简 .env 加载(不依赖 dotenv):把项目根目录的 .env 读进 process.env。
// 已经存在的系统环境变量优先级更高,不会被覆盖。
import { readFileSync } from "node:fs";
import path from "node:path";

export function loadEnv() {
  const file = path.resolve(process.cwd(), ".env");
  try {
    const text = readFileSync(file, "utf-8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env 不存在也没关系,可以直接用系统环境变量
  }
}
