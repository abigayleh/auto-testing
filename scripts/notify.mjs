// Ops notifications for the Sentry autofix pipeline. Plain text over Resend's REST API.
// Every send returns {sent, reason} and never throws: silence must never look like health.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RESEND_URL = 'https://api.resend.com/emails';
const RULE = '='.repeat(64);

// Infrastructure noise => the run is inconclusive, not a rejected fix.
const INFRA = /timeout|timed[ -]?out|killed|sigkill|sigterm|emulator|econn|etimedout|enospc|out of memory|heap|oom|startup fail|could not start|crashed/i;
// Credentials / platform breakage => the whole pipeline is down and must shout.
const LOUD = /\b40[13]\b|\b5\d\d\b|unauthor|forbidden|expired|invalid[ -](api[ -])?(key|token)|bad credentials|source ?maps?|rate limit/i;

const BANNER = {
  inconclusive: 'INCONCLUSIVE - validation could not be trusted (infrastructure problem)',
  'no-safe-fix': 'NO SAFE FIX - root cause unclear, or the fix could not be proven correct',
  failure: 'PIPELINE FAILURE - the autofix run did not complete',
  heartbeat: 'ALL QUIET - the pipeline ran and found nothing to fix',
};

const SUBJECT_TAG = {
  fixed: 'FIXED',
  inconclusive: 'INCONCLUSIVE (validation not trusted)',
  'no-safe-fix': 'NO SAFE FIX',
  failure: 'PIPELINE FAILURE - autofix is not running',
};

const FOOTER = 'sentry-autofix - you get this mail on every run, including quiet ones.';

export function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

