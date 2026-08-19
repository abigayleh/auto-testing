import { listNewIssues, getIssue, getLatestEvent, resolvableFrames, formatStackTrace } from './sentry.mjs';
import { buildProfile, runProfile, summarize } from './validate.mjs';
import { diffStat, evaluate, sourceLineCount } from './gates.mjs';
import { proposeFix, reviewFix, parseVerdict, parseSection, wasAborted } from './claude.mjs';
import { sendFixOpened, sendAborted, guardRun } from './notify.mjs';
import * as gh from './github.mjs';
import { writeFileSync } from 'node:fs';

const env = (name, fallback) => process.env[name] ?? fallback;

// The workflow checks the app repo into $APP_DIR and runs this from the
// workspace root, so cwd is NOT the repo.
const REPO_DIR = env('APP_DIR', env('APP_REPO_DIR', process.cwd()));
const ORG = env('SENTRY_ORG', 'whatstheplaninc');
const PROJECT = env('SENTRY_PROJECT');
const BASE = env('BASE_BRANCH');
const ISSUE_ID = env('SENTRY_ISSUE_ID');
const REPO_NAME = env('APP_REPO', env('GITHUB_REPOSITORY', REPO_DIR));
const SUMMARY_FILE = env('AUTOFIX_SUMMARY_FILE');

async function handleIssue(issue) {
  const dedup = gh.alreadyHandled(REPO_DIR, issue);
  if (dedup.handled) return { outcome: 'skipped', issue, reason: dedup.why };

  const event = await getLatestEvent(issue.id);
  const usable = resolvableFrames(event.frames);

  // Hard gate: an unsymbolicated frame is a bundle offset, and a fix derived
  // from one is a guess wearing a stack trace.
  if (!usable.length) {
    await sendAborted({
      issue, repo: REPO_NAME, stage: 'triage',
      reason: 'no source-resolvable stack frames',
      detail: 'Every in-app frame lacks a file/line that maps to source. Source maps are probably missing or not uploaded for this release.',
    });
    return { outcome: 'no-safe-fix', issue, reason: 'unresolvable stack trace' };
  }

  const profile = buildProfile(REPO_DIR);
  const stackTrace = formatStackTrace(event);
  const branch = gh.branchFor(issue);
  gh.createBranch(REPO_DIR, branch, BASE);

  const fixOutput = proposeFix({
    cwd: REPO_DIR, issue, stackTrace,
    validationHint: profile.steps.map((s) => `${s.cmd} ${s.args.join(' ')}`).join(', ') || 'none',
  });

  if (wasAborted(fixOutput) || !gh.hasChanges(REPO_DIR)) {
    await sendAborted({
      issue, repo: REPO_NAME, stage: 'fix',
      reason: 'root cause unclear',
      detail: parseSection(fixOutput, 'ABORTED') || fixOutput.slice(-1500),
    });
    return { outcome: 'no-safe-fix', issue, reason: 'fixer aborted' };
  }

  const rootCause = parseSection(fixOutput, 'ROOT CAUSE');
  gh.commitAll(REPO_DIR, `fix: ${issue.title}`.slice(0, 72));

  const results = runProfile(REPO_DIR, profile);
  const validation = summarize(results);

  if (!validation.passed) {
    // Infrastructure failure is not the same as a bad fix. Conflating them
    // silently discards work that was probably fine, so the reason wording is
    // what notify.mjs classifies on.
    await sendAborted({
      issue, repo: REPO_NAME, stage: 'validation',
      reason: validation.inconclusive ? 'validation inconclusive' : `validation failed at ${validation.failed?.label}`,
      detail: validation.failed?.tail ?? '',
    });
    return { outcome: validation.inconclusive ? 'inconclusive' : 'no-safe-fix', issue, results };
  }

  const diff = gh.diffAgainst(REPO_DIR, BASE);
  const reviewOutput = reviewFix({ cwd: REPO_DIR, issue, stackTrace, diff });
  const approved = parseVerdict(reviewOutput);

  gh.push(REPO_DIR, branch);
  const stat = diffStat(REPO_DIR, BASE);
  const gate = evaluate(stat, sourceLineCount(REPO_DIR, BASE));

  const prUrl = gh.openDraftPr(REPO_DIR, {
    base: BASE,
    title: `fix: ${issue.title}`.slice(0, 72),
    body: prBody({ issue, rootCause, results, reviewOutput, approved, gate, stat }),
  });

  const merged = approved && gate.autoMergeAllowed;
  if (merged) gh.markReadyAndMerge(REPO_DIR, prUrl);

  await sendFixOpened({
    issue, repo: REPO_NAME, prUrl, rootCause, changedFiles: stat.files,
    validation: results, review: reviewOutput, merged,
    blockedBy: merged ? [] : [...(approved ? [] : ['reviewer rejected']), ...gate.reasons],
  });

  return { outcome: 'fixed', issue, prUrl, merged };
}

