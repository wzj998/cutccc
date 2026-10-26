import { spawn } from "node:child_process";

export function launch(command, args, options = {}) {
  return spawn(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}
export async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = launch("taskkill", [
        "/PID",
        String(child.pid),
        "/T",
        "/F",
      ]);
      killer.on("error", resolve);
      killer.on("close", resolve);
    });
  } else child.kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
export function capture(
  command,
  args,
  { timeout = 60000, maxBytes = 16 * 1024 * 1024, ...options } = {},
) {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, options);
    const stdout = [],
      stderr = [];
    let size = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopProcess(child);
    }, timeout);
    child.stdout.on("data", (b) => {
      size += b.length;
      if (size <= maxBytes) stdout.push(b);
      else void stopProcess(child);
    });
    child.stderr.on("data", (b) => {
      if (stderr.reduce((n, v) => n + v.length, 0) < 1024 * 1024)
        stderr.push(b);
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8"),
        err = Buffer.concat(stderr).toString("utf8");
      if (timedOut) reject(new Error(`${command} timed out`));
      else if (code !== 0 || size > maxBytes)
        reject(new Error(`${command} failed: ${err.slice(-4000)}`));
      else resolve({ stdout: out, stderr: err });
    });
  });
}
