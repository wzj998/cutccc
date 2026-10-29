#!/usr/bin/env node
import { startServer } from "./server.js";
import { runMcp } from "./mcp.js";
import { launch } from "./processes.js";
import { inferenceEnvironment } from "./inference-environment.js";

const args = process.argv.slice(2),
  command = args.shift();
function options(allowed) {
  const result = {};
  while (args.length) {
    const key = args.shift();
    if (!allowed.includes(key) || !args.length)
      throw new Error(`Unknown or incomplete option: ${key}`);
    result[key] = args.shift();
  }
  return result;
}
try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node.js 22 or newer is required");
  if (command === "--version") {
    console.log("cutccc 0.3.0 (Node.js service / Python inference)");
  } else if (
    !command ||
    ["--help", "-h"].includes(command) ||
    args.includes("--help") ||
    args.includes("-h")
  ) {
    console.log(
      "cutccc serve [--port 18765] [--data-dir PATH] [--models-dir PATH] [--inference-python PYTHON]\ncutccc mcp [--api-url http://127.0.0.1:18765]\ncutccc transcribe|download ... [--inference-python PYTHON]",
    );
  } else if (command === "serve") {
    const o = options([
      "--port",
      "--data-dir",
      "--models-dir",
      "--inference-python",
    ]);
    const port = Number(o["--port"] ?? 18765);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Port must be between 1 and 65535");
    const app = await startServer({
      port,
      dataDir: o["--data-dir"],
      modelsDir: o["--models-dir"],
      inferencePython: o["--inference-python"],
    });
    console.error(
      `cutccc Node.js service: ${app.url}\nData: ${app.studio.root}\nPython inference: ${app.studio.python}`,
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else if (command === "mcp") {
    const o = options(["--api-url"]);
    await runMcp(o["--api-url"]);
  } else if (["transcribe", "download"].includes(command)) {
    let python = process.env.CUTCCC_INFERENCE_PYTHON || "python";
    const i = args.indexOf("--inference-python");
    if (i >= 0) {
      if (!args[i + 1]) throw new Error("--inference-python requires a path");
      python = args[i + 1];
      args.splice(i, 2);
    }
    const child = launch(python, ["-u", "-m", "cutccc", command, ...args], {
      stdio: "inherit",
      env: inferenceEnvironment(),
    });
    child.once("error", (e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
    child.once("close", (code) => {
      process.exitCode = code ?? 1;
    });
  } else throw new Error(`Unknown command: ${command}`);
} catch (e) {
  console.error(`cutccc: ${e.message}`);
  process.exitCode = 1;
}
