import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CentralTarget, CentralTransport, CommandResult } from "../src/central-deployment.ts";
import { slotInventory } from "../src/inventory.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { asQueryDatabase } from "../src/operator.ts";
import { localStage } from "./local-d1.ts";

// #143: centrally managed installations receive the exact approved package through
// central hosting access, with each outcome recorded. Through the Operator CLI with
// local D1 and a stand-in host that answers the adapter's WP-CLI commands.
const START = Date.parse("2026-10-20T10:00:00Z");
const mappings: RepositoryMapping[] = [
  { slot: "shop/production", client: "shop", project: "shop", environment: "production", repositoryId: 42, defaultDeveloper: "developer", deployment: "central" },
  { slot: "news/production", client: "news", project: "news", environment: "production", repositoryId: 43, defaultDeveloper: "developer", deployment: "native" },
];
const PLUGIN = "/srv/www/shop/web/app/plugins/gq-support";
const target: CentralTarget = { slot: "shop/production", runner: ["ssh", "-o", "BatchMode=yes", "shop-production"], runnerFailureExit: 255,
  wp: ["wp", "--path=/srv/www/shop/web/wp"], pluginDirectory: PLUGIN, uploadDirectory: "/tmp" };

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let now: number;
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const at = (time: number) => new Date(time).toISOString();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A release ZIP as the release workflow writes it: every file under one `gq-support/` root, deflated. */
const zipOf = (files: Record<string, string>) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries({ "gq-support/": "", ...Object.fromEntries(Object.entries(files).map(([p, t]) => [`gq-support/${p}`, t])) })) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const directory = path.endsWith("/");
    const packed = directory ? Buffer.alloc(0) : deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(directory ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(directory ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((directory ? 0o40755 : 0o100644) * 0x10000, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
};
const pluginFiles = (version: string) => ({
  "gq-support.php": `<?php\n/* Plugin Name: GETQUICK Support\n * Version: ${version} */\n`,
  "includes/class-gq-support-state.php": `<?php // ${version}\n`,
  "readme.txt": `Stable tag: ${version}\n`,
});

/**
 * One WordPress installation behind central hosting access, as the adapter's
 * commands see it: WP-CLI's view of the plugin, a temporary upload and the
 * plugin's files. It installs only ZIPs the test built, by their digest.
 */
interface Host extends CentralTransport {
  readonly calls: { argv: readonly string[]; stdin: number }[];
  files: Map<string, string> | null;
  version: string | null;
  active: boolean;
  symlink: boolean;
  uploads: Map<string, Uint8Array>;
  /** Replaces the answer to the next matching command, once. */
  next: (match: (command: readonly string[]) => boolean, answer: (command: readonly string[], options: { stdin?: Uint8Array }) => CommandResult | Promise<CommandResult>) => void;
}
const artifacts = new Map<string, { zip: Uint8Array; manifest: string; provenance: string }>();
const packages = new Map<string, { version: string; files: Record<string, string> }>();
const fakeHost = (version: string | null): Host => {
  const overrides: { match: (command: readonly string[]) => boolean; answer: (command: readonly string[], options: { stdin?: Uint8Array }) => CommandResult | Promise<CommandResult> }[] = [];
  const exit = (code: number, stdout = ""): CommandResult => ({ kind: "exit", code, stdout });
  const host: Host = {
    calls: [], uploads: new Map(), active: true, symlink: false, version,
    files: version === null ? null : new Map(Object.entries(pluginFiles(version))),
    next: (match, answer) => { overrides.push({ match, answer }); },
    async run(argv, { stdin } = {}) {
      host.calls.push({ argv, stdin: stdin?.length ?? 0 });
      expect(argv.slice(0, target.runner.length)).toEqual(target.runner);
      const command = argv.slice(target.runner.length);
      const override = overrides.findIndex((candidate) => candidate.match(command));
      if (override >= 0) return overrides.splice(override, 1)[0]!.answer(command, { ...(stdin ? { stdin } : {}) });
      const wp = command.slice(0, target.wp.length).join(" ") === target.wp.join(" ") ? command.slice(target.wp.length) : null;
      if (command[0] === "test" && command.join(" ") === `test ! -L ${PLUGIN}`) return exit(host.symlink ? 1 : 0);
      if (wp?.join(" ") === "plugin get gq-support --field=version") return host.version === null ? exit(1) : exit(0, `${host.version}\n`);
      if (wp?.join(" ") === "plugin is-active gq-support") return exit(host.version !== null && host.active ? 0 : 1);
      if (command[0] === "cp" && command[1] === "/dev/stdin") { host.uploads.set(command[2]!, stdin!); return exit(0); }
      if (command[0] === "sha256sum" && command[1] === "--") {
        const lines = command.slice(2).map((path) => {
          const upload = host.uploads.get(path);
          const file = path.startsWith(`${PLUGIN}/`) ? host.files?.get(path.slice(PLUGIN.length + 1)) : undefined;
          const digest = upload ? sha256(upload) : file !== undefined ? sha256(Buffer.from(file)) : null;
          return digest && `${digest}  ${path}`;
        });
        return lines.every(Boolean) ? exit(0, lines.join("\n") + "\n") : exit(1, lines.filter(Boolean).join("\n"));
      }
      if (wp?.slice(0, 2).join(" ") === "plugin install" && wp.slice(3).join(" ") === "--force") {
        const upload = host.uploads.get(wp[2]!);
        const known = upload && packages.get(sha256(upload));
        if (!known) return exit(1);
        host.version = known.version;
        host.files = new Map(Object.entries(known.files));
        return exit(0, "Plugin updated successfully.\n");
      }
      if (command[0] === "find" && command[1] === PLUGIN && command.slice(2).join(" ") === "-type f -print") {
        return exit(0, [...host.files?.keys() ?? []].map((path) => `${PLUGIN}/${path}`).join("\n") + "\n");
      }
      if (command[0] === "find" && command[1] === PLUGIN && command.slice(2).join(" ") === "-type l -print") return exit(0, "");
      if (command.join(" ").startsWith("rm -f -- /tmp/")) { host.uploads.delete(command[3]!); return exit(0); }
      throw new Error(`Unexpected command: ${command.join(" ")}`);
    },
  };
  return host;
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  artifacts.clear();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const query = (database: D1Database) => async (sql: string, parameters: readonly (string | number)[]) =>
  (await database.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
type D1Database = (typeof stage)["databases"]["shared"];

let host: Host;
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: query(stage.databases.shared), ledger: query(stage.databases.ledger),
  readArtifact: async (directory) => artifacts.get(directory)!,
  central: { targets: [target], transport: host } });
/** Publishes `version` as the release workflow would, approves it and records its dispatch. */
const release = async (version: string, expected: string, { kind = "production", dispatch = true } = {}) => {
  if (!artifacts.has(version)) {
    const zip = zipOf(pluginFiles(version));
    packages.set(sha256(zip), { version, files: pluginFiles(version) });
    artifacts.set(version, { zip, manifest: JSON.stringify({ name: "gq-support", version, zip: { size: zip.length, sha256: sha256(zip) } }),
      provenance: JSON.stringify({ version, commit: "b".repeat(40), run: "39000000001", zip_sha256: sha256(zip) }) });
    await operator("release-candidate", version, "a".repeat(40), "1", "0001-0029", "signed", "alex");
  }
  const { release_id: id } = JSON.parse(await operator("release-approve", version, kind, expected,
    "https://github.com/Quick-Release/gq-support/pull/143", "alex")) as { release_id: number };
  if (dispatch) await operator("release-dispatch", String(id), at(now), "https://github.com/Quick-Release/gq-support/actions/runs/1", "alex");
  return { id: String(id), sha256: sha256(artifacts.get(version)!.zip) };
};
const apply = async (releaseId: string, version: string, slot = "shop/production") =>
  JSON.parse(await operator("central-apply", slot, releaseId, version, "alex")) as Record<string, unknown>;
const inventory = async () => (await slotInventory(asQueryDatabase(query(stage.databases.shared)), mappings, null, now)).slots[0]!;

it("installs the exact approved bytes through central hosting access and records desired, attempted and verified versions", async () => {
  host = fakeHost("0.1.9");
  const approved = await release("0.2.0", "none");
  advance(60_000);

  const result = await apply(approved.id, "0.2.0");

  expect(result).toMatchObject({ slot: "shop/production", release_id: Number(approved.id), desired_version: "0.2.0",
    package_sha256: approved.sha256, previous_version: "0.1.9", outcome: "verified", observed_version: "0.2.0", installed: true });
  // The host received exactly the approved bytes, then WordPress installed that upload.
  const upload = host.calls.find((call) => call.argv.includes("/dev/stdin"))!;
  expect(upload.stdin).toBe(artifacts.get("0.2.0")!.zip.length);
  expect(host.version).toBe("0.2.0");
  expect(host.active).toBe(true);
  expect(host.uploads.size).toBe(0);
  const slot = await inventory();
  expect(slot.versions).toMatchObject({ desired: { version: "0.2.0" }, attempted: { version: "0.2.0", source: "central-deployment" },
    observed: { state: "current", version: "0.2.0", source: "central-deployment" } });
  expect(slot.update).toEqual({ outcome: "confirmed", at: at(now) });
});

it("refuses before contacting the installation unless the Slot, its reviewed target, the approved release and its bytes all check out", async () => {
  host = fakeHost("0.1.9");
  const first = await release("0.2.0", "none");
  const second = await release("0.3.0", first.id, { dispatch: false });
  // Approved but its dispatch not yet recorded, or no longer the approved release.
  await expect(apply(second.id, "0.3.0")).rejects.toThrow(/approved release with a recorded dispatch/);
  await expect(apply(first.id, "0.2.0")).rejects.toThrow(/approved release with a recorded dispatch/);
  await operator("release-dispatch", second.id, at(now), "https://github.com/Quick-Release/gq-support/actions/runs/2", "alex");
  // A native Slot, or a Slot without a reviewed target: no stage has one yet.
  await expect(apply(second.id, "0.3.0", "news/production")).rejects.toThrow(/not central/);
  const { stageCentralTargets } = await import("../src/central-deployment.ts");
  expect(stageCentralTargets).toEqual({ staging: [], prod: [] });
  await expect(runOperator(["central-apply", "shop/production", second.id, "0.3.0", "alex"], { mappings, now, recordRevocation: async () => {},
    query: query(stage.databases.shared), readArtifact: async (directory) => artifacts.get(directory)!,
    central: { targets: stageCentralTargets.prod, transport: host } })).rejects.toThrow(/No reviewed central deployment target/);
  // A target whose tokens a remote shell would interpret is not used.
  await expect(runOperator(["central-apply", "shop/production", second.id, "0.3.0", "alex"], { mappings, now, recordRevocation: async () => {},
    query: query(stage.databases.shared), readArtifact: async (directory) => artifacts.get(directory)!,
    central: { targets: [{ ...target, wp: ["wp", "--path=/srv/www/$(id)"] }], transport: host } })).rejects.toThrow(/shell-safe/);
  // Other bytes under the approved version are never sent.
  artifacts.set("tampered", { ...artifacts.get("0.3.0")!, zip: zipOf({ ...pluginFiles("0.3.0"), "extra.php": "<?php" }) });
  await expect(apply(second.id, "tampered")).rejects.toThrow(/do not match|integrity/);
  // An offboarded Slot gets no further central deployment.
  await operator("offboard", "shop/production", "alex");
  await expect(apply(second.id, "0.3.0")).rejects.toThrow(/offboarded/);

  expect(host.calls).toEqual([]);
  expect(JSON.parse(await operator("central-status", "shop/production")).deployments).toEqual([]);
});

const lost = (): CommandResult => ({ kind: "lost" });
const isWp = (...rest: string[]) => (command: readonly string[]) => command.slice(target.wp.length).join(" ") === rest.join(" ") && command[0] === "wp";
const isInstall = (command: readonly string[]) => command.includes("install") && command[0] === "wp";

it("leaves an unreachable installation unchanged and unknown, never failed or updated", async () => {
  host = fakeHost("0.1.9");
  const approved = await release("0.2.0", "none");
  // ssh's own connection failure is no answer from the host.
  host.next(() => true, () => ({ kind: "exit", code: 255, stdout: "" }));

  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "unreachable", reason: "unreachable", installed: false, observed_version: null });
  expect(host.calls.some((call) => call.stdin > 0)).toBe(false);
  expect(host.version).toBe("0.1.9");
  const slot = await inventory();
  expect(slot.versions).toMatchObject({ attempted: null, observed: { state: "unknown", reason: "absent" } });
  expect(slot.update).toEqual({ outcome: "none", at: null });
  expect(slot.central_deployment).toMatchObject({ release_id: Number(approved.id), outcome: "unreachable" });
});

