# Canonical repository bootstrap

This document records the approved Phase 0 transition. It is a decision and
verification contract; it does not create a GitHub repository, change a remote,
apply a ruleset, or deploy a Worker.

## Repository roles and transition

The private repository `Betalgeuse/otl1-ops` is the canonical source for
operations, deployment, and the complete trusted history. It starts from a new
root commit made from the current operating checkout after secrets and
operational IDs are removed. Private history is not imported. The public
repository `Betalgeuse/otl1` remains a verified release mirror and is not the
canonical deployment source.

The local remote mapping is fixed:

| Local remote | Repository | Role |
| --- | --- | --- |
| `ops` | `Betalgeuse/otl1-ops` | canonical private source |
| `public` | `Betalgeuse/otl1` | sanitized release mirror |

Each remote must have exactly one fetch URL and exactly one push URL, and both
URLs must resolve to that row's expected GitHub repository. An expected URL
alongside an additional fetch URL or an unrelated push URL is noncanonical.

Git stores placeholders only. Production secrets and operational values live in
the GitHub `production` Environment or Cloudflare secrets and variables. No
credential, Slack identifier, member text, or raw attachment belongs in GitHub,
Git history, logs, or public exports.

## Protected `main` ruleset

The private repository targets exactly `refs/heads/main` with enforcement
`active`. Direct pushes, force pushes, branch deletion, and non-fast-forward
updates are denied. The bypass actor list is empty and repository
administrators are included in the ruleset. Dismissed stale reviews are not
accepted, and the latest push requires approval.

GitHub Actions is disabled for this project because its cost is not authorized.
No `.github/workflows` checks are part of the canonical path. The required
checks come from isolated GenQuant CI GitHub Apps and their signed receipts.
The ruleset requires one review on the current head and these four status checks
in the exact names below. Each check is produced externally by an isolated
GenQuant CI GitHub App and is accepted only with a signed GenQuant receipt.

1. `CI / check`
2. `CI / public-export-scan`
3. `Policy / risk`
4. `Evidence / receipt`

Required checks are bound to their expected GitHub App IDs in the ruleset
readback. The IDs are deliberately absent from this public-safe document and
from the local checker output. The only allowed merge method is squash, and
merge queue is enabled. All four GitHub Apps are subject to the ruleset and
receive no bypass permission.

The local checker accepts a ruleset metadata file only when it contains the
expected values, numeric source App IDs, and `genquant-signed` receipt marker for
each check. The metadata must set both `actionsEnabled` and
`usesGitHubActions` to `false`, and its ruleset must identify
`genquant-ci-github-apps` with `signedReceipts: true`. It treats
`readbackVerified: true` as an assertion that an authorized ruleset API
readback supplied the file. Without that explicit readback, the result remains
`canonical: false`; expected policy text alone must not look like a successful
bootstrap.

Example metadata shape (the App ID values are local input and are never
printed):

```json
{
  "branch": "main",
  "actionsEnabled": false,
  "usesGitHubActions": false,
  "ruleset": {
    "target": "refs/heads/main",
    "enforcement": "active",
    "requiredChecks": [
      { "name": "CI / check", "appId": "123", "receipt": "genquant-signed" },
      { "name": "CI / public-export-scan", "appId": "123", "receipt": "genquant-signed" },
      { "name": "Policy / risk", "appId": "123", "receipt": "genquant-signed" },
      { "name": "Evidence / receipt", "appId": "123", "receipt": "genquant-signed" }
    ],
    "checkSource": "genquant-ci-github-apps",
    "signedReceipts": true,
    "requiredReviewCount": 1,
    "mergeQueue": true,
    "allowedMergeMethods": ["squash"],
    "bypassActors": [],
    "allowForcePush": false,
    "allowDeletion": false,
    "dismissStaleReviews": true,
    "requireLastPushApproval": true,
    "readbackVerified": true
  }
}
```

## Read-only local check

Run this from the checkout under inspection:

```sh
node scripts/check-canonical-repo.mjs
```

The command reads `git rev-parse`, the full commit object resolved by
`HEAD^{commit}`, symbolic branch state, porcelain status, remote URLs, and
`git worktree list`. It does not run `git fetch`, create a repository, alter
remotes, write Git config, change a branch, or deploy. A
metadata file can be supplied with `--metadata PATH`, or with the
`CANONICAL_REPO_METADATA` environment variable. `--repo PATH` inspects another
local checkout without changing it.

