// Checks publication candidates without printing matching secret values.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/,
  /"(?:private_key|refresh_token|client_secret)"\s*:\s*"[^"\s]{12,}/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/,
];
const tracked = new Set(execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean));
let failed = false;
for (const file of new Set(files)) {
  const forbidden = /(^|\/)(?:\.deploy|\.aws|secrets|credentials|data)\//.test(file)
    || /(^|\/)\.env(?:\..*)?$/.test(file) && file !== '.env.example'
    || /(?:service-account|google-tasks-(?:oauth|token)).*\.json$|\.(?:pem|key|sqlite3?|db)(?:-|$)/i.test(file);
  const contents = [];
  if (tracked.has(file)) contents.push(execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
  try { contents.push(readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (forbidden || contents.some((content) => patterns.some((pattern) => pattern.test(content)))) {
    console.error(`Potential secret or private data: ${file}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Secret check passed (${new Set(files).size} files). This is a basic check, not a full audit.`);
