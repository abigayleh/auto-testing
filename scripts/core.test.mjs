import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, MAX_CHANGED_LINES } from './gates.mjs';
import { parseVerdict, parseSection, wasAborted } from './claude.mjs';
import { resolvableFrames } from './sentry.mjs';
import { buildProfile } from './validate.mjs';

test('gates: a small, ordinary fix is auto-mergeable', () => {
  const g = evaluate({ files: ['app/lib/foo.ts'], changedLines: 12 }, 12);
  assert.equal(g.autoMergeAllowed, true);
  assert.deepEqual(g.reasons, []);
});

test('gates: security-sensitive paths always need a human', () => {
  for (const file of ['firestore.rules', '.github/workflows/ci.yml', 'package.json', 'app/lib/requireUser.ts', '.env.local', 'prisma/schema.prisma']) {
    const g = evaluate({ files: [file], changedLines: 2 }, 2);
    assert.equal(g.autoMergeAllowed, false, `${file} should block auto-merge`);
  }
});

test('gates: a large diff blocks auto-merge', () => {
  const g = evaluate({ files: ['a.ts'], changedLines: 500 }, 500);
  assert.equal(g.autoMergeAllowed, false);
  assert.match(g.reasons.join(' '), new RegExp(String(MAX_CHANGED_LINES)));
});

test('gates: test files do not count toward the size cap', () => {
  // A thorough regression test is a good sign; capping it would push the fixer
  // toward writing less of one.
  const g = evaluate({ files: ['app/lib/foo.ts', 'tests/foo.test.ts'], changedLines: 400 }, 10);
  assert.equal(g.autoMergeAllowed, true);
});

test('gates: an empty diff is never mergeable', () => {
  const g = evaluate({ files: [], changedLines: 0 }, 0);
  assert.equal(g.autoMergeAllowed, false);
  assert.match(g.reasons.join(' '), /no changes/);
});

test('review verdict: approve only on an explicit APPROVE', () => {
  assert.equal(parseVerdict('VERDICT: APPROVE\nLooks right.'), true);
  assert.equal(parseVerdict('VERDICT: REJECT\nSuppresses the symptom.'), false);
  assert.equal(parseVerdict('I think it is probably fine'), false, 'absent verdict must not approve');
  assert.equal(parseVerdict(''), false, 'empty output must not approve');
});

test('review verdict: a rejection anywhere wins over an approval', () => {
  assert.equal(parseVerdict('VERDICT: APPROVE\n...\nVERDICT: REJECT'), false);
});

test('fixer output parsing', () => {
  const out = 'ROOT CAUSE: The query is denied by rules.\n\nCHANGES:\n- a.ts because x';
  assert.match(parseSection(out, 'ROOT CAUSE'), /denied by rules/);
  assert.match(parseSection(out, 'CHANGES'), /a\.ts/);
  assert.equal(wasAborted(out), false);
  assert.equal(wasAborted('ABORTED: minified frames only'), true);
});

test('stack frames: minified and vendor frames are not resolvable', () => {
  const frames = [
    { inApp: true, lineNo: 42, filename: 'app/lib/foo.ts' },
    { inApp: true, lineNo: 1, filename: 'https://cdn.example.com/bundle.js' },
    { inApp: true, lineNo: 1, filename: 'dist/app.min.js' },
    { inApp: false, lineNo: 9, filename: 'node_modules/react/index.js' },
    { inApp: true, lineNo: null, filename: 'app/lib/bar.ts' },
  ];
  assert.deepEqual(resolvableFrames(frames).map((f) => f.filename), ['app/lib/foo.ts']);
});

test('validation profile: a missing script is skipped, never a failure', () => {
  const p = buildProfile('/nonexistent-repo');
  assert.deepEqual(p.steps, []);
});
