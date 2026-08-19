import { execFileSync } from 'node:child_process';

const gh = (args, cwd) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

// One branch name per Sentry issue is the whole dedup mechanism — it survives
// reruns, and a closed PR still leaves the branch as evidence the issue was seen.
export const branchFor = (issue) => `autofix/sentry-${String(issue.shortId || issue.id).toLowerCase()}`;

export function alreadyHandled(cwd, issue) {
  const branch = branchFor(issue);
  const remote = git(['ls-remote', '--heads', 'origin', branch], cwd);
  if (remote) return { handled: true, why: `branch ${branch} already exists` };

  // A closed-without-merge PR means a human rejected this fix; reopening it
  // would be nagging, not helping.
  const prs = JSON.parse(gh(['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url'], cwd) || '[]');
  if (prs.length) return { handled: true, why: `PR #${prs[0].number} already exists (${prs[0].state})`, url: prs[0].url };

  return { handled: false };
}

export function createBranch(cwd, branch, baseRef) {
  git(['checkout', '-b', branch, baseRef], cwd);
}

export function commitAll(cwd, message) {
  git(['add', '-A'], cwd);
  git(['commit', '-m', message], cwd);
}

export const hasChanges = (cwd) => git(['status', '--porcelain'], cwd).length > 0;

export function push(cwd, branch) {
  git(['push', '-u', 'origin', branch], cwd);
}

// Always opens as a DRAFT. Promotion to ready and merge happen only after every
// gate passes, so the default state of an unreviewed AI change is "waiting".
export function openDraftPr(cwd, { title, body, base }) {
  return gh(['pr', 'create', '--draft', '--title', title, '--body', body, '--base', base], cwd);
}

export function markReadyAndMerge(cwd, prUrl) {
  gh(['pr', 'ready', prUrl], cwd);
  gh(['pr', 'merge', prUrl, '--squash', '--delete-branch'], cwd);
}

export function comment(cwd, prUrl, body) {
  gh(['pr', 'comment', prUrl, '--body', body], cwd);
}

export function diffAgainst(cwd, baseRef) {
  return git(['diff', `${baseRef}...HEAD`], cwd);
}

export const currentBranch = (cwd) => git(['branch', '--show-current'], cwd);
