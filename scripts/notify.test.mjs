import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyAbort, classifyRun, escapeHtml, renderBody, renderSubject, runCli,
  sendAborted, sendFixOpened, sendHeartbeat,
} from './notify.mjs';

const issue = { shortId: 'APP-7Q', title: 'TypeError: cannot read x of undefined', permalink: 'https://sentry.io/i/1' };
const base = { issue, repo: 'acme/web' };

// Runs fn with a patched env + silenced stderr, then restores both.
async function withEnv(vars, fn) {
  const saved = { ...process.env };
  const err = console.error;
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn(logs);
  } finally {
    process.env = saved;
    console.error = err;
  }
}

const stubFetch = (calls, res = { ok: true, status: 200 }) => (url, init) => {
  calls.push({ url, init });
  return Promise.resolve({ ...res, text: () => Promise.resolve('body') });
};

test('fixed: auto-merged says so', () => {
  const p = { ...base, prUrl: 'https://gh/pr/1', merged: true, rootCause: 'null guard missing' };
  assert.match(renderSubject('fixed', p), /AUTO-MERGED/);
  assert.match(renderBody('fixed', p), /auto-merged/i);
  assert.doesNotMatch(renderBody('fixed', p), /BLOCKED BY/);
});

test('fixed: unmerged names the blocking gate', () => {
  const p = { ...base, prUrl: 'https://gh/pr/1', merged: false, review: { approved: false, reason: 'needs human eyes' } };
  const body = renderBody('fixed', p);
  assert.match(renderSubject('fixed', p), /awaiting review/);
  assert.match(body, /BLOCKED BY: review gate - needs human eyes/);
});

test('fixed: unmerged with no reason still names a blocker', () => {
  const body = renderBody('fixed', { ...base, prUrl: 'https://gh/pr/1', merged: false });
  assert.match(body, /BLOCKED BY: .+/);
});

test('inconclusive never renders as no fix possible', () => {
  const p = { ...base, stage: 'validation', reason: 'emulator startup timed out', detail: 'exit 137' };
  const subject = renderSubject('inconclusive', p);
  const body = renderBody('inconclusive', p);
  assert.match(subject, /INCONCLUSIVE/);
  assert.match(body, /validation was inconclusive/i);
  assert.match(body, /infrastructure/i);
  for (const phrase of [/no fix possible/i, /no safe fix/i, /unfixable/i, /gave up/i]) {
    assert.doesNotMatch(subject, phrase);
    assert.doesNotMatch(body, phrase);
  }
});

test('no-safe-fix is distinct from inconclusive', () => {
  const p = { ...base, stage: 'triage', reason: 'root cause unclear' };
  assert.match(renderSubject('no-safe-fix', p), /NO SAFE FIX/);
  assert.doesNotMatch(renderBody('no-safe-fix', p), /inconclusive/i);
  assert.notEqual(renderSubject('no-safe-fix', p), renderSubject('inconclusive', p));
});

test('heartbeat states zero issues and why it exists', () => {
  const p = { repo: 'acme/web', issuesFound: 0, lastRunOk: true };
  assert.match(renderSubject('heartbeat', p), /all quiet - 0 new issues/);
  assert.match(renderBody('heartbeat', p), /silence is never mistaken for/i);
});

test('failure body is loud and not an all-quiet signal', () => {
  const body = renderBody('failure', { repo: 'acme/web', stage: 'triage', reason: 'Sentry API 401' });
  assert.match(body, /NOT AN ALL-QUIET SIGNAL/);
  assert.match(body, /expired Sentry token/);
});

test('classifyAbort: infra -> inconclusive, auth -> failure, else no-safe-fix', () => {
  assert.equal(classifyAbort({ stage: 'validation', reason: 'test run timed out' }), 'inconclusive');
  assert.equal(classifyAbort({ stage: 'validation', reason: 'process killed (SIGKILL)' }), 'inconclusive');
  assert.equal(classifyAbort({ stage: 'triage', reason: 'Sentry returned 401' }), 'failure');
  assert.equal(classifyAbort({ stage: 'triage', reason: 'source maps unresolvable' }), 'failure');
  assert.equal(classifyAbort({ stage: 'fix', reason: 'root cause unclear' }), 'no-safe-fix');
  assert.equal(classifyAbort({ stage: 'fix', reason: 'anything', kind: 'inconclusive' }), 'inconclusive');
});

