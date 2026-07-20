export const WINDOWS_NOTIFICATION_TARGET_LIMIT = 64;

const STORAGE_VERSION = 2;
const TARGETS_KEY = 'targets';
const TARGET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const INVALID_XML_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const normalizeRoot = (root) => (
  root && typeof root === 'object' && !Array.isArray(root) && root.version === STORAGE_VERSION
    ? root
    : { version: STORAGE_VERSION }
);

const normalizeString = (value, maxLength) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
};

const normalizeNotificationId = (value) => {
  const normalized = normalizeString(value, 128);
  return normalized && NOTIFICATION_ID_PATTERN.test(normalized) ? normalized : null;
};

const normalizeTarget = (value, now) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeNotificationId(value.id);
  const createdAt = Number(value.createdAt);
  if (!id || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (createdAt < now - TARGET_MAX_AGE_MS || createdAt > now + MAX_CLOCK_SKEW_MS) return null;

  if (value.sessionId !== null && value.sessionId !== undefined && typeof value.sessionId !== 'string') return null;
  const sessionId = normalizeString(value.sessionId, 512);
  if (typeof value.sessionId === 'string' && value.sessionId.trim() && !sessionId) return null;
  if (typeof value.runtimeKey !== 'string') return null;
  const runtimeKey = normalizeString(value.runtimeKey, 2_048);
  if (!runtimeKey) return null;
  if (value.directory !== null && value.directory !== undefined && typeof value.directory !== 'string') return null;
  const directory = sessionId ? normalizeString(value.directory, 32_768) : null;
  if (sessionId && typeof value.directory === 'string' && value.directory.trim() && !directory) return null;
  return { id, runtimeKey, sessionId, directory, createdAt };
};

const normalizeTargets = (root, now) => {
  const raw = normalizeRoot(root)[TARGETS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((target) => normalizeTarget(target, now))
    .filter(Boolean)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-WINDOWS_NOTIFICATION_TARGET_LIMIT);
};

export const getWindowsNotificationTarget = (root, notificationId, now = Date.now()) => {
  const id = normalizeNotificationId(notificationId);
  if (!id) return null;
  return normalizeTargets(root, now).findLast((target) => target.id === id) ?? null;
};

export const storeWindowsNotificationTarget = (root, target, now = Date.now()) => {
  const normalizedRoot = normalizeRoot(root);
  const normalizedTarget = normalizeTarget({ ...target, createdAt: target?.createdAt ?? now }, now);
  if (!normalizedTarget) {
    throw new TypeError('Invalid Windows notification target');
  }

  const targets = normalizeTargets(normalizedRoot, now)
    .filter((entry) => entry.id !== normalizedTarget.id);
  targets.push(normalizedTarget);

  return {
    ...normalizedRoot,
    version: STORAGE_VERSION,
    [TARGETS_KEY]: targets.slice(-WINDOWS_NOTIFICATION_TARGET_LIMIT),
  };
};

export const removeWindowsNotificationTarget = (root, notificationId, now = Date.now()) => {
  const normalizedRoot = normalizeRoot(root);
  const id = normalizeNotificationId(notificationId);
  const next = { ...normalizedRoot };
  const targets = normalizeTargets(normalizedRoot, now)
    .filter((target) => target.id !== id);

  if (targets.length > 0) {
    next[TARGETS_KEY] = targets;
  } else {
    delete next[TARGETS_KEY];
  }
  next.version = STORAGE_VERSION;
  return next;
};

export const buildWindowsNotificationProtocolUrl = (notificationId) => {
  const id = normalizeNotificationId(notificationId);
  if (!id) throw new TypeError('Invalid Windows notification id');
  return `openchamber://notification/${encodeURIComponent(id)}`;
};

const escapeXml = (value) => String(value ?? '')
  .replace(INVALID_XML_CHARACTERS, '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

export const buildWindowsProtocolToastXml = ({ notificationId, title, body }) => {
  const protocolUrl = buildWindowsNotificationProtocolUrl(notificationId);
  const resolvedTitle = typeof title === 'string' && title.trim() ? title.trim() : 'OpenChamber';
  const resolvedBody = typeof body === 'string' ? body : '';
  const bodyText = resolvedBody ? `<text>${escapeXml(resolvedBody)}</text>` : '';

  return `<toast launch="${escapeXml(protocolUrl)}" activationType="protocol"><visual><binding template="ToastGeneric"><text>${escapeXml(resolvedTitle)}</text>${bodyText}</binding></visual></toast>`;
};
