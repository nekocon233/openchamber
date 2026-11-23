# Shared quota account presentation

## Ownership

This module shapes quota groups for work status and renders Magpie accounts
for Usage Settings, desktop/mobile work status, and the VS Code quota menu.
`useQuotaStore` owns requests and runtime-scoped state. The quota runtime owns
external response parsing and source identity.

## Invariants

- Magpie preserves every reported account and window. Each account retains its
  own vendor error; whole-request failure retains the previous runtime sample.
- Percentage and counted-limit windows follow `useQuotaStore.displayMode`
  (`usage` or `remaining`). Money, wallet balances, unlimited and unknown
  values retain their meaning without a guessed percentage.
- Shared balances display their source account rather than a duplicate amount.
- Account/provider/plan labels remain available in compact rows. Long labels
  truncate with their complete text in a title. Compact windows retain resets.
- The collapsed usage headline never selects a Magpie account: the gateway
  chooses that account only when it routes a request.

- Work Status shows the amount and reset on five-hour windows. The Magpie
  trend selector uses the reported duration, the recorded cycle or the raw
  window name to reserve pace labels and charts for other windows.
- Every signed difference from even pace has a label for a matching snapshot
  before its reset. Low balances keep their quota tone in either display mode.
- The plot follows time from left to right. Both series and sample readouts
  follow the selected quota display mode. Pace compares consumed quota with
  elapsed cycle time.

## Decisions

### Why Work Status puts quota trends in a floating panel

Hover opens an anchored chart that also accepts pointer travel into its sample
control. Tap and keyboard activation open the same chart. The quota rows hold
their position and the chart mounts only while its popup is active.

### Why one account component serves all readouts

Settings and compact readouts must agree about displayed values, account
identity and partial errors. `MagpieUsage` shares that hierarchy while using
the existing Settings and work-status row primitives for their respective sizes.
