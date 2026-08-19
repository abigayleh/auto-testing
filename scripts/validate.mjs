import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Validation is a per-repo profile read from package.json, never a fixed command
// triple: whats-the-plan-be has no lint and no typecheck, and fork-yeah's `lint`
// is a dead `next lint` under Next 16. A step that assumes a script exists fails
// on a perfectly healthy repo, so a missing script is a SKIP, not a failure.
const CANDIDATES = [
  { script: 'test:run', label: 'tests' },
  { script: 'test', label: 'tests', skipIf: (pkg) => hasScript(pkg, 'test:run') },
  { script: 'test:rules', label: 'firestore rules' },
  { script: 'typecheck', label: 'typecheck' },
  { script: 'lint', label: 'lint' },
  { script: 'build', label: 'build' },
];

const hasScript = (pkg, name) => Boolean(pkg.scripts?.[name]);

// `next lint` was removed in Next 16, so the script exists but always errors.
// Running it would abort every fix for a reason unrelated to the fix.
function isBrokenScript(pkg, name) {
  const cmd = pkg.scripts?.[name] ?? '';
  const next = pkg.dependencies?.next ?? pkg.devDependencies?.next ?? '';
  const major = Number(String(next).replace(/[^\d.]/g, '').split('.')[0] || 0);
  return name === 'lint' && cmd.trim().startsWith('next lint') && major >= 16;
}

export function buildProfile(repoDir) {
  const pkgPath = join(repoDir, 'package.json');
  if (!existsSync(pkgPath)) return { steps: [], skipped: ['no package.json'] };
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  const steps = [];
  const skipped = [];

  // Prisma builds its client at module load, so the BE suite dies at import
  // without this. Cheap and harmless where there is no schema.
  if (existsSync(join(repoDir, 'prisma', 'schema.prisma'))) {
    steps.push({ label: 'prisma generate', cmd: 'npx', args: ['prisma', 'generate'] });
  }

  for (const c of CANDIDATES) {
    if (!hasScript(pkg, c.script)) { skipped.push(`${c.script} (not defined)`); continue; }
    if (c.skipIf?.(pkg)) continue;
    if (isBrokenScript(pkg, c.script)) { skipped.push(`${c.script} (broken: next lint removed in Next 16)`); continue; }
    steps.push({ label: c.label, cmd: 'npm', args: ['run', c.script].filter(Boolean), script: c.script });
  }

  // `npm test` is invoked without `run`.
  for (const s of steps) if (s.script === 'test') s.args = ['test'];

  return { steps, skipped };
}

export function runProfile(repoDir, profile) {
  const results = [];
  for (const step of profile.steps) {
    const started = Date.now();
    try {
      const out = execFileSync(step.cmd, step.args, {
        cwd: repoDir, encoding: 'utf8', stdio: 'pipe', timeout: 20 * 60 * 1000,
        env: { ...process.env, CI: 'true' },
      });
      results.push({ ...step, ok: true, ms: Date.now() - started, tail: tail(out) });
    } catch (err) {
      const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      results.push({
        ...step,
        ok: false,
        ms: Date.now() - started,
        // A timeout or a killed process is infrastructure, not a bad fix. The
        // caller turns this into "inconclusive" rather than "no safe fix".
        inconclusive: err.killed === true || err.signal != null,
        tail: tail(output) || String(err.message),
      });
      break;
    }
  }
  return results;
}

const tail = (s, n = 40) => String(s || '').trimEnd().split('\n').slice(-n).join('\n');

export const summarize = (results) => ({
  passed: results.every((r) => r.ok),
  inconclusive: results.some((r) => r.inconclusive),
  failed: results.find((r) => !r.ok) ?? null,
});
