import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AgentsView, AttemptView, MissionDetail, MissionMode, ProjectView } from '../generated/agent-protocol';
import { Button, Mascot, Sheet, s } from '../ui';
import type { MissionCommand, MissionDrafts, MissionPage, MissionsClient } from './client';
import { Coordination } from './Coordination';
import { useMissionFollowup } from './use-followup';
import { attemptTitle, backTarget, defaultLead, draftKey, group, latestReview, latestWork, lines, minoSays, plain, STATUS, tokens } from './present';

export type Voice = { name: string; shape: string; color: string };
/** A bot the person may choose as the lead of a coordinated mission: a real bot of the app, never Mino itself. */
export type LeadChoice = { id: string; name: string; shape: string; color: string };
/** The person's exact message Mino's proposal answers, shown for reference; the PC finds it again on its own. */
export type Origin = { messageId: string; text: string };
type Screen = { kind: 'list' } | { kind: 'new'; goal: string } | { kind: 'mission'; id: string };

/** Keeps a long-poll open on the PC while mounted; `after` makes it wait for the next change. */
function usePoll<T extends { rev: number }>(load: (after: number | null, signal: AbortSignal) => Promise<T>, deps: unknown[], enabled = true) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setValue(null);
    setError('');
    if (!enabled) return;
    const controller = new AbortController();
    let rev: number | null = null;
    let delay = 0;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const next = await load(rev, controller.signal);
          if (controller.signal.aborted) return;
          rev = next.rev;
          setValue(next);
          setError('');
          delay = 0;
        } catch (e) {
          if (controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : 'PC injoignable.');
          delay = Math.min(10_000, delay + 2000);
          await new Promise(r => setTimeout(r, delay));
          rev = null;
        }
      }
    })();
    return () => controller.abort();
  }, [...deps, enabled]);
  return { value, error };
}

export function useMissionsView(client: MissionsClient, spaceId: string | undefined) {
  return usePoll((after, signal) => client.view(after, signal), [client, spaceId], !!spaceId);
}

export function MissionsSheet({ client, close, voice, initialGoal = '', initialMissionId, initialMode = 'direct', origin, leads = [], drafts }: {
  client: MissionsClient; close(): void; voice: Voice; initialGoal?: string; initialMissionId?: string;
  initialMode?: MissionMode; origin?: Origin; leads?: LeadChoice[]; drafts?: MissionDrafts;
}) {
  const [screen, setScreen] = useState<Screen>(() => initialMissionId
    ? { kind: 'mission', id: initialMissionId }
    : initialGoal || origin ? { kind: 'new', goal: initialGoal } : { kind: 'list' });
  const { value: view, error } = usePoll((after, signal) => client.view(after, signal), [client]);
  const projects = view?.projects ?? [];
  const title = screen.kind === 'mission' ? 'Mission' : screen.kind === 'new' ? 'Nouvelle mission' : 'Missions';
  return (
    <Sheet title={title} close={close}>
      <View style={st.content}>
        {error ? <Text style={st.warning}>{error}</Text> : null}
        {screen.kind === 'list' && <MissionList view={view} voice={voice} open={id => setScreen({ kind: 'mission', id })} create={() => setScreen({ kind: 'new', goal: '' })} />}
        {screen.kind === 'new' && <NewMission client={client} projects={projects} initialGoal={screen.goal} initialMode={initialMode} origin={origin} leads={leads.filter(l => l.id !== 'mino')} drafts={drafts}
          back={() => setScreen({ kind: 'list' })} created={id => setScreen({ kind: 'mission', id })} />}
        {screen.kind === 'mission' && <MissionThread key={screen.id} drafts={drafts} client={client} id={screen.id} voice={voice} open={id => setScreen({ kind: 'mission', id })} back={target => setScreen(target)} />}
      </View>
    </Sheet>
  );
}

function Bubble({ voice, text, alive = false }: { voice: Voice; text: string; alive?: boolean }) {
  return (
    <View style={st.mino}>
      <Mascot shape={voice.shape} color={voice.color} size={36} alive={alive} />
      <View style={{ flex: 1 }}>
        <Text style={st.voiceName}>{voice.name}</Text>
        <Text style={s.text}>{text}</Text>
      </View>
    </View>
  );
}

