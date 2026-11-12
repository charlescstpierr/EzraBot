import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { PairClaimSchema, type PairGrant, type PairStatus } from './mobile-protocol.js';

const rowSchema = z.object({ id: z.string(), space: z.string(), name: z.string(), token_hash: z.string(), pairing_id: z.string(), state: z.enum(['pending', 'active', 'revoked']), code: z.string(), created: z.number(), expires: z.number() });
const grantSchema = z.object({ id: z.string(), space: z.string(), secret_hash: z.string(), expires: z.number() });
type Row = z.infer<typeof rowSchema>;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export class DeviceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export type Devices = ReturnType<typeof openDevices>;

export function openDevices(options: { path: string; spaceId: string; publicUrl: string; now?: () => number }) {
  const db = new DatabaseSync(options.path);
  chmodSync(options.path, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, space TEXT NOT NULL, secret_hash TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, space TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, pairing_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), code TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const now = options.now ?? Date.now;
  const changes = new Set<() => void>();
  const changed = () => { for (const listener of changes) listener(); };
  function tx<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const value = action(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function row(id: string): Row | null {
    const value = db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    return value ? rowSchema.parse(value) : null;
  }
  function status(device: Row): PairStatus {
    return { state: device.state === 'revoked' ? 'revoked' : device.expires <= now() ? 'expired' : device.state, deviceId: device.id, spaceId: device.space, confirmCode: device.code };
  }
  function authenticate(token: string, space: string, pending = false): Row {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new DeviceError(401, 'device_unauthorized', 'Appareil non autorisé. Associez-le depuis votre ordinateur.');
    const raw = db.prepare('SELECT * FROM devices WHERE token_hash=?').get(sha(token));
    const device = raw ? rowSchema.parse(raw) : null;
    if (!device || device.state === 'revoked' || device.expires <= now()) throw new DeviceError(401, 'device_unauthorized', 'L’accès de cet appareil a expiré ou a été retiré.');
    if (device.space !== options.spaceId || space !== options.spaceId) throw new DeviceError(409, 'space_mismatch', 'Cet accès appartient à un autre espace. Associez de nouveau cet appareil.');
    if (device.state !== 'active' && !pending) throw new DeviceError(403, 'pairing_pending', 'Confirmez cet appareil sur votre ordinateur.');
    return device;
  }
  return {
    publicUrl: options.publicUrl,
    spaceId: options.spaceId,
    createGrant(): PairGrant {
      const count = db.prepare("SELECT COUNT(*) AS n FROM devices WHERE space=? AND state<>'revoked' AND expires>?").get(options.spaceId, now());
      if (z.object({ n: z.number() }).parse(count).n >= 16) throw new DeviceError(409, 'device_limit', 'Retirez un ancien appareil avant d’en associer un autre.');
      const secret = randomBytes(32).toString('hex');
      const pairingId = randomUUID();
      const expires = now() + 5 * 60_000;
      tx(() => {
        db.prepare('DELETE FROM grants WHERE expires<=?').run(now());
        db.prepare("DELETE FROM grants WHERE space=? AND id NOT IN (SELECT id FROM grants WHERE space=? ORDER BY expires DESC LIMIT 2) AND id NOT IN (SELECT pairing_id FROM devices WHERE space=? AND state='pending' AND expires>?)").run(options.spaceId, options.spaceId, options.spaceId, now());
        db.prepare('INSERT INTO grants VALUES(?,?,?,?)').run(pairingId, options.spaceId, sha(secret), expires);
      });
      changed();
      return { version: 1, url: options.publicUrl, spaceId: options.spaceId, pairingId, secret, expiresAt: new Date(expires).toISOString() };
    },
    createBrowserGrant(): PairGrant {
      const count = z.object({ n: z.number() }).parse(db.prepare("SELECT COUNT(*) AS n FROM devices WHERE space=? AND state<>'revoked' AND expires>?").get(options.spaceId, now())).n;
      if (count >= 16) throw new DeviceError(409, 'device_limit', 'Retirez un ancien appareil avant d’en associer un autre.');
      const secret = randomBytes(32).toString('hex');
      const pairingId = randomUUID();
      const expires = now() + 5 * 60_000;
      tx(() => {
        db.prepare('DELETE FROM grants WHERE expires<=?').run(now());
        db.prepare('INSERT INTO grants VALUES(?,?,?,?)').run(pairingId, options.spaceId, sha(secret), expires);
      });
      return { version: 1, url: options.publicUrl, spaceId: options.spaceId, pairingId, secret, expiresAt: new Date(expires).toISOString() };
    },
    claim(input: unknown): PairStatus {
      const command = PairClaimSchema.safeParse(input);
      if (!command.success) throw new DeviceError(422, 'invalid_pairing', 'Association incomplète. Scannez le code affiché sur votre ordinateur.');
      const c = command.data;
      const result = tx(() => {
        const prior = db.prepare('SELECT * FROM devices WHERE pairing_id=?').get(c.pairingId);
        if (prior) {
          const device = rowSchema.parse(prior);
          if (device.id !== c.deviceId || device.token_hash !== sha(c.deviceToken) || device.name !== c.deviceName || device.space !== options.spaceId) throw new DeviceError(409, 'pairing_claimed', 'Ce code est déjà utilisé par un autre appareil.');
          return status(device);
        }
        const value = db.prepare('SELECT * FROM grants WHERE id=?').get(c.pairingId);
        const grant = value ? grantSchema.parse(value) : null;
        if (!grant || grant.space !== options.spaceId || grant.expires <= now() || !timingSafeEqual(Buffer.from(grant.secret_hash), Buffer.from(sha(c.secret)))) throw new DeviceError(403, 'pairing_expired', 'Ce code n’est plus valable. Créez une nouvelle association sur votre ordinateur.');
        const count = z.object({ n: z.number() }).parse(db.prepare("SELECT COUNT(*) AS n FROM devices WHERE space=? AND state<>'revoked' AND expires>?").get(options.spaceId, now())).n;
        if (count >= 16) throw new DeviceError(409, 'device_limit', 'Retirez un ancien appareil.');
        if (row(c.deviceId) || db.prepare('SELECT id FROM devices WHERE token_hash=?').get(sha(c.deviceToken))) throw new DeviceError(409, 'device_conflict', 'Cet identifiant d’appareil est déjà utilisé. Recommencez l’association.');
        db.prepare('INSERT INTO devices(id,space,name,token_hash,pairing_id,state,code,created,expires) VALUES(?,?,?,?,?,?,?,?,?)').run(c.deviceId, options.spaceId, c.deviceName, sha(c.deviceToken), c.pairingId, 'pending', String(randomInt(0, 1_000_000)).padStart(6, '0'), now(), grant.expires);
        const device = row(c.deviceId);
        if (!device) throw new Error('Device claim not recorded');
        return status(device);
      });
      changed();
      return result;
    },
    approve(pairingId: string, deviceId: string, confirmCode: string): void {
      tx(() => {
        const device = row(deviceId);
        if (!device || device.space !== options.spaceId || device.pairing_id !== pairingId || device.code !== confirmCode || device.state === 'revoked' || device.expires <= now()) throw new DeviceError(409, 'pairing_stale', 'Cette association n’est plus valable.');
        if (device.state === 'active') return;
        const grant = db.prepare('SELECT expires FROM grants WHERE id=?').get(pairingId);
        if (!grant || z.object({ expires: z.number() }).parse(grant).expires <= now()) throw new DeviceError(409, 'pairing_expired', 'Le code a expiré.');
        db.prepare("UPDATE devices SET state='active', expires=? WHERE id=?").run(now() + 30 * 24 * 60 * 60_000, deviceId);
        db.prepare('DELETE FROM grants WHERE id=?').run(pairingId);
      });
      changed();
    },
    revoke(deviceId: string): void {
      db.prepare("UPDATE devices SET state='revoked' WHERE id=? AND space=?").run(deviceId, options.spaceId);
      changed();
    },
    authenticate,
    pairStatus(token: string, space: string): PairStatus { return status(authenticate(token, space, true)); },
    list() {
      return db.prepare('SELECT * FROM devices WHERE space=? ORDER BY created DESC').all(options.spaceId).map(value => {
        const device = rowSchema.parse(value);
        return { id: device.id, name: device.name, pairingId: device.pairing_id, confirmCode: device.code, state: status(device).state, createdAt: new Date(device.created).toISOString(), expiresAt: new Date(device.expires).toISOString() };
      });
    },
    onChange(listener: () => void) { changes.add(listener); return () => { changes.delete(listener); }; },
    close() { changes.clear(); db.close(); },
  };
}
