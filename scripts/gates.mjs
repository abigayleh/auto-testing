import { execFileSync } from 'node:child_process';

// Auto-merge gates. Everything here is a reason to leave the PR open for a human
// rather than a reason to discard the fix — a blocked merge still ships a PR.
export const MAX_CHANGED_LINES = 50;
export const MAX_CHANGED_FILES = 3;

// Paths where a wrong change is expensive enough that a human always looks.
// Security boundaries, auth, CI, dependencies, and anything secret-adjacent.
const PROTECTED = [
  /(^|\/)firestore\.rules$/,
  /(^|\/)firebase\.json$/,
  /(^|\/)\.github\//,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)prisma\/(schema\.prisma|migrations\/)/,
  /(^|\/)\.env/,
  /(^|\/)netlify\.toml$/,
  /(^|\/)eas\.json$/,
  /auth/i,
  /requireUser|familyAccess|familyJoin|safeUrl|firebaseAdmin/,
  /(^|\/)middleware\.(t|j)s$/,
];

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

export function diffStat(repoDir, baseRef) {
  const files = git(repoDir, ['diff', '--name-only', `${baseRef}...HEAD`]).split('\n').filter(Boolean);
  const numstat = git(repoDir, ['diff', '--numstat', `${baseRef}...HEAD`]).split('\n').filter(Boolean);
  const changedLines = numstat.reduce((sum, line) => {
    const [add, del] = line.split('\t');
    return sum + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
  return { files, changedLines };
}

// Test files are exempt from the size cap: a thorough regression test is a good
// sign, and capping it would push the fixer toward writing less of one.
const isTest = (f) => /(^|\/)(tests?|__tests__|e2e|\.maestro)\//.test(f) || /\.(test|spec)\.[jt]sx?$/.test(f);

export function evaluate({ files, changedLines }, sourceLines) {
  const reasons = [];
  const protectedHits = files.filter((f) => PROTECTED.some((re) => re.test(f)));

  if (protectedHits.length) reasons.push(`touches protected paths: ${protectedHits.join(', ')}`);
  if (files.filter((f) => !isTest(f)).length > MAX_CHANGED_FILES) {
    reasons.push(`${files.length} files changed (max ${MAX_CHANGED_FILES} excluding tests)`);
  }
  if (sourceLines > MAX_CHANGED_LINES) {
    reasons.push(`${sourceLines} source lines changed (max ${MAX_CHANGED_LINES}, tests excluded)`);
  }
  if (!files.length) reasons.push('no changes produced');

  return { autoMergeAllowed: reasons.length === 0, reasons, protectedHits, changedLines };
}

export function sourceLineCount(repoDir, baseRef) {
  const numstat = git(repoDir, ['diff', '--numstat', `${baseRef}...HEAD`]).split('\n').filter(Boolean);
  return numstat.reduce((sum, line) => {
    const [add, del, file] = line.split('\t');
    if (isTest(file)) return sum;
    return sum + (Number(add) || 0) + (Number(del) || 0);
  }, 0);
}