function Pill({ status }: { status: MissionDetail['status'] }) {
  const tone = STATUS[status].tone;
  return <Text style={[st.pill, tone === 'attention' && st.pillStrong, tone === 'done' && st.pillDone]}>{STATUS[status].label}</Text>;
}

function MissionList({ view, voice, open, create }: { view: (AgentsView & { rev: number }) | null; voice: Voice; open(id: string): void; create(): void }) {
  if (!view) return <Text style={s.muted}>Connexion au PC…</Text>;
  const projects = new Map(view.projects.map(p => [p.id, p]));
  const sections = group(view.missions);
  return (
    <View>
      <Bubble voice={voice} text={view.projects.length
        ? 'Dis-moi ce qu’il faut faire et dans quel dossier. Je le confie à un exécutant Codex sur ton ordinateur, et je te montre ce qui a vraiment changé.'
        : 'Aucun dossier ne m’est encore confié. Sur l’ordinateur, ouvre Mino puis Projets pour en ajouter un.'} />
      <Button title="Nouvelle mission" solid disabled={!view.projects.length} onPress={create} />
      {view.engine.state === 'unavailable' && <Text style={st.warning}>{view.engine.message ?? 'Codex est indisponible sur le PC.'}</Text>}
      {sections.map(section => (
        <View key={section.title} style={{ marginTop: 18 }}>
          <Text style={s.label}>{section.title}</Text>
          {section.items.map(m => (
            <Pressable key={m.id} accessibilityRole="button" accessibilityLabel={`${m.title}, ${STATUS[m.status].label}`} onPress={() => open(m.id)} style={st.row}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={st.rowTitle} numberOfLines={2}>{m.title}</Text>
                <Text style={s.muted}>{projects.get(m.projectId)?.name ?? 'Projet'} · {m.tree ? `avec ${m.lead?.name ?? 'un responsable'} · ${m.tree.used} essais sur ${m.tree.max}` : `essai ${m.attemptsUsed} sur ${m.maxAttempts}`}{view.queue.includes(m.id) && m.status === 'queued' ? ` · ${view.queue.indexOf(m.id) + 1}ᵉ dans la file` : ''}</Text>
              </View>
              <Pill status={m.status} />
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

export function NewMission({ client, projects, initialGoal, initialMode, origin, leads, drafts, back, created, inline = false, disabled = false }: {
  client: MissionsClient; projects: ProjectView[]; initialGoal: string; initialMode: MissionMode; origin: Origin | undefined;
  leads: LeadChoice[]; drafts: MissionDrafts | undefined; back?: () => void; created(id: string): void; inline?: boolean; disabled?: boolean;
}) {
  const usable = projects.filter(p => !p.archived);
  // A proposal from the chat names no folder: the person picks one, never a silent default.
  const [projectId, setProjectId] = useState(origin ? '' : usable[0]?.id ?? '');
  const [goal, setGoal] = useState(initialGoal);
  const [mode, setMode] = useState<MissionMode>(initialMode);
  const [leadId, setLeadId] = useState('');
  const [originOpen, setOriginOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const key = draftKey(origin?.messageId ?? null);
  const edited = useRef(false);
  useEffect(() => {
    if (inline && !advanced) return;
    void client.catalog().then(models => setModel(models.find(m => m.isDefault)?.displayName ?? models[0]?.displayName ?? '')).catch(() => {});
  }, [client, inline, advanced]);
  useEffect(() => { if (!origin && !projectId && usable[0]) setProjectId(usable[0].id); }, [usable.length]);
  useEffect(() => {
    let active = true;
    void (drafts?.load(key) ?? Promise.resolve(null)).then(saved => { if (active && !edited.current && saved) setGoal(saved); });
    return () => { active = false; };
  }, [key, drafts]);
  const project = usable.find(p => p.id === projectId);
  useEffect(() => {
    setLeadId(defaultLead(leads, project?.leadBotId));
  }, [projectId, project?.leadBotId, leads.map(l => l.id).join(',')]);
  const edit = (value: string) => { edited.current = true; setGoal(value); void drafts?.save(key, value); };
  const lead = leads.find(l => l.id === leadId);
  const coordinated = mode === 'coordinated';
  const submit = async () => {
    if (busy || disabled) return;
    setBusy(true);
    const result = await client.send({
      type: 'mission.create', projectId, goal: goal.trim(), model: null, effort: null,
      ...(coordinated ? { mode: 'coordinated' as const, leadBotId: leadId } : {}),
      ...(origin ? { origin: { messageId: origin.messageId } } : {}),
    });
    setBusy(false);
    if (result.ok) { await drafts?.clear(key); created(result.id); }
    else setMessage(result.message);
  };
  return (
    <View>
      {inline && !advanced && <View>
        <Text style={s.label}>Objectif à confier</Text>
        <Text accessibilityLabel="Objectif à confier" selectable style={s.text}>{goal.trim() || 'Écris un objectif dans « Ajuster la mission ».'}</Text>
      </View>}
      {origin && !inline && (
        <Pressable accessibilityRole="button" onPress={() => setOriginOpen(!originOpen)} style={st.goalBox}>
          <Text style={s.label}>Ta demande à Mino</Text>
          <Text style={s.text} numberOfLines={originOpen ? undefined : 2} selectable>{origin.text}</Text>
          {!originOpen && <Text style={s.muted}>Toucher pour tout voir</Text>}
        </Pressable>
      )}
      <Text style={[s.label, { marginTop: origin ? 14 : 0 }]}>Dossier</Text>
      {!usable.length && <Text style={s.muted}>Aucun dossier ne m’est confié. Sur l’ordinateur, ouvre Projets pour en ajouter un.</Text>}
      <View style={st.chips}>
        {usable.map(p => (
          <Pressable key={p.id} accessibilityRole="radio" aria-checked={p.id === projectId} accessibilityState={{ selected: p.id === projectId }} onPress={() => setProjectId(p.id)} style={[st.chip, p.id === projectId && st.chipOn]}>
            <Text style={[st.chipText, p.id === projectId && { color: '#fff' }]}>{p.name}</Text>
          </Pressable>
        ))}
      </View>
      {project && <Text style={s.muted}>L’exécutant pourra modifier ce dossier et y lancer des commandes, sans Internet. Il peut lire d’autres fichiers de l’ordinateur, sans pouvoir les modifier.{project.checkCommand ? ` Mino lancera ensuite « ${project.checkCommand.join(' ')} » pour contrôler.` : ''}</Text>}
      {inline && <Button title={advanced ? 'Masquer les réglages' : 'Ajuster la mission'} plain onPress={() => setAdvanced(!advanced)} />}
      {(!inline || advanced) && <>
      <Text style={[s.label, { marginTop: 14 }]}>{origin ? 'Ce que Mino a compris (modifiable)' : 'Ce qu’il faut faire'}</Text>
      <TextInput accessibilityLabel="Ce qu’il faut faire" value={goal} onChangeText={edit} multiline placeholder="Ex. Corrige le calcul du total et ajoute un test." placeholderTextColor="#00000066" style={[s.input, st.goal]} />
      <Text style={[s.label, { marginTop: 14 }]}>Qui s’en charge</Text>
      <View style={st.chips}>
        <Pressable accessibilityRole="radio" aria-checked={!coordinated} accessibilityState={{ selected: !coordinated }} onPress={() => setMode('direct')} style={[st.chip, !coordinated && st.chipOn]}>
          <Text style={[st.chipText, !coordinated && { color: '#fff' }]}>Un exécutant</Text>
        </Pressable>
        <Pressable accessibilityRole="radio" aria-checked={coordinated} accessibilityState={{ selected: coordinated, disabled: !leads.length }} disabled={!leads.length} onPress={() => setMode('coordinated')} style={[st.chip, coordinated && st.chipOn, !leads.length && { opacity: 0.4 }]}>
          <Text style={[st.chipText, coordinated && { color: '#fff' }]}>Avec un responsable{lead ? ` · ${lead.name}` : ''}</Text>
        </Pressable>
      </View>
      <Text style={s.muted}>{coordinated
        ? 'Le responsable découpe le travail et décide chaque étape ; des exécutants séparés les font l’une après l’autre. Utile pour plusieurs étapes séparables ou une relecture entre étapes, pas pour une correction courte.'
        : leads.length ? 'Un seul exécutant fait tout le travail. C’est le plus simple.' : 'Un seul exécutant fait tout le travail. Ajoute un autre bot pour pouvoir confier à un responsable.'}</Text>
      {coordinated && (
        <>
          <View style={st.chips}>
            {leads.map(l => (
              <Pressable key={l.id} accessibilityRole="radio" accessibilityLabel={`Responsable ${l.name}`} aria-checked={l.id === leadId} accessibilityState={{ selected: l.id === leadId }} onPress={() => setLeadId(l.id)} style={[st.chip, st.leadChip, l.id === leadId && st.chipOn]}>
                <Mascot shape={l.shape} color={l.color} size={22} />
                <Text style={[st.chipText, l.id === leadId && { color: '#fff' }]}>{l.name}</Text>
              </Pressable>
            ))}
          </View>
          {lead && <Text style={s.muted}>{lead.name} lit le dossier du projet en lecture seule, avec des règles dédiées. Ses souvenirs de conversation ne lui sont pas transmis.</Text>}
        </>
      )}
      {model ? <Text style={s.muted}>Modèle : {model}, réglage par défaut de Codex.</Text> : null}
      </>}
      {inline && !advanced && <Text style={s.muted}>Je vais organiser ce travail et suivre son résultat. Tu peux ajuster les détails si tu veux.</Text>}
      {message ? <Text style={st.warning}>{message}</Text> : null}
      <Button title={busy ? 'Envoi…' : 'Confier la mission'} solid disabled={disabled || busy || !project || !goal.trim() || (coordinated && !lead)} onPress={() => void submit()} />
      {back && <Button title="Retour" plain onPress={back} />}
    </View>
  );
}

export function MissionThread({ client, id, voice, open, back, inline = false, drafts }: { client: MissionsClient; id: string; voice: Voice; open(id: string): void; back?: (target: Screen) => void; inline?: boolean; drafts?: MissionDrafts }) {
  const { value: page, error } = usePoll<MissionPage>((after, signal) => client.mission(id, after, signal), [client, id]);
  const followup = useMissionFollowup(drafts, id);
  const { note, setNote, goalDraft, setGoalDraft, clearSentNote, clearSentGoal, busy, message } = followup;
  const [details, setDetails] = useState(false);
  const [sent, setSent] = useState(false);
  const act = async (command: MissionCommand, after?: () => void) => {
    if (!followup.begin()) return;
    const result = await client.send(command);
    followup.finish(result.ok ? '' : result.message);
    if (result.ok) after?.();
  };
  if (!page) return <Text accessibilityRole={error ? 'alert' : undefined} style={error ? st.warning : s.muted}>{error || 'Chargement de la mission…'}</Text>;
  const m = page.mission;
  const projectName = page.project?.name ?? 'le projet';
  if (m.mode === 'coordinated') return <Coordination followup={followup} m={m} projectName={projectName} busy={busy} message={message || error} act={act} open={open} back={() => back?.({ kind: 'list' })} inline={inline} voice={voice} />;
  const input = [...m.attempts].reverse().find(a => a.input)?.input ?? null;
  const goal = m.goals.at(-1);
  const work = latestWork(m);
  const review = latestReview(m);
  const live = m.live;
  return (
    <View>
      <View style={st.head}>
        {!inline && <Pressable accessibilityRole="button" accessibilityLabel={m.parent ? `Retour à ${m.parent.title}` : 'Retour aux missions'} onPress={() => back?.(backTarget(m))} hitSlop={10} style={st.back}>
          <Text style={st.backText} numberOfLines={1}>‹ {m.parent ? m.parent.title : 'Missions'}</Text>
        </Pressable>}
        <Pill status={m.status} />
      </View>
      {m.parent && (
        <View style={st.banner}>
          {m.parent.lead && <Mascot shape={m.parent.lead.shape} color={m.parent.lead.color} size={22} />}
          <Text style={[s.muted, { flex: 1 }]}>Confiée par {m.parent.lead?.name ?? 'le responsable'}{m.parent.decisionN ? ` · décision ${m.parent.decisionN}` : ''}{m.parent.current ? '' : ' · ancien objectif, ne sert plus de preuve'}</Text>
        </View>
      )}
      <Bubble voice={voice} text={minoSays(m, projectName)} alive={m.status === 'running'} />

      <View style={st.goalBox}>
        <Text style={s.label}>{projectName} · {m.tree ? `${m.tree.used} essais sur ${m.tree.max}, budget commun` : `essai ${m.attemptsUsed} sur ${m.maxAttempts}`}{m.goals.length > 1 ? ` · objectif v${goal?.rev}` : ''}</Text>
        <Text style={s.text}>{goal?.text}</Text>
        {m.goals.length > 1 && <Text style={s.muted}>{m.goals.length - 1} version{m.goals.length > 2 ? 's' : ''} précédente{m.goals.length > 2 ? 's' : ''} conservée{m.goals.length > 2 ? 's' : ''}.</Text>}
      </View>

      {live && (
        <View style={st.live}>
          <Text style={s.label}>{live.activity ?? 'En cours'}</Text>
          {!inline && live.text ? <Text style={s.text} numberOfLines={6}>{live.text}</Text> : null}
        </View>
      )}

      {work && !BUSY.has(work.state) && <Evidence attempt={work} compact={inline} />}
      {!inline && review?.state === 'completed' && review.finalText && (
        <View style={st.card}>
          <Text style={s.label}>Avis de relecture (lecture seule)</Text>
          <Text style={s.text} selectable>{plain(review.finalText)}</Text>
        </View>
      )}

      <Actions m={m} busy={busy} note={note} setNote={setNote} goalDraft={goalDraft} setGoalDraft={setGoalDraft} clearSentNote={clearSentNote} clearSentGoal={clearSentGoal} act={act} />
      {message || error ? <Text accessibilityRole="alert" style={st.warning}>{message || error}</Text> : null}

      {!inline && <>
      {input && (
        <Pressable accessibilityRole="button" onPress={() => setSent(!sent)} style={{ marginTop: 16 }}>
          <Text style={s.label}>{sent ? 'Consigne transmise à Codex' : 'Voir la consigne transmise à Codex'}</Text>
          {sent && <Text style={st.mono} selectable>{input}</Text>}
        </Pressable>
      )}

      <Text style={[s.title, { marginTop: 22 }]}>Fil de l’exécutant</Text>
      {m.eventsOmitted > 0 && <Text style={s.muted}>{m.eventsOmitted} évènements plus anciens enregistrés sur le PC.</Text>}
      {[...m.attempts].reverse().map((a, i) => <AttemptBlock key={a.id} attempt={a} events={m.events} latest={i === 0} />)}

      <Pressable accessibilityRole="button" onPress={() => setDetails(!details)} style={{ marginTop: 16 }}>
        <Text style={s.muted}>{details ? 'Masquer les détails' : 'Détails'}</Text>
      </Pressable>
      {details && (
        <View style={{ gap: 4, marginTop: 6 }}>
          <Text style={s.muted} selectable>Session Codex : {m.threadId ?? 'pas encore ouverte'}</Text>
          {m.attempts.map(a => <Text key={a.id} style={s.muted} selectable>Essai {a.n} : {a.model ?? 'modèle non annoncé'}{a.effort ? ` · effort ${a.effort}` : ''} · {a.sandbox === 'read-only' ? 'lecture seule' : 'écriture dans le dossier seulement, réseau coupé'} · {tokens(a)}</Text>)}
          {page.project && <Text style={s.muted} selectable>Dossier : {page.project.path}</Text>}
        </View>
      )}
      </>}
      {inline && <Button title="Détails de la mission" plain onPress={() => open(id)} />}
    </View>
  );
}

function Evidence({ attempt, compact = false }: { attempt: AttemptView; compact?: boolean }) {
  const observed = attempt.observed;
  return (
    <View style={st.card}>
      {attempt.errorMessage ? <Text style={[s.text, { fontWeight: '600' }]}>{attempt.errorMessage}</Text> : null}
      {!compact && attempt.finalText ? <>
        <Text style={s.label}>Rapport de l’exécutant</Text>
        <Text style={s.text} selectable>{plain(attempt.finalText)}</Text>
      </> : null}
      <Text style={[s.label, { marginTop: 12 }]}>Constaté par Mino dans le dossier</Text>
      {!observed ? <Text style={s.muted}>Vérification en cours…</Text>
        : observed.error ? <Text style={s.muted}>{observed.error}</Text>
          : observed.status.length === 0 ? <Text style={s.muted}>Aucun fichier modifié depuis le dernier commit.</Text>
            : <View style={{ gap: 2 }}>
              {observed.status.slice(0, 12).map(line => <Text key={line} style={st.mono}>{line.slice(0, 2).trim() === '??' ? '+ ' : '✎ '}{line.slice(3)}</Text>)}
              {observed.status.length > 12 && <Text style={s.muted}>et {observed.status.length - 12} autres</Text>}
              {observed.changedDuringAttempt.length > 0 && <Text style={s.muted}>{observed.changedDuringAttempt.length} changement{observed.changedDuringAttempt.length > 1 ? 's' : ''} apparu{observed.changedDuringAttempt.length > 1 ? 's' : ''} pendant cet essai.</Text>}
            </View>}
      {attempt.check && (
        <>
          <Text style={[s.label, { marginTop: 12 }]}>Contrôle</Text>
          <Text style={s.text}>{attempt.check.error ?? (attempt.check.exitCode === 0 ? `✓ « ${attempt.check.command.join(' ')} » réussit` : `✗ « ${attempt.check.command.join(' ')} » échoue (code ${attempt.check.exitCode})`)}</Text>
        </>
      )}
    </View>
  );
}

function Actions({ m, busy, note, setNote, goalDraft, setGoalDraft, clearSentNote, clearSentGoal, act }: {
  m: MissionDetail; busy: boolean; note: string; setNote(v: string): void;
  goalDraft: string | null; setGoalDraft(v: string | null): void;
  clearSentNote(sent: string): void; clearSentGoal(sent: string | null): void;
  act(command: MissionCommand, after?: () => void): Promise<void>;
}) {
  const id = m.id;
  const work = latestWork(m);
  const acceptId = m.can.accept;
  const budgetOut = m.attemptsUsed >= m.maxAttempts && !m.can.stop;
  return (
    <View style={{ marginTop: 14, gap: 4 }}>
      {acceptId && <Button title="Valider ce résultat" solid disabled={busy} onPress={() => void act({ type: 'mission.accept', missionId: id, attemptId: acceptId })} />}
      {m.can.stop && <Button title="Arrêter" disabled={busy} onPress={() => void act({ type: 'mission.stop', missionId: id })} />}
      {m.can.resume && <Button title="Reprendre après vérification" solid={!acceptId} disabled={busy} onPress={() => void act({ type: 'mission.resume', missionId: id })} />}
      {m.can.continue && (
        <View style={st.composer}>
          <TextInput accessibilityLabel="Précision pour la suite" value={note} onChangeText={setNote} placeholder={work?.goalRev !== m.goalRev ? 'Suite avec le nouvel objectif…' : 'Une précision pour la suite…'} placeholderTextColor="#00000066" multiline style={st.noteInput} />
          <Button title="Continuer" disabled={busy} onPress={() => void act({ type: 'mission.continue', missionId: id, note: note.trim() }, () => clearSentNote(note))} />
        </View>
      )}
      {m.can.review && <Button title="Demander une relecture" disabled={busy} onPress={() => void act({ type: 'mission.review', missionId: id })} />}
      {goalDraft === null
        ? m.can.revise && m.status !== 'accepted' && <Button title="Modifier l’objectif" plain disabled={busy} onPress={() => setGoalDraft(m.goals.at(-1)?.text ?? '')} />
        : (
          <View style={st.goalBox}>
            <Text style={s.label}>Nouvel objectif (version {m.goalRev + 1})</Text>
            <TextInput accessibilityLabel="Nouvel objectif" value={goalDraft} onChangeText={setGoalDraft} multiline style={[s.input, st.goal]} />
            <Text style={s.muted}>L’ancien résultat reste visible, mais il ne pourra plus être validé.</Text>
            <View style={s.row}>
              <Button title="Enregistrer et relancer" solid disabled={busy || !goalDraft.trim() || m.can.stop} onPress={() => void act({ type: 'mission.revise', missionId: id, goal: goalDraft.trim(), start: true }, () => clearSentGoal(goalDraft))} />
              <Button title="Enregistrer" disabled={busy || !goalDraft.trim()} onPress={() => void act({ type: 'mission.revise', missionId: id, goal: goalDraft.trim(), start: false }, () => clearSentGoal(goalDraft))} />
              <Button title="Annuler" plain onPress={() => setGoalDraft(null)} />
            </View>
          </View>
        )}
      {budgetOut && m.can.budget && m.status !== 'accepted' && (
        <View>
          <Text style={s.muted}>Les {m.maxAttempts} essais prévus sont utilisés.</Text>
          <Button title="Accorder deux essais de plus" disabled={busy} onPress={() => void act({ type: 'mission.budget', missionId: id })} />
        </View>
      )}
    </View>
  );
}

function AttemptBlock({ attempt, events, latest }: { attempt: AttemptView; events: MissionDetail['events']; latest: boolean }) {
  const ended = !BUSY.has(attempt.state);
  const items = lines(events, attempt.id, ended);
  const [open, setOpen] = useState(latest);
  const shown = open ? items : items.slice(-3);
  return (
    <View style={st.attempt}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={s.row}>
        <Text style={st.rowTitle}>{attemptTitle(attempt)}</Text>
        <Text style={s.muted}>{STATE[attempt.state]}{attempt.goalRev ? ` · objectif v${attempt.goalRev}` : ''}</Text>
      </Pressable>
      {!open && items.length > 3 && <Text style={s.muted}>{items.length - 3} étapes masquées · toucher pour tout voir</Text>}
      {shown.map(line => (
        <View key={line.key} style={st.line}>
          {line.icon ? <Text style={st.icon}>{line.icon}</Text> : null}
          <View style={{ flex: 1 }}>
            <Text style={[line.mono ? st.mono : s.text, line.strong && { fontWeight: '600' }]} numberOfLines={line.mono && !open ? 2 : undefined}>{line.text}</Text>
            {line.detail ? <Text style={s.muted}>{line.detail}</Text> : null}
          </View>
        </View>
      ))}
      {items.length === 0 && <Text style={s.muted}>{ended ? 'Aucune action enregistrée.' : 'En attente de la première action…'}</Text>}
    </View>
  );
}

const STATE: Record<AttemptView['state'], string> = {
  queued: 'en attente', running: 'en cours', verifying: 'contrôle par Mino', stopping: 'arrêt demandé', completed: 'terminé', failed: 'échoué', stopped: 'arrêté', interrupted: 'résultat inconnu',
};
const BUSY: ReadonlySet<AttemptView['state']> = new Set(['queued', 'running', 'verifying', 'stopping']);

const st = StyleSheet.create({
  content: { paddingRight: 10 },
  mino: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginVertical: 16, padding: 16, backgroundColor: '#f6f8f3', borderRadius: 20 },
  voiceName: { fontSize: 12, lineHeight: 18, fontWeight: '600', color: '#53743b', marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, marginTop: 10, borderWidth: 1, borderRadius: 20, borderColor: '#e5e5e5', backgroundColor: '#fff' },
  rowTitle: { fontSize: 15, fontWeight: '600', color: '#000', flexShrink: 1 },
  pill: { fontSize: 11, fontWeight: '500', flexShrink: 0, color: '#626262', borderWidth: 1, borderColor: '#e5e5e5', backgroundColor: '#f7f7f7', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden' },
  pillStrong: { backgroundColor: '#fff6df', borderColor: '#f0e0b8', color: '#80601a' },
  pillDone: { backgroundColor: '#f0f7ec', borderColor: '#dce9d4', color: '#49653a' },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  back: { minHeight: 40, justifyContent: 'center' },
  backText: { fontSize: 14, fontWeight: '500', color: '#626262' },
  goalBox: { borderWidth: 1, borderColor: '#e5e5e5', backgroundColor: '#fafafa', borderRadius: 20, padding: 16, gap: 7, marginTop: 8 },
  goal: { minHeight: 96, textAlignVertical: 'top' },
  live: { borderLeftWidth: 2, borderColor: '#85bd56', backgroundColor: '#f6f8f3', padding: 14, borderRadius: 12, marginTop: 14, gap: 4 },
  card: { borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 20, padding: 16, marginTop: 16, gap: 6 },
  attempt: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#e5e5e5', paddingVertical: 14, gap: 8 },
  line: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  icon: { width: 16, fontSize: 13, lineHeight: 19, color: '#000', textAlign: 'center' },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 19, color: '#000' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 8 },
  chip: { borderWidth: 1, borderColor: '#e2e2e2', borderRadius: 22, paddingHorizontal: 15, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  chipOn: { backgroundColor: '#202020', borderColor: '#202020' },
  leadChip: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  chipText: { fontSize: 14, fontWeight: '600', color: '#000' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: 1, borderColor: '#e5e5e5', backgroundColor: '#fafafa', borderRadius: 22, paddingLeft: 14, paddingRight: 4, paddingVertical: 2, gap: 6 },
  noteInput: { flex: 1, minHeight: 44, maxHeight: 120, fontSize: 16, color: '#000', paddingVertical: 12 },
  warning: { fontSize: 14, lineHeight: 21, color: '#80601a', backgroundColor: '#fff8e8', borderRadius: 12, padding: 12, marginVertical: 8 },
});