it("records a failure only when the read-back confirms WordPress did not install the approved package", async () => {
  host = fakeHost("0.1.9");
  const approved = await release("0.2.0", "none");
  host.next(isInstall, () => ({ kind: "exit", code: 1, stdout: "" }));

  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "failed", reason: "version_mismatch", installed: true, observed_version: "0.1.9" });
  const slot = await inventory();
  expect(slot.update).toMatchObject({ outcome: "failed" });
  expect(slot.versions).toMatchObject({ observed: { version: "0.1.9", source: "central-deployment" } });

  // The right version with other files is not the approved package either.
  host.next(isInstall, () => { host.version = "0.2.0"; host.files!.set("gq-support.php", "<?php // tampered"); return { kind: "exit", code: 0, stdout: "" }; });
  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "failed", reason: "files_mismatch", observed_version: "0.2.0" });
  // Nor is one WordPress left deactivated.
  host.next(isInstall, async (command) => { const result = await host.run([...target.runner, ...command]); host.active = false; return result; });
  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "failed", reason: "deactivated" });
  // Bytes that change in transit are never installed.
  host = fakeHost("0.1.9");
  host.next((command) => command[0] === "cp", (command) => { host.uploads.set(command[2]!, new Uint8Array([1, 2, 3])); return { kind: "exit", code: 0, stdout: "" }; });
  const calls = host.calls.length;
  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "failed", reason: "upload_integrity", installed: false });
  expect(host.calls.slice(calls).some((call) => isInstall(call.argv.slice(target.runner.length)))).toBe(false);
});

