import { execFileSync } from 'node:child_process';

// Two Claude Code passes: one that fixes, one that tries to refute the fix.
// The reviewer never sees the fixer's reasoning — sharing the fixer's framing is
// exactly what produces a reviewer with the same blind spot.

// --max-turns caps a runaway run. Whether that spend is API billing or
// subscription quota depends on which credential the workflow supplies
// (ANTHROPIC_API_KEY vs CLAUDE_CODE_OAUTH_TOKEN); the cap matters either way.
const MAX_TURNS = { fix: process.env.AUTOFIX_MAX_TURNS ?? '30', review: process.env.REVIEW_MAX_TURNS ?? '15' };

const run = (prompt, { cwd, allowedTools, maxTurns }) =>
  execFileSync('claude', [
    '-p', prompt,
    '--allowed-tools', allowedTools.join(','),
    '--permission-mode', 'acceptEdits',
    '--max-turns', maxTurns,
  ], {
    cwd, encoding: 'utf8', stdio: 'pipe', timeout: 25 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });

const FIX_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
const REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];

export function proposeFix({ cwd, issue, stackTrace, validationHint }) {
  const prompt = `A production error is being reported by Sentry. Fix it.

SENTRY ISSUE ${issue.shortId} — ${issue.title}
Culprit: ${issue.culprit}
Occurrences: ${issue.count} across ${issue.userCount} users
Link: ${issue.permalink}

STACK TRACE (latest event):
${stackTrace}

YOUR TASK
1. Locate the fault from the stack trace. Read the surrounding code before changing anything.
2. Identify the ROOT CAUSE, not the symptom.
3. Make the MINIMAL targeted change that fixes it. Do not refactor. Do not fix unrelated things you notice.
4. Add a regression test if this repo has a test suite and the bug is testable. Match the existing test conventions.
5. Do NOT touch: secrets, .env files, CI config, firestore.rules, package.json dependencies, or anything outside the fault's own area.

VALIDATION available in this repo: ${validationHint}

ABORT RATHER THAN GUESS. If the stack trace does not resolve to real source (minified frames, no line numbers), or you cannot determine the root cause with confidence, make NO changes and say why.

When done, output a section headed "ROOT CAUSE:" with 1-3 sentences, then "CHANGES:" listing each file and why. If you aborted, output "ABORTED:" and the reason.`;

  return run(prompt, { cwd, allowedTools: FIX_TOOLS, maxTurns: MAX_TURNS.fix });
}

// Adversarial: the reviewer re-derives the cause from the trace alone and is told
// to default to rejection under doubt.
export function reviewFix({ cwd, issue, stackTrace, diff }) {
  const prompt = `You are reviewing a proposed fix for a production error. Your job is to REFUTE it, not to confirm it.

SENTRY ISSUE ${issue.shortId} — ${issue.title}
Culprit: ${issue.culprit}

STACK TRACE (latest event):
${stackTrace}

PROPOSED DIFF:
${diff}

Deliberately withheld: the author's explanation. Re-derive the root cause yourself from the trace and the code, then judge the diff against YOUR conclusion, not theirs.

CHECK, in order:
1. Does the trace actually resolve to the code this diff changes?
2. Would this change genuinely prevent the reported error, or does it only suppress the symptom (a swallowed catch, a widened type, a null guard that hides the real cause)?
3. Does it change behaviour beyond the fix? Any refactor, any unrelated edit, any scope creep is a rejection.
4. Does it break an existing contract or test?
5. Does it touch anything security-sensitive (auth, permissions, rules, secrets, CI)? If so, reject and require human review.
6. If a regression test was added, would it actually FAIL without the fix? A test that passes either way is worthless.

Read the repository as needed to answer these. Do not modify any file.

DEFAULT TO REJECTION IF UNSURE. A wrong fix merged automatically is far worse than a fix that waits for a human.

Output exactly one line starting "VERDICT: APPROVE" or "VERDICT: REJECT", then a short justification. If you reject, state precisely what would have to change.`;

  return run(prompt, { cwd, allowedTools: REVIEW_TOOLS, maxTurns: MAX_TURNS.review });
}

export const parseVerdict = (text) => /^VERDICT:\s*APPROVE\b/im.test(text) && !/^VERDICT:\s*REJECT\b/im.test(text);

export function parseSection(text, heading) {
  const re = new RegExp(`^${heading}:?\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z ]{3,}:|$)`, 'im');
  return text.match(re)?.[1]?.trim() ?? '';
}

export const wasAborted = (text) => /^ABORTED:/im.test(text);
