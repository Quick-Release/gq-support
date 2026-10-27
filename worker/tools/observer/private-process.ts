// Offline child-process fixture only, never a launcher CLI. HTTP is wholly fake.
import * as fs from "node:fs";
import { observePrivateFiles, type CustodyFS } from "./private-launcher.ts";
import { observerReadCommand, type ReadSessionPins } from "./review-loader.ts";
const [deliveryDirectory, journalDirectory, rawPins, phase] = process.argv.slice(2);
const pins = JSON.parse(rawPins) as ReadSessionPins;
let syncs = 0, dispatched = false;
const io: CustodyFS = { ...fs, fsyncSync(fd) {
  syncs++;
  if (phase === "before-fsync" && syncs === 1) process.exit(77);
  fs.fsyncSync(fd);
  if (phase === "after-claim" && syncs === 2) process.exit(77);
  if (phase === "before-dispatch" && syncs === 3) process.exit(77);
} };
const user = { login: "vvaz", id: 11, type: "User" };
const github: typeof fetch = async u => {
  dispatched = true;
  const url = String(u), root = "https://api.github.com/repos/Quick-Release/gq-support";
  const created = new Date(pins.readyAt + 1000).toISOString();
  const body = url.includes("/comments/") ? { id: 789, url, issue_url: `${root}/issues/20`,
    html_url: "https://github.com/Quick-Release/gq-support/issues/20#issuecomment-789", user,
    body: observerReadCommand(pins.sha256), created_at: created, updated_at: created } :
    url.endsWith("/permission") ? { user, permission: "write" } : user;
  return Object.defineProperty(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }), "url", { value: url });
};
await observePrivateFiles({ deliveryDirectory, journalDirectory, pins, policy: { approvers: { vvaz: 11, gmarques: 22 } }, commentId: 789 },
  { github, worker: async u => {
    const response = Object.defineProperty(new Response(JSON.stringify({ version: 1, check: "route_runtime", result: "available" }),
      { headers: { "content-type": "application/json" } }), "url", { value: String(u) });
    if (phase === "after-read") { await response.clone().text(); process.exit(77); }
    return response;
  }, now: () => pins.readyAt + 2000 }, io);
process.stdout.write(dispatched ? "dispatched\n" : "blocked\n");