test('sendAborted routes an inconclusive abort to the inconclusive email', async () => {
  const calls = [];
  const res = await withEnv(
    { RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev', RESEND_FROM_EMAIL: undefined },
    () => sendAborted({ ...base, stage: 'validation', reason: 'emulator timed out' }, { fetch: stubFetch(calls) }),
  );
  assert.equal(res.sent, true);
  assert.equal(res.kind, 'inconclusive');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(body.from, 'onboarding@resend.dev');
  assert.deepEqual(body.to, ['ops@acme.dev']);
  assert.doesNotMatch(body.text, /no fix possible/i);
});

test('heartbeat with lastRunOk false escalates to a failure email', async () => {
  const calls = [];
  const res = await withEnv({ RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' }, () =>
    sendHeartbeat({ repo: 'acme/web', issuesFound: 0, lastRunOk: false, detail: 'token expired' }, { fetch: stubFetch(calls) }),
  );
  assert.equal(res.kind, 'failure');
  assert.match(res.subject, /PIPELINE FAILURE/);
  assert.equal(calls.length, 1);
});

test('missing RESEND_API_KEY returns instead of throwing, and skips the network', async () => {
  const calls = [];
  const res = await withEnv(
    { RESEND_API_KEY: undefined, ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' },
    (logs) => sendFixOpened({ ...base, merged: true }, { fetch: stubFetch(calls) }).then((r) => {
      assert.match(logs.join('\n'), /EMAIL NOT SENT/);
      return r;
    }),
  );
  assert.equal(res.sent, false);
  assert.match(res.reason, /RESEND_API_KEY/);
  assert.equal(calls.length, 0);
});

test('missing ADMIN_NOTIFICATION_EMAIL returns instead of throwing', async () => {
  const res = await withEnv({ RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: undefined }, () =>
    sendHeartbeat({ repo: 'acme/web', issuesFound: 0 }),
  );
  assert.equal(res.sent, false);
  assert.match(res.reason, /ADMIN_NOTIFICATION_EMAIL/);
});

test('a Resend error and a network throw both return, never throw', async () => {
  const bad = await withEnv({ RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' }, () =>
    sendHeartbeat({ repo: 'acme/web', issuesFound: 0 }, { fetch: stubFetch([], { ok: false, status: 422 }) }),
  );
  assert.equal(bad.sent, false);
  assert.match(bad.reason, /422/);

  const boom = await withEnv({ RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' }, () =>
    sendHeartbeat({ repo: 'acme/web', issuesFound: 0 }, { fetch: () => Promise.reject(new Error('ENOTFOUND')) }),
  );
  assert.equal(boom.sent, false);
  assert.match(boom.reason, /ENOTFOUND/);
});

test('interpolated error text is escaped in the html part', async () => {
  const calls = [];
  await withEnv({ RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' }, () =>
    sendAborted({ ...base, stage: 'fix', reason: '<script>alert(1)</script>' }, { fetch: stubFetch(calls) }),
  );
  const body = JSON.parse(calls[0].init.body);
  assert.doesNotMatch(body.html, /<script>/);
  assert.match(body.html, /&lt;script&gt;/);
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

// ---- CLI entrypoint ----

const NOTIFY = fileURLToPath(new URL('./notify.mjs', import.meta.url));
const CI_ENV = { APP_REPO: 'acme/web', SENTRY_PROJECT: 'whats-for-dinner', RUN_URL: 'https://gh/run/9' };

function summaryFile(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'summary.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

// Runs the CLI with a stub fetch and a valid Resend env; returns {res, calls}.
async function cli(env) {
  const calls = [];
  const res = await withEnv({ RESEND_API_KEY: 'k', ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' }, () =>
    runCli(env, { fetch: stubFetch(calls) }),
  );
  return { res, calls, body: calls.length ? JSON.parse(calls[0].init.body) : null };
}

test('CLI: empty AUTOFIX_STATUS is a failure, never all-quiet', async (t) => {
  const path = summaryFile(t, { ok: true, outcomes: [] });
  const { res, body } = await cli({ ...CI_ENV, AUTOFIX_STATUS: '', AUTOFIX_SUMMARY_FILE: path });
  assert.equal(res.kind, 'failure');
  assert.equal(res.exitCode, 1);
  assert.match(res.subject, /PIPELINE FAILURE/);
  assert.match(body.text, /AUTOFIX_STATUS was empty/);
  assert.match(body.text, /earlier workflow step/);
  assert.doesNotMatch(res.subject, /all quiet/i);
});

test('CLI: absent, whitespace and unknown AUTOFIX_STATUS all fail', async (t) => {
  const path = summaryFile(t, { ok: true, outcomes: [] });
  for (const status of [undefined, '   ', 'failure', 'skipped', 'cancelled']) {
    const { res } = await cli({ ...CI_ENV, AUTOFIX_STATUS: status, AUTOFIX_SUMMARY_FILE: path });
    assert.equal(res.kind, 'failure', `status ${JSON.stringify(status)} should fail`);
    assert.equal(res.exitCode, 1);
  }
});

test('CLI: missing or unparseable summary is a failure', async (t) => {
  const missing = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: '/nope/summary.json' });
  assert.equal(missing.res.kind, 'failure');
  assert.equal(missing.res.exitCode, 1);
  assert.match(missing.body.text, /summary is unusable/);
  assert.match(missing.body.text, /NOT an all-quiet run/);

  const unset = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success' });
  assert.equal(unset.res.kind, 'failure');

  const garbage = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: summaryFile(t, '{not json') });
  assert.equal(garbage.res.kind, 'failure');
  assert.match(garbage.body.text, /could not read/);
});

test('CLI: summary with ok:false is a failure', async (t) => {
  const path = summaryFile(t, { ok: false, reason: 'Sentry token expired' });
  const { res, body } = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: path });
  assert.equal(res.kind, 'failure');
  assert.match(body.text, /Sentry token expired/);
});

test('CLI: zero-issue success sends the heartbeat and exits 0', async (t) => {
  const path = summaryFile(t, { ok: true, project: 'whats-for-dinner', polled: 3, outcomes: [] });
  const { res, body } = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: path });
  assert.equal(res.kind, 'heartbeat');
  assert.equal(res.exitCode, 0);
  assert.match(res.subject, /all quiet - 0 new issues/);
  assert.match(body.text, /Issues polled: 3/);
  assert.match(body.text, /scheduled poll/);
  assert.match(body.text, /https:\/\/gh\/run\/9/);
});

test('CLI: success with issues is a one-line roll-up, not a duplicate of the per-issue mail', async (t) => {
  const path = summaryFile(t, {
    ok: true, project: 'whats-for-dinner', polled: 2,
    outcomes: [
      { outcome: 'fixed', issue, prUrl: 'https://gh/pr/1', merged: true },
      { outcome: 'inconclusive', issue, reason: 'emulator timed out' },
    ],
  });
  const { res, body } = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: path, SENTRY_ISSUE_ID: 'APP-7Q' });
  assert.equal(res.kind, 'heartbeat');
  assert.equal(res.exitCode, 0);
  assert.match(res.subject, /run OK - 2 issues handled/);
  assert.match(body.text, /1 fixed, 1 inconclusive/);
  assert.match(body.text, /manual run for issue APP-7Q/);
  assert.doesNotMatch(body.text, /Root cause|BLOCKED BY/);
});

