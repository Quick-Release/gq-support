import { appConfig, verifyApp } from "../deploy/github-app.ts";

try {
  const config = appConfig(process.argv[2], process.env);
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!pem) throw new Error("Missing GITHUB_APP_PRIVATE_KEY");
  console.log(JSON.stringify(await verifyApp(config, pem)));
} catch {
  console.error("GitHub App preflight failed; check stage, account, App identity, PKCS#8 key, permissions and events");
  process.exitCode = 1;
}
