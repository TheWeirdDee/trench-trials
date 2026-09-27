/**
 * npm run check:links
 *
 * Checks every Markdown link in the README and docs: relative files must exist, `#anchors`
 * must match a heading (GitHub's slug rules), and external http(s) links must answer.
 * Links into the live site or GitHub pages of this repository that only exist after a
 * push or deploy are reported, not failed, with `--offline`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const FILES = [
  'README.md',
  'SETUP.md',
  'ARCHITECTURE.md',
  'DATA-CONTRACT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => join('docs', f)),
];
const offline = process.argv.includes('--offline');

function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(file: string): Set<string> {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slug(m[1]!.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
    const n = seen.get(base) ?? 0;
    out.add(n === 0 ? base : `${base}-${n}`);
    seen.set(base, n + 1);
  }
  return out;
}

async function main() {
  let failures = 0;
  let checked = 0;
  const external = new Set<string>();
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      checked++;
      if (/^https?:\/\//.test(target)) {
        external.add(target);
        continue;
      }
      if (target.startsWith('mailto:')) continue;
      const [path, hash] = target.split('#') as [string, string | undefined];
      const resolved = path ? normalize(join(dirname(file), path)) : file;
      if (path && !existsSync(resolved)) {
        failures++;
        console.error(`FAIL ${file}: ${target} (missing ${resolved})`);
        continue;
      }
      if (hash && statSync(resolved).isFile() && resolved.endsWith('.md') && !anchors(resolved).has(hash)) {
        failures++;
        console.error(`FAIL ${file}: ${target} (no heading #${hash} in ${resolved})`);
      }
    }
  }
  if (!offline) {
    for (const url of external) {
      let status = 0;
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
        status = res.status;
      } catch {
        status = 0;
      }
      const ok = status >= 200 && status < 400;
      // X (Twitter) and some hosts refuse scripted requests; report without failing.
      const tolerated = !ok && /(^https:\/\/(x|twitter)\.com\/)/.test(url);
      if (!ok && !tolerated) failures++;
      console.log(`${ok ? 'ok  ' : tolerated ? 'skip' : 'FAIL'} ${status || 'ERR'} ${url}`);
    }
  }
  console.log(`\n${checked} link(s) in ${FILES.length} file(s); ${external.size} external; ${failures} failure(s).`);
  if (failures > 0) process.exitCode = 1;
}

main();
