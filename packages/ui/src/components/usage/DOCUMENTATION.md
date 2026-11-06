# Shared quota account presentation

## Ownership

This module shapes quota groups for work status and renders Magpie accounts
for Usage Settings, desktop/mobile work status, and the VS Code quota menu.
`useQuotaStore` owns requests and runtime-scoped state. The quota runtime owns
external response parsing and source identity.

## Invariants

- Magpie preserves every reported account and window. Each account retains its
  own vendor error; whole-request failure retains the previous runtime sample.
- Magpie always displays remaining allowance. Money, credits, unlimited and
  unknown values retain their meaning without a guessed percentage.
- Shared balances display their source account rather than a duplicate amount.
- Account/provider/plan labels remain available in compact rows. Long labels
  truncate with their complete text in a title. Compact windows retain resets.
- The collapsed usage headline never selects a Magpie account: the gateway
  chooses that account only when it routes a request.

## Decisions

### Why one account component serves all readouts

Settings and compact readouts must agree about remaining values, account
identity and partial errors. `MagpieUsage` shares that hierarchy while using
the existing Settings and work-status row primitives for their respective sizes.