const clip = (s, n = 2000) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n...[truncated]` : t;
};

function issueLabel(issue) {
  if (!issue) return 'unknown issue';
  const id = issue.shortId || issue.id || '';
  const title = issue.title || issue.culprit || issue.metadata?.value || 'unknown issue';
  return clip(id ? `${id} ${title}` : title, 120);
}

function summarize(v, okWord, failWord) {
  if (v == null) return 'not reported';
  if (typeof v === 'string') return clip(v, 300);
  const state = v.ok ?? v.passed ?? v.approved;
  const word = state === true ? okWord : state === false ? failWord : 'not reported';
  const note = v.summary || v.reason || v.detail;
  return note ? `${word} - ${clip(note, 300)}` : word;
}

// Always names something: an unexplained un-merged PR is itself the finding.
function mergeBlocker(p) {
  if (p.blockedBy) return String(p.blockedBy);
  const v = p.validation;
  const r = p.review;
  if (v && (v.ok ?? v.passed) === false) return `validation gate - ${v.summary || v.reason || 'validation did not pass'}`;
  if (r && (r.approved ?? r.ok) === false) return `review gate - ${r.reason || r.summary || 'reviewer did not approve'}`;
  if (!p.prUrl) return 'fix stage reported no PR URL';
  return 'auto-merge gate - no reason reported (check gate config / branch protection)';
}

export function classifyAbort({ stage, reason, detail, kind } = {}) {
  if (kind) return kind;
  const text = `${stage || ''} ${reason || ''} ${detail || ''}`;
  if (LOUD.test(text)) return 'failure';
  if (INFRA.test(text)) return 'inconclusive';
  return 'no-safe-fix';
}

export function renderSubject(kind, payload = {}) {
  const repo = payload.repo || 'unknown repo';
  if (kind === 'heartbeat') {
    const n = payload.issuesFound ?? 0;
    return n > 0 ? `[autofix] ${repo}: run OK - ${n} issues handled` : `[autofix] ${repo}: all quiet - 0 new issues`;
  }
  const tag = SUBJECT_TAG[kind] || `UNRECOGNISED RESULT (${kind})`;
  if (kind === 'failure') return `[autofix] ${repo}: ${tag}`;
  if (kind === 'fixed') {
    return `[autofix] ${repo}: FIXED ${payload.merged ? '+ AUTO-MERGED' : '- awaiting review'} - ${issueLabel(payload.issue)}`;
  }
  return `[autofix] ${repo}: ${tag} - ${issueLabel(payload.issue)}`;
}

export function renderBody(kind, payload = {}) {
  const { issue, repo = 'unknown repo' } = payload;
  const banner = kind === 'fixed'
    ? (payload.merged ? 'FIXED - PR AUTO-MERGED' : 'FIXED - PR OPEN, WAITING FOR HUMAN REVIEW')
    : kind === 'heartbeat' && (payload.issuesFound ?? 0) > 0
      ? 'RUN OK - issues were handled, each mailed separately'
      : BANNER[kind] || `UNRECOGNISED RESULT (${kind}) - treat this as a pipeline bug`;

  const head = [RULE, banner, RULE, `Repo:  ${repo}`];
  if (issue) head.push(`Issue: ${issueLabel(issue)}`, `Link:  ${issue.permalink || issue.url || '(no link)'}`);
  if (payload.runUrl) head.push(`Run:   ${payload.runUrl}`);
  return [...head, '', ...bodyLines(kind, payload), '', FOOTER].join('\n');
}

function bodyLines(kind, p) {
  if (kind === 'fixed') {
    const files = (p.changedFiles || []).map((f) => (typeof f === 'string' ? f : f.path || f.filename || String(f)));
    return [
      `PR:            ${p.prUrl || '(none reported)'}`,
      `Root cause:    ${clip(p.rootCause, 800) || 'not reported'}`,
      `Changed files: ${files.length ? files.join(', ') : 'none reported'}`,
      `Validation:    ${summarize(p.validation, 'passed', 'FAILED')}`,
      `Review:        ${summarize(p.review, 'approved', 'NOT APPROVED')}`,
      '',
      p.merged
        ? 'MERGE: auto-merged. Nothing to do unless the fix looks wrong.'
        : `MERGE: NOT merged.\nBLOCKED BY: ${mergeBlocker(p)}\nNext step: review the PR and merge it by hand, or fix the gate.`,
    ];
  }
  if (kind === 'inconclusive') {
    return [
      `Stage:  ${p.stage || 'validation'}`,
      `Reason: ${clip(p.reason) || 'not reported'}`,
      `Detail: ${clip(p.detail) || '(none)'}`,
      '',
      'Validation was inconclusive: the run could not produce a trustworthy verdict,',
      'so nothing was concluded about the fix itself. This is an infrastructure',
      'problem (timeout, killed process, emulator would not start), NOT a rejected fix.',
      'Do not read this as the pipeline giving up on the issue - re-run it once the',
      'infrastructure is healthy.',
    ];
  }
  if (kind === 'no-safe-fix') {
    return [
      `Stage:  ${p.stage || 'unknown'}`,
      `Reason: ${clip(p.reason) || 'not reported'}`,
      `Detail: ${clip(p.detail) || '(none)'}`,
      '',
      'The pipeline ran correctly and decided against opening a PR: the root cause was',
      'unclear or the candidate fix could not be shown to be correct. A human needs to',
      'look at this issue.',
    ];
  }
  if (kind === 'failure') {
    return [
      `Stage:  ${p.stage || 'unknown'}`,
      `Reason: ${clip(p.reason) || 'not reported'}`,
      `Detail: ${clip(p.detail) || '(none)'}`,
      '',
      'THIS IS NOT AN ALL-QUIET SIGNAL. Autofix coverage for this repo is DOWN until',
      'someone fixes it - production errors may be piling up unreported.',
      'Usual causes: expired Sentry token, API 401/403, unresolvable source maps.',
    ];
  }
  if (kind === 'heartbeat') {
    return [
      `New issues found: ${p.issuesFound ?? 0}`,
      `Last run:         ${p.lastRunOk === false ? 'FAILED' : 'OK'}`,
      `Detail:           ${clip(p.detail) || '(none)'}`,
      '',
      (p.issuesFound ?? 0) > 0
        ? 'Roll-up only - the per-issue mails carry the detail. This mail exists so that\nsilence is never mistaken for health: if these stop arriving, the pipeline is broken.'
        : 'Nothing needed fixing. This mail exists so that silence is never mistaken for\nhealth: if these stop arriving, the pipeline itself is broken.',
    ];
  }
  return [`Payload: ${clip(JSON.stringify(p, null, 2))}`];
}

// A mail we could not send still has to be visible, so it goes to stderr in full.
function notSent(reason, subject, text) {
  console.error(`[notify] EMAIL NOT SENT (${reason})\n${subject}\n${text}`);
  return { sent: false, reason, subject };
}

export async function sendEmail({ subject, text, to } = {}, opts = {}) {
  const key = process.env.RESEND_API_KEY;
  const recipient = to || process.env.ADMIN_NOTIFICATION_EMAIL;
  const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  if (!key) return notSent('RESEND_API_KEY is not set', subject, text);
  if (!recipient) return notSent('ADMIN_NOTIFICATION_EMAIL is not set', subject, text);

  const doFetch = opts.fetch || globalThis.fetch;
  try {
    const res = await doFetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        text,
        html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return notSent(`Resend responded ${res.status} ${clip(detail, 300)}`, subject, text);
    }
    return { sent: true, subject, to: recipient };
  } catch (err) {
    return notSent(`Resend request failed: ${err?.message || err}`, subject, text);
  }
}

async function send(kind, payload, opts) {
  const subject = renderSubject(kind, payload);
  const text = renderBody(kind, payload);
  const result = await sendEmail({ subject, text, to: opts.to || payload.to }, opts);
  return { ...result, kind, subject };
}

export const sendFixOpened = (payload = {}, opts = {}) => send('fixed', payload, opts);
export const sendAborted = (payload = {}, opts = {}) => send(classifyAbort(payload), payload, opts);
export const sendHeartbeat = (payload = {}, opts = {}) =>
  send(payload.lastRunOk === false ? 'failure' : 'heartbeat', payload, opts);

// Wrap a run so a crash mails loudly instead of exiting quietly; the error still propagates.
export async function guardRun({ repo, stage = 'triage' }, fn) {
  try {
    return await fn();
  } catch (err) {
    await sendAborted({
      repo,
      stage,
      kind: 'failure',
      reason: `Unhandled error during ${stage}`,
      detail: err?.stack || String(err),
    });
    throw err;
  }
}

// ---- CLI entrypoint: `node scripts/notify.mjs` from the workflow's always() step ----

function readSummary(path) {
  if (!path) return { error: 'AUTOFIX_SUMMARY_FILE was not set' };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object') return { error: `${path} did not contain a JSON object` };
    return { data };
  } catch (err) {
    return { error: `could not read ${path}: ${err?.message || err}` };
  }
}

function rollUp(outcomes) {
  const counts = {};
  for (const o of outcomes) {
    const k = o?.outcome || 'unknown';
    counts[k] = (counts[k] || 0) + 1;
  }
  const tally = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing handled';
  const prs = outcomes.map((o) => o?.prUrl).filter(Boolean);
  return prs.length ? `${tally} | PRs: ${prs.join(', ')}` : tally;
}

// Decides which mail a finished workflow run deserves. Anything not provably
// healthy is a failure: an empty status or an unreadable summary is never all-quiet.
export function classifyRun(env = {}, summary = {}) {
  const status = String(env.AUTOFIX_STATUS ?? '').trim();
  if (status === '') {
    return { kind: 'failure', reason: 'AUTOFIX_STATUS was empty - an earlier workflow step (checkout, setup, install) most likely died before autofix ran' };
  }
  if (status !== 'success') {
    return { kind: 'failure', reason: `the autofix job reported status "${status}"` };
  }
  if (summary.error) {
    return { kind: 'failure', reason: `run reported success but its summary is unusable: ${summary.error}. A run that cannot describe itself is NOT an all-quiet run` };
  }
  const data = summary.data || {};
  if (data.ok === false) {
    return { kind: 'failure', reason: `summary reports ok:false - ${data.reason || data.error || 'no reason given'}` };
  }
  const outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
  return { kind: 'heartbeat', outcomes, data };
}

export async function runCli(env = process.env, opts = {}) {
  const repo = env.APP_REPO || env.SENTRY_PROJECT || 'unknown repo';
  const summary = readSummary(env.AUTOFIX_SUMMARY_FILE);
  const verdict = classifyRun(env, summary);
  const mode = env.SENTRY_ISSUE_ID ? `manual run for issue ${env.SENTRY_ISSUE_ID}` : 'scheduled poll';
  const project = summary.data?.project || env.SENTRY_PROJECT || 'unknown project';

  let result;
  if (verdict.kind === 'failure') {
    result = await sendAborted({
      repo,
      stage: 'triage',
      kind: 'failure',
      runUrl: env.RUN_URL,
      reason: verdict.reason,
      detail: [`Mode: ${mode}`, `Project: ${project}`, `AUTOFIX_STATUS: "${env.AUTOFIX_STATUS ?? ''}"`, `Summary file: ${env.AUTOFIX_SUMMARY_FILE || '(unset)'}`].join('\n'),
    }, opts);
  } else {
    const polled = verdict.data.polled ?? verdict.outcomes.length;
    result = await sendHeartbeat({
      repo,
      issuesFound: verdict.outcomes.length,
      lastRunOk: true,
      runUrl: env.RUN_URL,
      detail: [`Mode: ${mode}`, `Project: ${project}`, `Issues polled: ${polled}`, `Outcomes: ${rollUp(verdict.outcomes)}`].join('\n'),
    }, opts);
  }

  // Red build on a failed run, and also when we could not mail at all - an
  // unsent notification is the silent failure this whole module exists to stop.
  const exitCode = verdict.kind === 'failure' || !result.sent ? 1 : 0;
  if (!result.sent) console.error(`[notify] job marked failed because the notification could not be sent: ${result.reason}`);
  return { ...result, exitCode };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode } = await runCli();
  process.exitCode = exitCode;
}
