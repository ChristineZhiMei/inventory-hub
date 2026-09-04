import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { initializeAdmin } from "./admin.js";

const terminal = createInterface({ input: stdin, output: stdout });
try {
  const username = process.env.IH_ADMIN_USERNAME ?? await terminal.question("管理员用户名：");
  terminal.close();
  const password = process.env.IH_ADMIN_PASSWORD ?? await hiddenQuestion("管理员密码（12-128字符，不回显）：");
  const user = initializeAdmin(username, password, { appMode: "server" });
  console.log(`管理员 ${user.username} 已创建。`);
} finally {
  terminal.close();
}

async function hiddenQuestion(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const fallback = createInterface({ input: stdin, output: stdout });
    try { return await fallback.question(prompt); }
    finally { fallback.close(); }
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") {
        cleanup();
        reject(new Error("管理员初始化已取消"));
        return;
      }
      if (text === "\r" || text === "\n") {
        cleanup();
        resolve(value);
        return;
      }
      if (text === "\u007f" || text === "\b") value = Array.from(value).slice(0, -1).join("");
      else value += text;
    };
    stdin.on("data", onData);
  });
}
