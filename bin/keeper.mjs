// Runs a long-lived Warren process (the hub, or `warren node start`) as a child, and starts it
// again when it exits with RESTART_CODE, which it does after an update. Terminals and service
// managers (systemd, launchd, Task Scheduler) only ever see this process, so an update takes
// effect the same way everywhere.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Scheduled tasks can inherit an older PATH; keep the selected runtime's npm available.
const runtimeBin = path.dirname(process.execPath);
process.env.PATH = [runtimeBin, ...(process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== runtimeBin)].join(path.delimiter);

/** Keep in sync with RESTART_CODE in packages/update. */
const RESTART_CODE = 75;

export function keep(entry, args = process.argv.slice(2)) {
  const loader = import.meta.resolve("tsx");
  let child = null;
  const start = () => {
    // the IPC channel lets the child notice if this process dies, so it never runs on its own
    child = spawn(process.execPath, ["--import", loader, fileURLToPath(entry), ...args], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, WARREN_KEEPER: "1" },
    });
    child.on("exit", (code, signal) => {
      if (code === RESTART_CODE) {
        console.log("[warren] restarting with the update");
        start();
      } else {
        process.exit(code ?? (signal ? 1 : 0));
      }
    });
  };
  // the child gets Ctrl+C from the terminal itself; pass on what a service manager sends
  for (const sig of ["SIGTERM", "SIGHUP"]) process.on(sig, () => child?.kill(sig));
  process.on("SIGINT", () => {});
  start();
}
