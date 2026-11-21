import { validateNotificationAuth, type NotificationAuth } from './auth-runtime.js';
import { pairedSessionKey } from './session-key.js';

type Registration<Device> = { auth: NotificationAuth; devices: readonly Device[] };

export async function deliverableDevices<Device>(
  registrations: Registration<Device>[],
  invalidSessionKeys: ReadonlySet<string>,
  deviceId: (device: Device) => string,
  removeInactive: (auth: NotificationAuth) => Promise<void>,
): Promise<Device[]> {
  const checked = await Promise.all(registrations.map(async ({ auth, devices }) => {
    const key = pairedSessionKey(auth);
    const invalidPairing = key !== null && invalidSessionKeys.has(key);
    const status = invalidPairing ? 'inactive' : await validateNotificationAuth(auth);
    return { auth, devices, status, invalidPairing };
  }));
  const barred = new Set<string>();
  const paired = new Set<string>();
  const active = new Map<string, Device>();
  const cleanup: Promise<void>[] = [];
  for (const { auth, devices, status, invalidPairing } of checked) {
    if (status === 'active') {
      for (const device of devices) {
        const id = deviceId(device);
        if (auth.kind === 'client') paired.add(id);
        if (!active.has(id) || auth.kind === 'client') active.set(id, device);
      }
    } else if (invalidPairing || auth.kind === 'client') {
      for (const device of devices) barred.add(deviceId(device));
    } else if (status === 'inactive') {
      cleanup.push(removeInactive(auth).catch(() => {}));
    }
  }
  await Promise.all(cleanup);
  return [...active].flatMap(([id, device]) => barred.has(id) && !paired.has(id) ? [] : [device]);
}