function prBody({ issue, rootCause, results, reviewOutput, approved, gate, stat }) {
  const checks = results.map((r) => `- ${r.ok ? 'PASS' : 'FAIL'} \`${r.cmd} ${r.args.join(' ')}\` (${Math.round(r.ms / 1000)}s)`).join('\n');
  const blockers = [...(approved ? [] : ['reviewer rejected']), ...gate.reasons];

  return `## Sentry issue
[${issue.shortId}](${issue.permalink}) — ${issue.title}
${issue.count} occurrences across ${issue.userCount} users, first seen ${issue.firstSeen}.

## Root cause
${rootCause || '_not stated_'}

## Changes
${stat.files.map((f) => `- \`${f}\``).join('\n')}

${stat.changedLines} lines changed.

## Validation
${checks}

## Independent review
The reviewer re-derived the root cause from the stack trace without seeing the author's reasoning, and was instructed to refute rather than confirm.

${reviewOutput.slice(0, 4000)}

## Auto-merge
${blockers.length ? `Blocked — needs a human:\n${blockers.map((r) => `- ${r}`).join('\n')}` : 'All gates passed; merged automatically.'}

---
Opened by the Sentry autofix pipeline. Draft until every gate passes.`;
}

// The heartbeat step reads this file to tell a healthy quiet run from a broken
// one, so it is written on EVERY path — including failure.
function writeSummary(summary) {
  if (!SUMMARY_FILE) return;
  try {
    writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('could not write summary file:', err);
  }
}

const slim = (r) => ({
  outcome: r.outcome,
  issue: { shortId: r.issue?.shortId, title: r.issue?.title, permalink: r.issue?.permalink },
  prUrl: r.prUrl ?? null,
  merged: Boolean(r.merged),
  reason: r.reason ?? null,
});

async function main() {
  if (!PROJECT) throw new Error('SENTRY_PROJECT is not set');
  if (!BASE) throw new Error('BASE_BRANCH is not set');

  const issues = ISSUE_ID ? [await getIssue(ISSUE_ID)] : await listNewIssues({ org: ORG, project: PROJECT });

  if (!issues.length) {
    writeSummary({ ok: true, project: PROJECT, polled: 0, outcomes: [] });
    console.log(`Polled ${ORG}/${PROJECT}; no new unresolved issues.`);
    return;
  }

  const outcomes = [];
  for (const issue of issues.slice(0, Number(env('MAX_ISSUES_PER_RUN', '1')))) {
    outcomes.push(await handleIssue(issue));
  }
  writeSummary({ ok: true, project: PROJECT, polled: issues.length, outcomes: outcomes.map(slim) });
  console.log(JSON.stringify(outcomes.map(slim), null, 2));
}

// guardRun mails a loud failure and rethrows, so an expired token can never exit
// quietly looking like a quiet week in production.
guardRun({ repo: REPO_NAME, stage: 'triage' }, main).catch((err) => {
  writeSummary({ ok: false, project: PROJECT, polled: 0, outcomes: [], error: String(err?.message || err) });
  console.error(err);
  process.exit(1);
});
