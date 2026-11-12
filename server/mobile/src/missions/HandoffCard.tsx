import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AgentsView, MissionSummary } from '../generated/agent-protocol';
import { Button, s } from '../ui';
import { MissionThread, NewMission, type LeadChoice, type Origin, type Voice } from './Missions';
import type { MissionDrafts, MissionsClient } from './client';
import { linkedMission, STATUS } from './present';

export type HandoffProposal = { goal: string; coordinated: boolean; why: string };

type ChatMissionProps = {
  drafts: MissionDrafts;
  client: MissionsClient; voice: Voice; expandedId: string | null;
  expand(id: string | null): void; details(id: string): void;
};

export function MissionChatCard({ mission, client, voice, expandedId, expand, details, drafts }: ChatMissionProps & { mission: MissionSummary }) {
  return <View style={st.card} accessibilityLabel="Mission suivie par Mino">
    <Text style={s.label}>Je suis cette mission</Text>
    <Text style={s.text}>{mission.title}</Text>
    <Text style={s.muted}>{STATUS[mission.status].label}</Text>
    {expandedId === mission.id
      ? <><MissionThread key={mission.id} drafts={drafts} client={client} id={mission.id} voice={voice} inline open={details} /><Button title="Réduire le suivi" plain onPress={() => expand(null)} /></>
      : <Button title="Suivre ici" onPress={() => expand(mission.id)} />}
  </View>;
}

/** Creation and follow-up stay below Mino's proposal. Only an explicit details action opens a sheet. */
export function HandoffCard({ handoff, origin, view, error, leads, drafts, ...chat }: ChatMissionProps & {
  handoff: HandoffProposal; origin: Origin; view: AgentsView | null; error: string; leads: LeadChoice[]; drafts: MissionDrafts;
}) {
  const [createdId, setCreatedId] = useState<string | null>(null);
  const mission = linkedMission(view?.missions ?? [], origin.messageId);
  const id = mission?.id ?? createdId;
  return <View style={st.card} accessibilityLabel="Proposition de Mino">
    {id ? <>
      <Text style={s.label}>Je suis cette mission</Text>
      <Text style={s.text}>{mission?.title ?? handoff.goal}</Text>
      {mission && <Text style={s.muted}>{STATUS[mission.status].label}</Text>}
      {chat.expandedId === id
        ? <><MissionThread key={id} drafts={drafts} client={chat.client} id={id} voice={chat.voice} inline open={chat.details} /><Button title="Réduire le suivi" plain onPress={() => chat.expand(null)} /></>
        : <Button title="Suivre ici" onPress={() => chat.expand(id)} />}
    </> : <>
      <Text style={s.label}>Je peux confier ça</Text>
      <Text style={s.muted}>{handoff.why}</Text>
      {!view && !error && <Text style={s.muted}>Je vérifie les missions enregistrées sur ton PC…</Text>}
      {error && <Text accessibilityRole="alert" style={st.warning}>Je ne peux pas vérifier les missions enregistrées. {error}</Text>}
      {view && <NewMission client={chat.client} projects={view.projects} initialGoal={handoff.goal}
        initialMode={handoff.coordinated && leads.length ? 'coordinated' : 'direct'} origin={origin} leads={leads} drafts={drafts} inline disabled={!!error}
        created={newId => { setCreatedId(newId); chat.expand(newId); }} />}
    </>}
  </View>;
}

const st = StyleSheet.create({
  card: { borderWidth: 1, borderColor: '#dce9d4', backgroundColor: '#f6f8f3', borderRadius: 20, padding: 16, gap: 7, marginTop: 12, width: '100%' },
  warning: { fontSize: 14, lineHeight: 21, color: '#80601a' },
});
