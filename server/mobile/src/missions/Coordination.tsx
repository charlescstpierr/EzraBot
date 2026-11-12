import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { CheckView, MissionDetail } from '../generated/agent-protocol';
import { Button, Mascot, s } from '../ui';
import type { MissionCommand } from './client';
import { budgetLine, coordinationActions, decisionOutcome, decisionTitle, decisionWhy, leadSays, minoCoordinationSays, plain, STATUS } from './present';
import type { Voice } from './Missions';
import type { MissionFollowup } from './use-followup';

const checkText = (check: CheckView | null, command: string[] | null) => !command ? 'Aucun contrôle configuré' : !check ? 'Contrôle non lancé'
  : check.error ? check.error : check.exitCode === 0 ? `✓ « ${check.command.join(' ')} » réussit` : `✗ « ${check.command.join(' ')} » échoue (code ${check.exitCode})`;

/** A coordinated mission: what its lead decided, the steps it handed out, and the synthesis with the PC's evidence. */
export function Coordination({ m, projectName, busy, message, act, open, back, inline = false, voice, followup }: {
  m: MissionDetail; projectName: string; busy: boolean; message: string;
  act(command: MissionCommand, after?: () => void): Promise<void>;
  open(id: string): void; back(): void; inline?: boolean; voice?: Voice;
  followup: MissionFollowup;
}) {
  const { note, setNote, goalDraft, setGoalDraft, clearSentNote, clearSentGoal } = followup;
  const [originOpen, setOriginOpen] = useState(false);
  const lead = m.lead ?? { name: 'Responsable', shape: 'sprout', color: '#8de343', botId: '' };
  const goal = m.goals.at(-1);
  const actions = coordinationActions(m);
  const has = (id: string) => actions.some(a => a.id === id);
  const label = (id: string) => inline && id === 'resume' ? 'Reprendre avec Mino' : actions.find(a => a.id === id)?.label ?? '';
  const children = new Map(m.children.map(c => [c.id, c]));
  return (
    <View>
      <View style={st.head}>
        {!inline && <Pressable accessibilityRole="button" accessibilityLabel="Retour aux missions" onPress={back} hitSlop={10} style={st.back}>
          <Text style={st.backText}>‹ Missions</Text>
        </Pressable>}
        <Text style={[st.pill, STATUS[m.status].tone === 'attention' && st.pillStrong, STATUS[m.status].tone === 'done' && st.pillDone]}>{STATUS[m.status].label}</Text>
      </View>

      <View style={st.voice}>
        <Mascot shape={inline ? voice?.shape ?? 'sprout' : lead.shape} color={inline ? voice?.color ?? '#8de343' : lead.color} size={36} alive={m.status === 'running'} />
        <View style={{ flex: 1 }}>
          <Text style={st.voiceName}>{inline ? voice?.name ?? 'Mino' : `${lead.name} · responsable`}</Text>
          <Text style={s.text}>{inline
            ? m.status === 'waiting' && m.decisions.at(-1)?.outcome === 'refused'
              ? 'Le résultat proposé n’est pas encore complet. Regarde les actions disponibles pour choisir la suite.'
              : minoCoordinationSays(m)
            : leadSays(m)}</Text>
        </View>
      </View>

      <View style={st.box}>
        <Text style={s.label}>{projectName} · objectif v{goal?.rev ?? m.goalRev}</Text>
        <Text style={s.text} selectable>{goal?.text}</Text>
        <Text style={s.muted}>{budgetLine(m)}</Text>
        {!inline && m.origin && (
          <Pressable accessibilityRole="button" onPress={() => setOriginOpen(!originOpen)}>
            <Text style={s.muted}>{originOpen ? 'Ta demande dans le chat :' : 'Voir ta demande dans le chat'}</Text>
            {originOpen && <Text style={s.text} selectable>{m.origin.text}</Text>}
          </Pressable>
        )}
        {!inline && <Text style={s.muted}>{lead.name} décide avec le dossier du projet et des règles dédiées, en lecture seule. Ses souvenirs de conversation ne lui sont pas transmis.</Text>}
      </View>

      {m.live && (
        <View style={st.live}>
          <Text style={s.label}>{m.live.activity ?? 'En cours'}</Text>
          {!inline && m.live.text ? <Text style={s.text} numberOfLines={4}>{m.live.text}</Text> : null}
        </View>
      )}

      <View style={{ marginTop: 14, gap: 4 }}>
      {message ? <Text accessibilityRole="alert" style={st.error}>{message}</Text> : null}

        {m.can.accept && <Button title={label('accept')} solid disabled={busy} onPress={() => void act({ type: 'mission.accept', missionId: m.id, attemptId: m.can.accept ?? '' })} />}
        {has('stop') && <Button title={label('stop')} disabled={busy} onPress={() => void act({ type: 'mission.stop', missionId: m.id })} />}
        {has('resume') && <Button title={label('resume')} solid={!m.can.accept} disabled={busy} onPress={() => void act({ type: 'mission.resume', missionId: m.id })} />}
        {has('continue') && (
          <View style={st.composer}>
            <TextInput accessibilityLabel={inline ? 'Précision à Mino pour la mission' : label('continue')} value={note} onChangeText={setNote} placeholder={inline ? 'Une précision pour la mission…' : `Une précision pour ${lead.name}…`} placeholderTextColor="#00000066" multiline style={st.noteInput} />
            <Button title="Envoyer" label={inline ? 'Envoyer la précision à Mino' : `Envoyer la précision à ${lead.name}`} disabled={busy || !note.trim()} onPress={() => void act({ type: 'mission.continue', missionId: m.id, note: note.trim() }, () => clearSentNote(note))} />
          </View>
        )}
        {has('revise') && (goalDraft === null
          ? <Button title={label('revise')} plain disabled={busy} onPress={() => setGoalDraft(goal?.text ?? '')} />
          : (
            <View style={st.box}>
              <Text style={s.label}>Nouvel objectif (version {m.goalRev + 1})</Text>
              <TextInput accessibilityLabel="Nouvel objectif" value={goalDraft} onChangeText={setGoalDraft} multiline style={[s.input, st.goal]} />
              <Text style={s.muted}>L’étape en cours est arrêtée. Les étapes de l’ancien objectif restent visibles mais ne servent plus de preuve.</Text>
              <View style={s.row}>
                <Button title="Enregistrer et réveiller" solid disabled={busy || !goalDraft.trim()} onPress={() => void act({ type: 'mission.revise', missionId: m.id, goal: goalDraft.trim(), start: true }, () => clearSentGoal(goalDraft))} />
                <Button title="Enregistrer" disabled={busy || !goalDraft.trim()} onPress={() => void act({ type: 'mission.revise', missionId: m.id, goal: goalDraft.trim(), start: false }, () => clearSentGoal(goalDraft))} />
                <Button title="Annuler" plain onPress={() => setGoalDraft(null)} />
              </View>
            </View>
          ))}
        {has('budget') && <Button title={label('budget')} disabled={busy} onPress={() => void act({ type: 'mission.budget', missionId: m.id })} />}
      </View>

      {m.synthesis && (
        <View style={st.card}>
          <Text style={s.label}>{inline ? 'Voici la synthèse reçue' : `Synthèse de ${lead.name}`}</Text>
          <Text style={s.text} selectable numberOfLines={inline ? 6 : undefined}>{plain(m.synthesis.summary)}</Text>
          {m.synthesis.limits ? <><Text style={[s.label, { marginTop: 8 }]}>Limites annoncées</Text><Text style={s.text}>{m.synthesis.limits}</Text></> : null}
          {!inline && <>
          <Text style={[s.label, { marginTop: 8 }]}>Preuves vérifiées par Mino</Text>
          {m.synthesis.evidence.map(e => (
            <Pressable key={e.attemptId} accessibilityRole="button" onPress={() => children.has(e.childId) && open(e.childId)} style={st.proof}>
              <Text style={st.rowTitle}>{e.childTitle}{e.attemptN ? ` · essai ${e.attemptN}` : ''}</Text>
              <Text style={s.muted}>{checkText(e.check, e.checkCommand)} · {e.observed ? `${e.observed.status.length} fichier${e.observed.status.length > 1 ? 's' : ''} modifié${e.observed.status.length > 1 ? 's' : ''}` : 'dossier non constaté'}</Text>
            </Pressable>
          ))}
          </>}
          <Text style={[s.label, { marginTop: 8 }]}>Contrôle final du dossier intégré</Text>
          <Text style={s.text}>{m.synthesis.final ? (m.synthesis.final.state === 'completed' ? checkText(m.synthesis.final.check, m.synthesis.final.checkCommand) : m.synthesis.final.errorMessage ?? 'En cours…') : 'En attente'}</Text>
        </View>
      )}

      {!inline && <>
      <Text style={[s.title, { marginTop: 22 }]}>Travaux confiés</Text>
      {m.children.length === 0 && <Text style={s.muted}>Aucune étape confiée pour l’instant.</Text>}
      {m.children.map((c, i) => (
        <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={`Étape ${i + 1}, ${c.title}, ${STATUS[c.status].label}`} onPress={() => open(c.id)} style={st.row}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={st.rowTitle} numberOfLines={2}>{i + 1}. {c.title}</Text>
            <Text style={s.muted} numberOfLines={1}>Session {c.threadId ?? 'pas encore ouverte'}</Text>
          </View>
          <Text style={[st.pill, STATUS[c.status].tone === 'attention' && st.pillStrong, STATUS[c.status].tone === 'done' && st.pillDone]}>{STATUS[c.status].label}</Text>
        </Pressable>
      ))}

      <Text style={[s.title, { marginTop: 22 }]}>Décisions</Text>
      {m.decisions.length === 0 && <Text style={s.muted}>Pas encore de décision.</Text>}
      {[...m.decisions].reverse().map(d => (
        <View key={d.id} style={st.decision}>
          <View style={st.decisionHead}>
            <Mascot shape={lead.shape} color={lead.color} size={22} />
            <Text style={st.rowTitle}>{decisionTitle(d)}</Text>
          </View>
          {decisionWhy(d) ? <Text style={s.text}>{decisionWhy(d)}</Text> : null}
          <Text style={[s.muted, d.outcome === 'refused' && st.refused]}>{decisionOutcome(d)} · objectif v{d.goalRev}</Text>
          {d.childId && children.has(d.childId) && <Button title={`Voir « ${children.get(d.childId)?.title ?? ''} »`} plain onPress={() => open(d.childId ?? '')} />}
        </View>
      ))}

      <Text style={[s.muted, { marginTop: 16 }]} selectable>Session du responsable : {m.threadId ?? 'pas encore ouverte'}</Text>
      </>}
      {inline && <Button title="Détails de la mission" plain onPress={() => open(m.id)} />}
    </View>
  );
}