test('CLI: malformed outcomes and absent fields do not crash the notifier', async (t) => {
  const path = summaryFile(t, { ok: true, outcomes: [{}, null, { outcome: 'skipped' }] });
  const { res } = await cli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: path });
  assert.equal(res.kind, 'heartbeat');
  assert.match(res.subject, /3 issues handled/);
});

test('classifyRun treats only a provably healthy run as a heartbeat', () => {
  assert.equal(classifyRun({ AUTOFIX_STATUS: '' }, {}).kind, 'failure');
  assert.equal(classifyRun({}, {}).kind, 'failure');
  assert.equal(classifyRun({ AUTOFIX_STATUS: 'success' }, { error: 'gone' }).kind, 'failure');
  assert.equal(classifyRun({ AUTOFIX_STATUS: 'success' }, { data: { ok: true } }).kind, 'heartbeat');
});

test('CLI: an unsendable notification still turns the job red', async (t) => {
  const path = summaryFile(t, { ok: true, outcomes: [] });
  const res = await withEnv({ RESEND_API_KEY: undefined, ADMIN_NOTIFICATION_EMAIL: 'ops@acme.dev' }, () =>
    runCli({ ...CI_ENV, AUTOFIX_STATUS: 'success', AUTOFIX_SUMMARY_FILE: path }),
  );
  assert.equal(res.kind, 'heartbeat');
  assert.equal(res.sent, false);
  assert.equal(res.exitCode, 1);
});

const run = (args, env) =>
  new Promise((resolve) => {
    execFile(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, stdout, stderr }),
    );
  });

test('run as a script: it actually notifies and exits non-zero', async () => {
  const { code, stderr } = await run([NOTIFY], { AUTOFIX_STATUS: '', APP_REPO: 'acme/web' });
  assert.equal(code, 1);
  assert.match(stderr, /EMAIL NOT SENT/);
  assert.match(stderr, /PIPELINE FAILURE/);
});

test('imported as a module: no side effects, no mail', async () => {
  const { code, stdout, stderr } = await run(['--input-type=module', '-e', `await import(${JSON.stringify(NOTIFY)});`], { AUTOFIX_STATUS: '' });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), '');
  assert.equal(stderr.trim(), '');
});
