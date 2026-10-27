// Accidental direct invocation must refuse before declaration imports evaluate.
// These kernel-backed checks supplement the trusted launcher; they do not
// authenticate a malicious runtime or replace bubblewrap's namespace boundary.
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
try {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n").map((line) => line.split(" "));
  const readOnly = (path) => mounts.some((fields) => fields[4] === path && fields[5].split(",").includes("ro"));
  if (process.platform !== "linux" || process.execPath !== "/runtime/node" || process.cwd() !== "/workspace/worker" ||
      process.env.HOME !== "/tmp/home" || process.env.PATH !== "/runtime:/usr/bin" ||
      Object.keys(process.env).some((key) => !["HOME", "PATH", "PWD"].includes(key)) ||
      Object.keys(networkInterfaces()).some((name) => name !== "lo") ||
      ["/home", "/run", "/var", "/etc", "/workspace/.git"].some((path) => existsSync(path)) ||
      !["/workspace", "/workspace/node_modules", "/workspace/worker/node_modules"].every(readOnly)) throw new Error();
} catch { throw new Error("Protected planning evidence unavailable; apply blocked"); }