const st = StyleSheet.create({
  error: { color: '#80601a', backgroundColor: '#fff8e8', borderRadius: 12, padding: 12, marginVertical: 8, fontSize: 14, lineHeight: 21 },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  back: { minHeight: 40, justifyContent: 'center' },
  backText: { fontSize: 14, fontWeight: '500', color: '#626262' },
  voice: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginVertical: 16, padding: 16, backgroundColor: '#f6f8f3', borderRadius: 20 },
  voiceName: { fontSize: 12, lineHeight: 18, fontWeight: '600', color: '#53743b', marginBottom: 4 },
  box: { borderWidth: 1, borderColor: '#e5e5e5', backgroundColor: '#fafafa', borderRadius: 20, padding: 16, gap: 7, marginTop: 8 },
  goal: { minHeight: 96, textAlignVertical: 'top' },
  live: { borderLeftWidth: 2, borderColor: '#85bd56', backgroundColor: '#f6f8f3', padding: 14, borderRadius: 12, marginTop: 14, gap: 4 },
  card: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 20, padding: 16, marginTop: 16, gap: 6 },
  proof: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#e5e5e5', paddingVertical: 8, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, marginTop: 10, borderWidth: 1, borderRadius: 20, borderColor: '#e5e5e5', backgroundColor: '#fff' },
  rowTitle: { fontSize: 15, fontWeight: '600', color: '#000', flexShrink: 1 },
  pill: { fontSize: 11, fontWeight: '500', flexShrink: 0, color: '#626262', borderWidth: 1, borderColor: '#e5e5e5', backgroundColor: '#f7f7f7', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },
  pillStrong: { backgroundColor: '#fff6df', borderColor: '#f0e0b8', color: '#80601a' },
  pillDone: { backgroundColor: '#f0f7ec', borderColor: '#dce9d4', color: '#49653a' },
  decision: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#e5e5e5', paddingVertical: 12, gap: 4 },
  decisionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  refused: { color: '#80601a' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderColor: '#e5e5e5', backgroundColor: '#fafafa', borderRadius: 22, paddingLeft: 14, paddingRight: 4, paddingVertical: 2, gap: 6 },
  noteInput: { flex: 1, minHeight: 44, maxHeight: 120, fontSize: 16, color: '#000', paddingVertical: 12 },
});
