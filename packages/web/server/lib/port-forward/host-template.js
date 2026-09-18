/**
 * Where a forwarded dev server lives.
 *
 * Every forwarded port gets an origin of its own, because that is the only
 * arrangement where the page loads unchanged: absolute URLs resolve, cookies
 * scope correctly, and HMR sockets connect. Serving it under a path prefix on
 * the OpenChamber origin means rewriting the page for each framework, which is
 * what the old proxy did and why it was removed — see
 * `../dev-tunnel/DOCUMENTATION.md`.
 *
 * OpenChamber cannot invent those origins. Which hostnames resolve, which of
 * them a tunnel routes back here, and which a certificate covers are all
 * decided outside this process. So the user supplies one template and this
 * module does nothing but build hostnames from it and recognise them coming
 * back.
 */
import net from 'node:net';

const PORT_PLACEHOLDER = '{port}';
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The same bare-DNS rule the FRPC client enforces: no scheme, port, path,
 * wildcard, or trailing dot.
 *
 * Non-ASCII is rejected rather than punycoded. The template is split around its
 * placeholder, so half of it is not a whole DNS label and cannot be encoded on
 * its own; requiring the already-encoded form keeps one spelling of every
 * hostname, which is what the cookie scope and the certificate both depend on.
 */
const assertBareDnsHostname = (hostname) => {
  if (
    !hostname
    || hostname.includes('://')
    || /[^a-z0-9.-]/.test(hostname)
    || hostname.endsWith('.')
    || hostname.length > MAX_HOSTNAME_LENGTH
  ) {
    throw new Error('The forward host template must be a bare ASCII DNS hostname without a scheme, port, path, wildcard, or trailing dot');
  }
  if (net.isIP(hostname) !== 0) {
    throw new Error('The forward host template must be a DNS hostname, not an IP address');
  }

  const labels = hostname.split('.');
  if (labels.length < 2) {
    throw new Error('The forward host template must be a fully qualified hostname');
  }
  if (labels.some((label) => (
    label.length === 0
    || label.length > MAX_LABEL_LENGTH
    || !LABEL_PATTERN.test(label)
  ))) {
    throw new Error('The forward host template must resolve to a valid DNS hostname');
  }
};

/**
 * Parses `oc--{port}.example.com` into the two halves matching splits on.
 *
 * A digit directly beside the placeholder is rejected rather than normalised:
 * with a template like `oc1{port}.example.com`, the host `oc15173.example.com`
 * reads as both port 5173 and port 15173. Picking either would route a page to
 * a port the user did not ask for, so the ambiguity is refused where it is
 * introduced.
 */
export const parseForwardHostTemplate = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) {
    throw new Error('A forward host template is required');
  }

  const placeholderAt = raw.indexOf(PORT_PLACEHOLDER);
  if (placeholderAt === -1) {
    throw new Error(`The forward host template must contain ${PORT_PLACEHOLDER}`);
  }
  if (raw.indexOf(PORT_PLACEHOLDER, placeholderAt + PORT_PLACEHOLDER.length) !== -1) {
    throw new Error(`The forward host template must contain ${PORT_PLACEHOLDER} exactly once`);
  }

  const prefix = raw.slice(0, placeholderAt);
  const suffix = raw.slice(placeholderAt + PORT_PLACEHOLDER.length);
  if (/\d$/.test(prefix) || /^\d/.test(suffix)) {
    throw new Error(`The forward host template must not put a digit directly beside ${PORT_PLACEHOLDER}`);
  }

  // Checked with a stand-in port so the placeholder is validated in the
  // position it will actually occupy, dots and label lengths included.
  assertBareDnsHostname(`${prefix}1${suffix}`);

  return { template: raw, prefix, suffix };
};

/** Normalises a template for storage, or returns null when it is unusable. */
export const normalizeForwardHostTemplate = (value) => {
  try {
    return parseForwardHostTemplate(value).template;
  } catch {
    return null;
  }
};

export const buildForwardHost = (parsed, port) => `${parsed.prefix}${port}${parsed.suffix}`;

/**
 * Strips the port a browser appends to `Host`. Only the name matters here: the
 * port in that header is the one the tunnel terminates on, not the dev server's.
 */
const hostnameOf = (hostHeader) => {
  const raw = String(hostHeader ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end === -1 ? '' : raw.slice(1, end);
  }
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(0, colon);
};

/**
 * The port a `Host` header names, or null when it names something else.
 *
 * Leading zeros are refused so one dev server has exactly one origin. Accepting
 * `05173` alongside `5173` would split the forward's cookie across two
 * hostnames, and the page would be asked to authenticate again the moment a
 * link moved it between them.
 */
export const matchForwardHost = (parsed, hostHeader) => {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return null;
  if (!hostname.startsWith(parsed.prefix) || !hostname.endsWith(parsed.suffix)) return null;
  if (hostname.length <= parsed.prefix.length + parsed.suffix.length) return null;

  const digits = hostname.slice(parsed.prefix.length, hostname.length - parsed.suffix.length);
  if (!/^[1-9]\d{0,4}$/.test(digits)) return null;

  const port = Number.parseInt(digits, 10);
  return port > 0 && port <= 65535 ? port : null;
};
