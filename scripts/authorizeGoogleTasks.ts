import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { google, Auth } from "googleapis";

async function main(): Promise<void> {
const credentialsPath = path.resolve("google-tasks-oauth.json");
const tokenPath = path.resolve("google-tasks-token.json");
const scopes = ["https://www.googleapis.com/auth/tasks"];

const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as {
  installed?: { client_id?: string; client_secret?: string };
};
const client = credentials.installed;
if (!client?.client_id || !client.client_secret) {
  throw new Error("google-tasks-oauth.json должен содержать Desktop OAuth client");
}

const auth = new google.auth.OAuth2(client.client_id, client.client_secret);
const state = randomBytes(32).toString("base64url");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
let complete!: (code: string) => void;
const codePromise = new Promise<string>((resolve) => { complete = resolve; });
let accepted = false;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/oauth2callback" || url.searchParams.get("state") !== state || accepted) {
    res.writeHead(400).end("Invalid OAuth callback.");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 4096) {
    res.writeHead(400).end("Missing authorization code. Restart authorization if access was denied.");
    return;
  }
  accepted = true;
  res.setHeader("Cache-Control", "no-store");
  res.end("Authorization received. Return to the terminal.");
  complete(code);
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot start loopback listener");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const url = auth.generateAuthUrl({
    redirect_uri: redirectUri, access_type: "offline", scope: scopes,
    prompt: "consent", state, code_challenge: challenge, code_challenge_method: Auth.CodeChallengeMethod.S256,
  });
  console.log("Откройте эту ссылку в браузере на этом же компьютере (действует 5 минут):\n", url);
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("OAuth timeout")), 5 * 60_000);
  });
  const code = await Promise.race([codePromise, deadline]);
  const { tokens } = await auth.getToken({ code, redirect_uri: redirectUri, codeVerifier: verifier });
  auth.setCredentials(tokens);
} finally {
  clearTimeout(timeout);
  server.closeAllConnections();
  server.close();
}
if (!auth.credentials.refresh_token) {
  throw new Error("Google не вернул refresh_token. Отзовите старый доступ приложения и повторите авторизацию.");
}

const temporaryTokenPath = `${tokenPath}.${randomBytes(8).toString("hex")}.tmp`;
try {
  await writeFile(temporaryTokenPath, JSON.stringify({
    type: "authorized_user",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: auth.credentials.refresh_token,
  }, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporaryTokenPath, tokenPath);
} finally {
  await rm(temporaryTokenPath, { force: true });
}

const tasks = google.tasks({ version: "v1", auth });
const response = await tasks.tasklists.list({ maxResults: 100 });
console.log("\nАвторизация выполнена. Доступные списки TasksBoard / Google Tasks:\n");
for (const list of response.data.items ?? []) {
  console.log(`${list.title ?? "Без названия"}\t${list.id}`);
}
console.log(`\nТокен сохранён: ${tokenPath}`);

}

main().catch(() => {
  console.error("Авторизация не завершена. Проверьте Desktop OAuth credentials, настройки Google и соединение. Подробности скрыты для защиты токенов.");
  process.exitCode = 1;
});
