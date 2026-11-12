# Shared repository actions

## Ownership

The board's actions and replies also serve project, branch and linked PR
previews. Their callers own navigation; these controls own submission and
result feedback. Runtime APIs retain transport and provider authorization.

## Invariants

- PR-pane merges, approvals and requests for changes return after invoking the
  provider request. Merge confirmation still precedes dispatch. Comments keep
  their existing navigation.
- An in-flight merge, review or review-draft change locks its runtime, provider
  instance, credential account and target PR across detail unmounts, worktrees
  and binding revisions. Settling
  the action releases only its own lock. Other PRs remain available.
- Background feedback names the original repository and PR. Runtime-generation
  changes dismiss pending feedback and suppress old results without releasing
  a request that has not settled.
- Failure and partial success retain unposted text. Draft acknowledgement follows
  the successful receipt, independently of navigation. Pending-review retries
  retain the existing idempotency record and review-state refresh lock.

### Why action state outlives a detail

Immediate return unmounts the submitting controls while their requests are
still pending. A shared in-memory lock prevents duplicate submissions after
reopening, and runtime-bound feedback reports the result from the captured PR.
No completed action history is retained or persisted.
