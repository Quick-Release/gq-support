import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export function keyLeakCheck(pem: string) {
  const base64 = pem.replace(/-----[^\n]+-----|\s/g, "");
  const needles = [Buffer.from(pem), Buffer.from(base64), Buffer.from(base64, "base64"),
    Buffer.from(JSON.stringify(pem).slice(1, -1))];
  return (input: string | Uint8Array) => {
    const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
    if (needles.some((value) => bytes.includes(value)) ||
        /-----BEGIN (?:RSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{80,}/.test(bytes.toString("utf8").replaceAll("\\n", "\n"))) {
      throw new Error("App key material found outside its secret binding");
    }
  };
}

export async function scanKeyFiles(directory: string, assertClean: ReturnType<typeof keyLeakCheck>): Promise<number> {
  let names;
  try { names = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    if (["node_modules", ".git"].includes(name.name) || name.isSymbolicLink()) continue;
    const path = join(directory, name.name);
    if (name.isDirectory()) count += await scanKeyFiles(path, assertClean);
    else if (name.isFile()) { assertClean(await readFile(path)); count++; }
  }
  return count;
}

/** Match both the complete Discord URL and its credential path component. Never print either. */
export function discordLeakCheck(webhook: string) {
  const token = webhook.split("/").at(-1);
  if (!token || token.length < 60) throw new Error("Discord custody configuration invalid");
  const needles = [Buffer.from(webhook), Buffer.from(token)];
  return (input: string | Uint8Array) => {
    const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
    if (needles.some((needle) => bytes.includes(needle))) throw new Error("Discord credential found outside its secret binding");
  };
}
