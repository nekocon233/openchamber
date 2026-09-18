/**
 * Marks an upgrade as belonging to a forwarded hostname.
 *
 * Node calls every `upgrade` listener for every upgrade; there is no way to
 * stop the event once one of them has taken it. The other listeners on this
 * server each recognise their own path, and a forwarded dev server owns *all*
 * paths on its hostname — so a hot-reload socket at, say, `/api/event` would be
 * answered by OpenChamber's event stream instead of being carried to the dev
 * server. That failure would look like HMR silently not reconnecting, which is
 * a bad thing to debug.
 *
 * This module is deliberately tiny and dependency-free so the listeners that
 * must check it do not take on the rest of the port-forward runtime.
 */
const CLAIMED = Symbol.for('openchamber.portForward.upgradeClaimed');

export const claimUpgrade = (req) => {
  req[CLAIMED] = true;
};

export const isUpgradeClaimed = (req) => req?.[CLAIMED] === true;
