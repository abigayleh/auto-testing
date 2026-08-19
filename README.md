# sentry-autofix

Polls Sentry for new production errors, has Claude Code propose a minimal fix and a
second, adversarial Claude Code pass try to refute it, runs the repo's own tests,
and opens a **Draft PR**. Merges automatically only when every gate passes.

Serves four repos: `fork-yeah`, `fork-yeah-mobile`, `whats-the-plan-fe`, `whats-the-plan-be`.

## How it runs

One shared reusable workflow lives here; each app repo has a ~15-line caller. The
job executes **inside the app repo**, under that repo's own `GITHUB_TOKEN` — so no
long-lived token with write access across every repo ever has to exist.

The trigger is a scheduled **poll** of the Sentry API, not a webhook. Sentry cannot
call GitHub's `repository_dispatch` directly, and a relay would mean a public
endpoint plus signature handling for no benefit on a pipeline whose output a human
reads later anyway.

## Pipeline

| Stage | What happens | Abort condition |
|---|---|---|
| Poll | New unresolved issues for the project | API error → loud failure email |
| Dedup | Branch `autofix/sentry-<shortId>` or any PR already exists | Skip silently |
| Triage | Stack trace must resolve to real `file:line` | Minified frames → abort |
| Fix | Claude Code, minimal change + regression test | Root cause unclear → abort |
| Validate | The repo's own scripts | Fail → abort; timeout → **inconclusive** |
| Review | Second Claude Code pass, told to refute | Reject → PR stays draft |
| Gate | Size, file count, protected paths | Any hit → PR stays draft |
| Ship | Draft PR always; merge only if review **and** gates pass | — |

### Three outcomes, never two

`fixed` · `inconclusive` · `no-safe-fix`.

**Inconclusive is infrastructure, not a verdict on the fix.** A validation timeout
or an emulator that failed to start is not evidence the change was wrong, and
reporting it as "no fix possible" silently discards work that was probably fine.

### Silence is never health

A scheduled run that finds nothing still emails a heartbeat. An expired token, a
Sentry 401, or source maps that stop resolving produce a loud failure — never a
quiet no-op. The realistic failure of a pipeline like this is not a bad PR (review
catches that); it is going quiet for three weeks while everyone reads the silence
as "no production errors."

## Validation is per-repo, discovered not assumed

`buildProfile()` reads the app repo's `package.json` and runs only what is actually
defined. A missing `lint` is a **skip**, not a failure — `whats-the-plan-be` has no
lint script and `fork-yeah`'s `lint` is a dead `next lint` that Next 16 removed.
Detected today:

| Repo | Runs | Skipped |
|---|---|---|
| `fork-yeah` | `npm test`, `test:rules`, `build` | `lint` (broken), `typecheck` |
| `fork-yeah-mobile` | `test:run` | everything else |
| `whats-the-plan-fe` | `test:run`, `lint`, `build` | `typecheck` (JS only) |
| `whats-the-plan-be` | `prisma generate`, `test:run` | `lint`, `typecheck` |

`prisma generate` is added automatically when a schema exists — the backend's suite
constructs `PrismaClient` at module load and dies at import without it.

## Auto-merge gates

All must hold, or the PR stays a draft:

- validation green
- the adversarial reviewer returns `VERDICT: APPROVE` (absent or ambiguous → reject)
- ≤ 50 source lines and ≤ 3 source files changed — **test files are exempt**, so a
  thorough regression test is never penalised
- nothing touched under auth, `firestore.rules`, `.github/`, `package.json`,
  prisma schema/migrations, `.env`, or deploy config

## The reviewer never sees the author's reasoning

It gets the stack trace and the diff, re-derives the root cause itself, and is told
to refute rather than confirm and to default to rejection under doubt. A reviewer
handed the fixer's explanation tends to inherit the fixer's blind spot — which is
the specific risk when both are the same model.

## Configuration

Secrets: `SENTRY_AUTH_TOKEN` (read-scoped), `CLAUDE_CODE_OAUTH_TOKEN` (from
`claude setup-token` — bills subscription quota, not API credits), `RESEND_API_KEY`.
Never committed; supplied as repository secrets.

Env: `SENTRY_ORG` (default `whatstheplaninc`), `SENTRY_PROJECT`, `BASE_BRANCH`,
`APP_REPO_DIR`, optional `SENTRY_ISSUE_ID` for a manual run, `MAX_ISSUES_PER_RUN`.

Base branches genuinely differ — `fork-yeah` is `main`, the other three are
`master` — so it is always passed in, never assumed.

## Tests

```
npm test
```

Covers the gate logic, verdict parsing, stack-frame resolvability, and profile
detection. The Sentry and GitHub calls are not covered — they need live
credentials, and nothing here has yet run end to end.