it("reports an install whose transport was lost as unknown, then verifies it from a later read-back without reinstalling", async () => {
  host = fakeHost("0.1.9");
  const approved = await release("0.2.0", "none");
  // WordPress installs the package, but the connection drops before it answers and stays down.
  host.next(isInstall, async (command) => {
    await host.run([...target.runner, ...command]);
    host.next(isWp("plugin", "get", "gq-support", "--field=version"), () => lost());
    return lost();
  });

  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "unknown", reason: "transport_lost", installed: true, observed_version: null });
  let slot = await inventory();
  expect(slot.update).toEqual({ outcome: "unconfirmed", at: null });
  expect(slot.central_deployment).toMatchObject({ outcome: "unknown" });

  advance(60_000);
  const installs = host.calls.filter((call) => isInstall(call.argv.slice(target.runner.length))).length;
  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "verified", installed: false, previous_version: "0.2.0", observed_version: "0.2.0" });
  expect(host.calls.filter((call) => isInstall(call.argv.slice(target.runner.length))).length).toBe(installs);
  slot = await inventory();
  expect(slot.update).toEqual({ outcome: "confirmed", at: at(now) });
});

it("applies nothing once a newer approval or an offboarding arrives, and never two applications to one Slot at once", async () => {
  host = fakeHost("0.1.9");
  const approved = await release("0.2.0", "none");
  // A newer approval lands while the package is being uploaded.
  host.next((command) => command[0] === "cp", async (command, options) => {
    const result = await host.run([...target.runner, ...command], options);
    // Meanwhile another Operator's application to the same Slot is refused.
    await expect(apply(approved.id, "0.2.0")).rejects.toThrow(/another application to it is running/);
    await release("0.2.1", approved.id, { dispatch: false });
    return result;
  });

  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "refused", reason: "superseded", installed: false, still_approved: false });
  expect(host.version).toBe("0.1.9");
  expect(host.uploads.size).toBe(0);
  expect((await inventory()).update).toEqual({ outcome: "none", at: null });

  // Likewise an offboarding recorded mid-way stops the install.
  const newer = await operator("release-dispatch", "2", at(now), "https://github.com/Quick-Release/gq-support/actions/runs/2", "alex");
  expect(JSON.parse(newer)).toMatchObject({ release_id: 2 });
  host.next((command) => command[0] === "cp", async (command, options) => {
    const result = await host.run([...target.runner, ...command], options);
    await operator("offboard", "shop/production", "alex");
    return result;
  });
  expect(await apply("2", "0.2.1")).toMatchObject({ outcome: "refused", reason: "superseded", installed: false });
  expect(host.version).toBe("0.1.9");
});

