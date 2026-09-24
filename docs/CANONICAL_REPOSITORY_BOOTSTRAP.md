# Canonical repository and branch policy

`Betalgeuse/otl1` is the only repository for OT1L source. Its protected `main` branch is the canonical code history. There is no `otl1-ops` repository and no second private source history.

Production credentials, Slack identifiers, member content, database URLs, and deployment receipts stay outside Git. The committed tree must remain public-safe. Environment-specific deployment values are supplied from protected local or provider configuration and never by keeping a separate Git history.

## Branch rules

Every feature branch starts from the current `public/main` commit and returns through a pull request to `main`. A branch with no merge base with `main` is invalid and must not be used for review or deployment. Do not force-push unrelated history into `main`.

The repository settings enforce:

- GitHub Actions disabled;
- active ruleset targeting the default `main` branch;
- deletion and non-fast-forward updates blocked;
- linear history;
- pull request required and review threads resolved;
- squash as the only merge method;
- merged branches deleted automatically.

This is a single-maintainer repository, so GitHub required approvals remain zero. GitHub does not count approval by the person who pushed the change, and requiring one approval would deadlock the owner. The product's administrator gate remains explicit: automated work creates a Draft PR, and only the administrator may mark it ready and merge it. The agent never merges.

## Canonical check

`node scripts/check-canonical-repo.mjs --metadata PATH` verifies a clean registered `main` worktree, the single `public` remote, exact HEAD, Actions disabled, and an authorized ruleset API readback. The metadata file is an observation from GitHub, not authority by itself. Missing or unverified readback cannot report `canonical: true`.

## Deployment provenance

A production deployment starts only from the reviewed and merged `public/main` SHA. Its receipt records the exact main SHA, Worker version, migration versions, deployment time, and rollback target. Public-safe source and production configuration remain separate, but they no longer use unrelated Git histories.

Historical branches rooted outside current `main` are migration sources only. Their public-safe tree must be exported and committed on a fresh branch created from `main`; they are never merged directly.
