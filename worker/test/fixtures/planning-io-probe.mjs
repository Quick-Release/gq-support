// Deliberate bypass canaries in exactly the launcher's network/mount boundary.
import { writeSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { request as https } from "node:https";
import { connect } from "node:net";
import { connect as tls } from "node:tls";
import { connect as http2 } from "node:http2";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { spawnSync } from "node:child_process";
const { hostFile, canary } = JSON.parse(readFileSync(0, "utf8"));
const refused = async (task) => {
  try { await task(); return false; }
  catch (error) { return ["ENETUNREACH", "EHOSTUNREACH", "ENOENT", "EAI_AGAIN", "ENOTFOUND", "EROFS"].includes(error.code ?? error.cause?.code); }
};
const socket = (make) => new Promise((resolve, reject) => {
  const client = make();
  client.on("connect", () => { client.destroy(); resolve(); });
  client.on("error", reject);
  setTimeout(() => { client.destroy(); reject(new Error("probe did not observe denial")); }, 1000).unref();
});
const http = (make, url) => new Promise((resolve, reject) => {
  const client = make(url);
  client.on("error", reject);
  client.on("socket", (socket) => socket.on("connect", () => { client.destroy(); resolve(); }));
  client.end();
  setTimeout(() => { client.destroy(); reject(new Error("probe did not observe denial")); }, 1000).unref();
});
const checks = [];
checks.push(await refused(() => fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(1000) })));
checks.push(await refused(() => http(request, "http://1.1.1.1/")));
checks.push(await refused(() => http(https, "https://1.1.1.1/")));
checks.push(await refused(() => socket(() => connect({ host: "1.1.1.1", port: 80 }))));
checks.push(await refused(() => socket(() => tls({ host: "1.1.1.1", port: 443 }))));
checks.push(await refused(() => socket(() => http2("https://1.1.1.1/"))));
checks.push(await refused(() => lookup("example.com")));
checks.push(await refused(() => new Promise((resolve, reject) => {
  const udp = createSocket("udp4"); udp.on("error", reject);
  udp.send("probe", 53, "1.1.1.1", (error) => { udp.close(); if (error) reject(error); else resolve(); });
})));
checks.push(await refused(() => socket(() => connect({ path: "/var/run/docker.sock" }))));
checks.push(await refused(() => Promise.resolve(readFileSync(hostFile))));
checks.push(await refused(() => Promise.resolve(writeFileSync("/workspace/worker/src/worker.ts", canary))));
checks.push(process.env.PLANNING_CANARY === undefined && process.env.NODE_OPTIONS === undefined && process.env.HTTP_PROXY === undefined);
const child = spawnSync("/runtime/node", ["-e", 'fetch("http://1.1.1.1/", {signal: AbortSignal.timeout(1000)}).then(()=>process.exit(1),(error)=>process.exit(error.cause?.code === "ENETUNREACH" ? 0 : 2))'], { timeout: 2000 });
checks.push(child.status === 0);
// Prove raw progress/errors/build output never becomes parent output.
console.log(canary); console.error(canary);
writeSync(3, JSON.stringify({ denied: checks }));