The output is one JSON object with `canonical`, remote match booleans and URL
cardinalities, worktree/branch state bound to the resolved full `head_sha`,
stable expected names, `missing_requirements`, and code-only errors. An unborn
repository, malformed `HEAD`, or any state where `HEAD^{commit}` does not
resolve to a full SHA reports `head_resolved: false`, adds `head_commit` to
`missing_requirements`, and cannot be canonical. A detached `HEAD` reports its
resolved SHA but still fails the required `main` branch check. The `ci` object always states `check_source` as
`genquant-ci-github-apps` and reports GitHub Actions as disabled unless input
metadata explicitly claims otherwise. Remote URLs are reduced to GitHub
repository paths; metadata contents, App IDs, filesystem paths, credentials,
and arbitrary Git error text are never emitted. The one emitted commit value is
the exact locally resolved `head_sha` that binds the reported source state.
Exit status is 0 only when that commit resolves, local remotes, `main`, a clean
registered worktree, valid metadata, and verified ruleset readback all pass.
The current public-only/feature-branch checkout therefore must report JSON
`canonical: false` and missing requirements.

This is a local preflight. It cannot replace the GitHub ruleset API readback or
deployment evidence.

## Deploy and public mirror provenance

Canonical release deployment must use the merge queue result on canonical
private `main`, never an arbitrary PR head. It requires the verified `ops`
remote, a clean `main`, active ruleset API readback, current-head review and the
four receipt-bound GenQuant checks above. Every canonical deployment receipt
stores these exact fields:

- `canonical_sha`: merged commit from `Betalgeuse/otl1-ops` canonical `main`.
- `public_mirror_sha`: sanitized mirror commit, when a public release mirror is
  published.
- `worker_version`: Cloudflare Worker version returned by the deploy operation.
- `migration_versions`: migrations applied by that deployment.
- `deployed_at`: deployment timestamp.

The public mirror commit carries `Canonical-SHA:` as a trailer containing the
private canonical SHA. `docs/DEVELOPMENT.md` must state that deployment and
public export use these sources: deployment uses the canonical private merge
SHA, while export produces the sanitized public mirror from that same release
input. A release is not complete until the ruleset API readback and the
deploy/public provenance receipt are both available.

### Existing-Worker pre-release QA exception

Canonical release authority is separate from an explicitly authorized,
reversible pre-release QA rollout to the already-existing Worker. This exception
exists only to observe a narrowly named live Slack behavior before release. It
does not make a noncanonical checkout canonical or release-ready.

Such a QA rollout must satisfy all of these conditions:

- explicit authorization names the live Slack scenario and existing Worker;
- source is an exact full SHA in a clean checkout, and the receipt binds that SHA
  to the uploaded Worker version and deployment;
- the previous Worker version is retained as the code rollback target;
- database changes run in declared order while maintenance blocks Slack ingress,
  with their forward-only compatibility and final maintenance state recorded;
- read-only health, binding names, migration versions, scheduled-trigger
  preservation, separate clock-readiness evidence and cleanup limits are
  recorded without secrets, member text or private objects;
- no Git push, merge, public mirror publication, release announcement, provider
  execution or canonical provenance claim is made.

The noncanonical pre-release lineage reached a passing Chrome Slack Web QA at
exact SHA `4f05ae75f93ad5f7bca6ebfcb7c3613fbe8dae20`. Health proves only
Worker liveness, required configuration and static capabilities; it does not
arm or inspect the clock. Sanitized Durable Object inspect/admin evidence, a
deployment receipt or signed activity proves clock readiness. The QA lineage
still does not supply an `ops/main` merge, ruleset readback, canonical receipt
or release authority. That missing canonical private authority is the sole
reason v0.0.54 remains pre-release.

Any canonical deployment or release still requires the private `ops/main`
authority and ruleset evidence described above. The QA exception cannot be used
to bypass, backfill or retroactively assert that lineage.

## Deferred external actions

Creating `Betalgeuse/otl1-ops`, configuring GitHub Apps, applying branch rules,
publishing a mirror, and performing a canonical deployment are separate
authorized operations. T0 only documents their contract and provides the
read-only local inspection command. The completed pre-release QA rollout above
does not complete any of those deferred actions.
