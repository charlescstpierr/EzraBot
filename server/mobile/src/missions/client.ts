import { z } from 'zod';
import type { AgentCommand, AgentsView, MissionDetail, ProjectView } from '../generated/agent-protocol';
import { BrowserSessionSchema, DeviceSessionSchema } from '../generated/mobile-protocol';
import { RemoteError, type Storage, type Transport } from '../controller';
import { createMissionFollowups } from './followup-state';

type Body<C> = C extends AgentCommand ? Omit<C, 'requestId'> : never;
export type MissionCommand = Body<AgentCommand>;
export type CatalogModel = { id: string; displayName: string; isDefault: boolean; efforts: string[]; defaultEffort: string };
export type MissionPage = { rev: number; mission: MissionDetail; project: ProjectView | null };
export type SendResult = { ok: true; id: string } | { ok: false; message: string };

const SavedSchema = z.object({ session: z.union([DeviceSessionSchema, BrowserSessionSchema]) });

/** Missions go through the same paired session and transport as the chat; the PC checks every command again. */
export function createMissionsClient(storage: Pick<Storage, 'readSecret'>, transport: Transport, newId: () => string) {
  const handoffRequests = new Map<string, string>();
  async function session() {
    const raw = await storage.readSecret();
    if (!raw) throw new Error('Associe d’abord ce téléphone à ton ordinateur.');
    return SavedSchema.parse(JSON.parse(raw)).session;
  }
  const get = async (path: string, signal?: AbortSignal) => transport(await session(), path, undefined, signal);
  return {
    async view(after: number | null, signal?: AbortSignal): Promise<AgentsView> {
      return await get(`/m/agents/view${after === null ? '' : `?after=${after}`}`, signal) as AgentsView;
    },
    async mission(id: string, after: number | null, signal?: AbortSignal): Promise<MissionPage> {
      return await get(`/m/agents/missions/${encodeURIComponent(id)}${after === null ? '' : `?after=${after}`}`, signal) as MissionPage;
    },
    async catalog(): Promise<CatalogModel[]> {
      const value = await get('/m/agents/catalog') as { ok: boolean; models?: CatalogModel[] };
      return value.models ?? [];
    },
    async send(command: MissionCommand): Promise<SendResult> {
      try {
        const handoff = command.type === 'mission.create' && command.origin ? JSON.stringify(command) : null;
        const requestId = handoff === null ? newId() : handoffRequests.get(handoff) ?? newId();
        if (handoff !== null) handoffRequests.set(handoff, requestId);
        const value = await transport(await session(), '/m/agents/commands', JSON.stringify({ ...command, requestId })) as { ok: boolean; id?: string; message?: string };
        if (value.ok && typeof value.id === 'string') return { ok: true, id: value.id };
        return { ok: false, message: value.message ?? 'Le PC a refusé la demande.' };
      } catch (error) {
        if (error instanceof RemoteError) return { ok: false, message: error.message };
        return { ok: false, message: 'Le PC n’a pas répondu. La demande est peut-être arrivée : regarde la mission avant de recommencer.' };
      }
    },
  };
}
export type MissionsClient = ReturnType<typeof createMissionsClient>;

export type MissionDrafts = { followups: ReturnType<typeof createMissionFollowups>; load(key: string): Promise<string | null>; save(key: string, value: string): Promise<void>; clear(key: string): Promise<void> };

/** Mission goal drafts live in the platform storage under their own keys; a failed read or write never blocks the form. */
export function missionDrafts(storage: Pick<Storage, 'read' | 'write' | 'remove'>, spaceId: string): MissionDrafts {
  const scoped = (key: string) => JSON.stringify(['mission-draft', spaceId, key]);
  return {
    followups: createMissionFollowups(),
    async load(key) { try { return await storage.read(scoped(key)); } catch { return null; } },
    async save(key, value) { try { if (value) await storage.write(scoped(key), value); else await storage.remove(scoped(key)); } catch { /* the draft is a convenience */ } },
    async clear(key) { try { await storage.remove(scoped(key)); } catch { /* the draft is a convenience */ } },
  };
}
