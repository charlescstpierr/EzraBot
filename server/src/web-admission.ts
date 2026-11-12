import { randomBytes, randomUUID } from 'node:crypto';
import { DeviceError, type Devices } from './devices.js';

export type BrowserAdmission = ReturnType<typeof createBrowserAdmission>;

export function createBrowserAdmission(devices: Devices, now: () => number = Date.now) {
  let deadline = 0;
  return {
    open() {
      deadline = now() + 2 * 60_000;
      return { expiresAt: new Date(deadline).toISOString() };
    },
    expiresAt(): string | null {
      return deadline > now() ? new Date(deadline).toISOString() : null;
    },
    claim(deviceName: string) {
      if (deadline <= now()) throw new DeviceError(403, 'browser_window_closed', 'Autorise Safari sur ton ordinateur, puis réessaie.');
      const grant = devices.createBrowserGrant();
      const token = randomBytes(32).toString('hex');
      devices.claim({ pairingId: grant.pairingId, secret: grant.secret, deviceId: randomUUID(), deviceToken: token, deviceName });
      const device = devices.authenticate(token, devices.spaceId, true);
      deadline = 0;
      return { token, device };
    },
  };
}