it("downgrades only to an approved recovery package, and never replaces a symlinked development checkout", async () => {
  host = fakeHost("0.3.0");
  const approved = await release("0.2.0", "none");
  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "refused", reason: "downgrade", previous_version: "0.3.0" });
  expect(host.version).toBe("0.3.0");

  host = fakeHost("0.2.0");
  const bad = await release("0.3.0", approved.id);
  expect(await apply(bad.id, "0.3.0")).toMatchObject({ outcome: "verified", observed_version: "0.3.0" });
  // The bad release is withdrawn: the earlier verified package is the approved recovery version.
  const recovery = await release("0.2.0", bad.id, { kind: "recovery" });
  await expect(apply(bad.id, "0.3.0")).rejects.toThrow(/approved release with a recorded dispatch/);
  expect(await apply(recovery.id, "0.2.0")).toMatchObject({ kind: "recovery", outcome: "verified", previous_version: "0.3.0", observed_version: "0.2.0", installed: true });
  expect(host.version).toBe("0.2.0");

  host = fakeHost("0.1.9");
  host.symlink = true;
  expect(await apply(recovery.id, "0.2.0")).toMatchObject({ outcome: "refused", reason: "symlinked_plugin", installed: false });
  expect(host.version).toBe("0.1.9");
});

it("keeps working with report submission disabled and the Installation credential revoked: it needs nothing on the site", async () => {
  host = fakeHost("0.1.9");
  await stage.databases.shared.prepare(`INSERT INTO installation_key (key_id, slot, installation_id, public_key, origin, enrolled_at)
    VALUES ('report-key', 'shop/production', 'installation-a', 'public', 'https://shop.example', ?)`).bind(now).run();
  await operator("revoke", "shop/production");
  const approved = await release("0.2.0", "none");

  expect(await apply(approved.id, "0.2.0")).toMatchObject({ outcome: "verified" });
  // Only WP-CLI and file commands over the reviewed runner: no credential, URL or support-service call is sent.
  const sent = host.calls.map((call) => call.argv.slice(target.runner.length).join(" ")).join("\n");
  expect(sent).not.toMatch(/https?:|token|Bearer|gq-support (update|status|connect)/i);
  expect(host.calls.every((call) => call.argv.every((token) => /^[A-Za-z0-9@%+=:,./_!-]+$/.test(token)))).toBe(true);
});
