import net from 'node:net';
import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { isString, isNumber } from '../shared/object-guards.js';

const FRPC_TOKEN_MAX_LENGTH = 8192;

export interface FrpcEndpointInput {
  remotePort?: unknown;
  customDomain?: unknown;
  hostname?: unknown;
  publicUrl?: unknown;
  proxyType?: unknown;
}

export type FrpcNormalizedEndpoint =
  | {
    proxyType: 'tcp';
    remotePort: number;
    customDomain: null;
    hostname: null;
    publicUrl: string;
  }
  | {
    proxyType: 'http';
    remotePort: null;
    customDomain: string;
    hostname: string;
    publicUrl: null;
  };

export const normalizeFrpcServerAddress = z.unknown().transform((value): string => {
  if (!isString(value)) {
    throw new Error('FRPS server address is required');
  }
  const raw = value.trim();
  if (!raw || raw.includes('://') || /[\s/?#@\\]/.test(raw) || raw.endsWith('.')) {
    throw new Error('FRPS server address must be an IP address or bare hostname without a scheme, port, or path');
  }

  const bracketedAddress = raw.startsWith('[') && raw.endsWith(']')
    ? raw.slice(1, -1)
    : raw;
  if (net.isIP(bracketedAddress) !== 0) {
    return bracketedAddress.toLowerCase();
  }
  if (raw.includes(':') || raw.includes('[') || raw.includes(']')) {
    throw new Error('FRPS server address must be a valid IP address or hostname');
  }

  const address = domainToASCII(raw).toLowerCase();
  if (!address || address.length > 253) {
    throw new Error('FRPS server address must be a valid IP address or hostname');
  }
  const labels = address.split('.');
  if (labels.some((label) => (
    label.length === 0
    || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  ))) {
    throw new Error('FRPS server address must be a valid IP address or hostname');
  }
  return address;
}).parse;

const frpcDnsHostnameParser = (label: string) => z.unknown().transform((value): string => {
  if (!isString(value)) {
    throw new Error(`${label} is required`);
  }
  const raw = value.trim();
  if (
    !raw
    || raw.includes('://')
    || /[\s/:?#@\\*[\]]/.test(raw)
    || raw.endsWith('.')
  ) {
    throw new Error(`${label} must be a bare DNS hostname without a scheme, port, path, wildcard, or trailing dot`);
  }

  const hostname = domainToASCII(raw).toLowerCase();
  if (!hostname || hostname.length > 253 || net.isIP(hostname) !== 0) {
    throw new Error(`${label} must be a valid DNS hostname`);
  }
  const labels = hostname.split('.');
  if (labels.some((entry) => (
    entry.length === 0
    || entry.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(entry)
  ))) {
    throw new Error(`${label} must be a valid DNS hostname`);
  }
  return hostname;
}).parse;

export const normalizeFrpcCustomDomain = frpcDnsHostnameParser('FRPS custom domain');

export const normalizeFrpcPublicHostname = frpcDnsHostnameParser('FRPC public hostname');

export const normalizeFrpcPublicUrl = z.unknown().transform((value): string => {
  if (!isString(value) || !value.trim()) {
    throw new Error('FRPC TCP public HTTPS URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('FRPC TCP public URL must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('FRPC TCP public URL must use https://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('FRPC TCP public URL must not contain credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin === 'null') {
    throw new Error('FRPC TCP public URL must be an origin without a path, query, or fragment');
  }
  return parsed.origin;
}).parse;

export const normalizeFrpcToken = z.unknown().transform((value): string => {
  if (!isString(value) || !value.trim()) {
    throw new Error('FRPC token is required');
  }
  const token = value.trim();
  if (/[\0\r\n]/.test(token)) {
    throw new Error('FRPC token must be a single non-empty line');
  }
  if (token.length > FRPC_TOKEN_MAX_LENGTH) {
    throw new Error(`FRPC token must not exceed ${FRPC_TOKEN_MAX_LENGTH} characters`);
  }
  return token;
}).parse;

const frpcPortParser = (label: string) => z.unknown().transform((value): number => {
  if (!isNumber(value) || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}).parse;

export const normalizeFrpcServerPort = frpcPortParser('FRPS server port');

export const normalizeFrpcLocalPort = frpcPortParser('OpenChamber local port');

export const normalizeFrpcRemotePort = frpcPortParser('FRPS remote port');

export function normalizeFrpcEndpoint({
  remotePort,
  customDomain,
  hostname,
  publicUrl,
  proxyType,
}: FrpcEndpointInput = {}): FrpcNormalizedEndpoint {
  const normalizedProxyType = isString(proxyType) ? proxyType.trim().toLowerCase() : '';
  if (normalizedProxyType && normalizedProxyType !== 'tcp' && normalizedProxyType !== 'http') {
    throw new Error(`Unsupported FRPC proxy type: ${String(proxyType)}`);
  }

  const hasRemotePort = remotePort !== undefined && remotePort !== null;
  const hasCustomDomain = isString(customDomain) && customDomain.trim().length > 0;
  const hasPublicUrl = isString(publicUrl) && publicUrl.trim().length > 0;
  if (hasRemotePort && hasCustomDomain) {
    throw new Error('FRPC remotePort and customDomain cannot be used together');
  }
  if (hasCustomDomain && hasPublicUrl) {
    throw new Error('FRPC TCP publicUrl and HTTP customDomain cannot be used together');
  }
  if (normalizedProxyType === 'tcp' && hasCustomDomain) {
    throw new Error('FRPC TCP proxies cannot use customDomain');
  }
  if (normalizedProxyType === 'http' && (hasRemotePort || hasPublicUrl)) {
    throw new Error('FRPC HTTP proxies cannot use remotePort or publicUrl');
  }

  if (hasCustomDomain || normalizedProxyType === 'http') {
    const normalizedCustomDomain = normalizeFrpcCustomDomain(customDomain);
    const normalizedHostname = normalizeFrpcPublicHostname(hostname);
    return {
      proxyType: 'http',
      remotePort: null,
      customDomain: normalizedCustomDomain,
      hostname: normalizedHostname,
      publicUrl: null,
    };
  }

  if (!hasRemotePort) {
    throw new Error('FRPS remote port or custom domain is required');
  }
  return {
    proxyType: 'tcp',
    remotePort: normalizeFrpcRemotePort(remotePort),
    customDomain: null,
    hostname: null,
    publicUrl: normalizeFrpcPublicUrl(publicUrl),
  };
}
