import { readableError } from "./src/errors";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Crypto from "expo-crypto";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Controller, parseGrant, type Draft } from "./src/controller";
import { allowDevWeb, storage, transport, browserAccess } from "./src/platform";
import {
  CommandSchema,
  type MobileSnapshot,
} from "./src/generated/mobile-protocol";
import { editDraft, insertMention } from "./src/mentions";
import { Button, Code, Field, Mascot, Sheet, s, useMotion } from "./src/ui";
import { CreateBot, Profile, Work, type Dispatch } from "./src/details";
import { BotFan } from "./src/BotFan";
import { ChatIcon, ChatIconButton, ChatComposer, ChatActivity, chatStyles } from './src/chat';
import { useChatViewport } from './src/chat-viewport';
import { ChatMarkdown } from './src/ChatMarkdown';
import { ThreadList } from './src/ThreadList';
import { createMissionsClient, missionDrafts } from './src/missions/client';
import { MissionsSheet, useMissionsView } from './src/missions/Missions';
import { HandoffCard, MissionChatCard } from './src/missions/HandoffCard';
import type { AgentsView } from './src/generated/agent-protocol';
import type { MissionDrafts } from './src/missions/client';
const controller = new Controller(storage, transport, allowDevWeb);
const missionsClient = createMissionsClient(storage, transport, () => Crypto.randomUUID());
type Panel =
  | "fan"
  | "threads"
  | "missions"
  | "guests"
  | "profile"
  | "create"
  | "activity"
  | "carnet"
  | "outbox"
  | "connection"
  | { kind: "work"; workId: string }
  | { kind: "mission"; missionId: string }
  | { kind: "botThread"; botId: string }
  | null;
export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}
function Main() {
  const [, redraw] = useState(0);
  const [ready, setReady] = useState(false);
  const [connectRequest, setConnectRequest] = useState(0);
  const connectNonce = useRef(0);
  const sendingDraft = useRef<Draft | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const panelParents = useRef<Panel[]>([]);
  const openPanel = (next: Panel) => { panelParents.current.push(panel); setPanel(next); };
  const closePanel = () => setPanel(panelParents.current.pop() ?? null);
  const goToChat = () => { panelParents.current = []; setPanel(null); };
  const [error, setError] = useState("");
  const [reviewer, setReviewer] = useState<string | undefined>();
  const [expandedMissionId, setExpandedMissionId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const refreshAbort = useRef<AbortController | null>(null);
  const list = useRef<FlatList<MobileSnapshot['messages'][number]>>(null);
  const followBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const motion = useMotion();
  const viewport = useChatViewport();
  const insets = useSafeAreaInsets();
  useEffect(() => controller.subscribe(() => redraw((n) => n + 1)), []);
  useEffect(() => {
    if (!browserAccess) return;
    const consume = () => {
      if (location.hash !== '#connect') return;
      const clean = new URL(location.href); clean.hash = ''; clean.searchParams.delete('launch');
      history.replaceState(null, '', clean.pathname + clean.search);
      if (controller.local.snapshot || controller.connection.kind === 'online') return;
      setConnectRequest(++connectNonce.current);
    };
    consume();
    window.addEventListener('hashchange', consume);
    return () => window.removeEventListener('hashchange', consume);
  }, []);
  useEffect(() => {
    void controller
      .boot()
      .catch((e) => setError(readableError(e)))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      if (stopped || AppState.currentState !== "active") return;
      const abort = new AbortController();
      refreshAbort.current = abort;
      await controller.refresh(abort.signal);
      failures =
        controller.connection.kind === "offline"
          ? Math.min(5, failures + 1)
          : 0;
      if (!stopped && AppState.currentState === "active")
        timer = setTimeout(
          () => void tick(),
          Math.min(30000, 2000 * 2 ** failures),
        );
    };
    void tick();
    const sub = AppState.addEventListener("change", (state) => {
      clearTimeout(timer);
      controller.pause();
      refreshAbort.current?.abort();
      if (state === "active") void tick();
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.pause();
      refreshAbort.current?.abort();
      sub.remove();
    };
  }, [ready]);
  const send: Dispatch = async (input) => {
    try {
      const command = CommandSchema.parse({
        ...input,
        requestId: Crypto.randomUUID(),
      });
      await controller.enqueue(command);
      setError("");
      await controller.refresh();
    } catch (e) {
      setError(readableError(e));
    }
  };
  const local = controller.local;
  const snapshot = local.snapshot;
  const drafts = useMemo(() => missionDrafts(storage, snapshot?.spaceId ?? 'unconnected'), [snapshot?.spaceId]);
  const bot = snapshot?.bots.find((b) => b.id === 'mino');
  const { value: missionsView, error: missionsError } = useMissionsView(missionsClient, snapshot?.spaceId);
  useEffect(() => {
    if (bot && local.selected !== bot.id) void controller.select(bot.id).catch(e => setError(readableError(e)));
  }, [snapshot?.spaceId, bot?.id, local.selected]);
  useEffect(() => { setExpandedMissionId(null); }, [snapshot?.spaceId]);
  useEffect(() => { followBottom.current = true; setShowLatest(false); }, [bot?.id]);
  const draft: Draft = local.drafts[bot?.id ?? 'mino'] ?? {
    text: "",
    mentions: [],
  };
  const online = controller.connection.kind === "online";
  useEffect(() => {
    if (ready && connectRequest && (snapshot || online)) setConnectRequest(0);
  }, [ready, connectRequest, snapshot, online]);
  const messages =
    snapshot?.messages.filter((m) => m.threadBotId === bot?.id) ?? [];
  const canApprove =
    online &&
    !local.queue.length &&
    !Object.values(local.drafts).some((d) => d.text.trim());
  const saveDraft = (value: Draft) => {
    void controller
      .setDraft(bot?.id ?? 'mino', value)
      .catch((e) => setError(readableError(e)));
  };
  const say = async () => {
    if (!bot || !draft.text.trim() || sendingDraft.current === draft) return;
    sendingDraft.current = draft;
    const leading = draft.text.length - draft.text.trimStart().length;
    const captured = draft;
    const normalized = {
      text: draft.text.trim(),
      mentions: draft.mentions.map((m) => ({
        ...m,
        start: m.start - leading,
        end: m.end - leading,
      })),
    };
    try {
      followBottom.current = true;
      await controller.enqueue(
        {
          type: "message.say",
          requestId: Crypto.randomUUID(),
          botId: bot.id,
          text: normalized.text,
          attachments: [],
          ...(normalized.mentions.length
            ? { mentions: normalized.mentions }
            : {}),
          ...(reviewer ? { reviewerBotId: reviewer } : {}),
        },
        captured,
      );
      setReviewer(undefined);
      await controller.refresh();
    } catch (e) {
      setError(readableError(e));
    } finally {
      if (sendingDraft.current === captured) sendingDraft.current = null;
    }
  };
  const connectionLabel =
    controller.connection.kind === "online"
      ? "● Mon ordinateur"
      : controller.connection.kind === "offline"
        ? controller.connection.message
        : controller.connection.kind === "pairing"
          ? "Confirmation sur le PC requise"
          : "Associer votre PC";
  const work =
    typeof panel === "object" && panel?.kind === "work"
      ? snapshot?.works.find((w) => w.id === panel.workId)
      : undefined;
  const narrator = snapshot?.bots.find(b => b.id === 'mino');
  const detailBot = typeof panel === 'object' && panel?.kind === 'botThread' ? snapshot?.bots.find(b => b.id === panel.botId) : undefined;
  const voice = { name: narrator?.name ?? 'Mino', shape: narrator?.shape ?? 'sprout', color: narrator?.color ?? '#8de343' };
  const proposalIds = new Set(snapshot?.messages.filter(m => m.handoff && m.botId === 'mino' && m.threadBotId === 'mino').map(m => m.id));
  const otherMissions = missionsView?.missions.filter(m => !m.parentId && (!m.originMessageId || !proposalIds.has(m.originMessageId))).slice(0, 3) ?? [];
  const chatWorks = snapshot?.works.filter(w => w.threadBotId === bot?.id && !w.taskId) ?? [];
  const activeChat = chatWorks.find(w => w.state === 'running') ?? chatWorks.find(w => w.state === 'pending');
  const activeActor = snapshot?.bots.find(b => b.id === activeChat?.botId);
  return (
    <SafeAreaView edges={['top','left','right']} style={[s.page, viewport.kind === 'web' && { position: 'absolute', height: viewport.height, top: viewport.top, left: 0, right: 0 }]}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={[s.page, { width: '100%', maxWidth: 760, alignSelf: 'center' }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={chatStyles.header}>
          <View style={{ width: 88 }}><ChatIconButton icon="back" label="Conversations" onPress={() => openPanel('threads')} /></View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Profil de Mino. Appui long pour voir les autres bots."
            onPress={() => openPanel("profile")}
            onLongPress={() => openPanel("fan")}
            style={[chatStyles.headerProfile, { flex: 1 }]}
          >
            <Mascot
              shape={bot?.shape ?? "sprout"}
              color={bot?.color ?? "#8de343"}
              size={36}
              alive={online}
            />
            <Text numberOfLines={1} style={chatStyles.headerTitle}>{bot?.name ?? (snapshot ? 'Mino absent' : 'Mino')}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', width: 88 }}>
            <ChatIconButton icon="computer" label={online ? 'Ordinateur connecté' : 'Ordinateur hors ligne'} badge={online} onPress={() => openPanel('connection')} />
            <ChatIconButton icon="more" label="Activité" onPress={() => openPanel('activity')} />
          </View>
        </View>
        {!online && snapshot && <Pressable accessibilityRole="button" onPress={() => openPanel('connection')} style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
          <Text style={chatStyles.connectionText}>
            {connectionLabel}
            {!online && local.lastSeen ? ` · ${new Date(local.lastSeen).toLocaleTimeString()}` : ""}
          </Text>
        </Pressable>}
        {!!error && (
          <Pressable onPress={() => setError("")} style={s.content}>
            <Text accessibilityRole="alert" style={s.text}>
              {error}
            </Text>
            <Text style={s.muted}>Toucher pour masquer</Text>
          </Pressable>
        )}
        {!snapshot ? (
          <ScrollView
            contentContainerStyle={s.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[s.heading, { marginVertical: 24 }]}>
              Vos bots, avec vous.
            </Text>
            <Text style={s.text}>
              Discutez ici. Votre PC exécute les tâches et conserve les
              résultats.
            </Text>
            <Pairing
              connectRequest={ready ? connectRequest : 0}
              onConnectHandled={() => setConnectRequest(0)}
              changed={() => void controller.refresh()}
              report={setError}
            />
            {controller.connection.kind === "revoked" && (
              <Text style={s.text}>{controller.connection.message}</Text>
            )}
          </ScrollView>
        ) : (
          <>
            <View style={{ flex: 1, minHeight: 0 }}>
            <FlatList
              ref={list}
              onScroll={event => { const e=event.nativeEvent; const near=e.contentSize.height-e.layoutMeasurement.height-e.contentOffset.y<90; followBottom.current=near; setShowLatest(!near); }}
              scrollEventThrottle={100}
              onContentSizeChange={() => { if (followBottom.current) requestAnimationFrame(()=>{ if (followBottom.current) list.current?.scrollToEnd({animated:motion}); }); }}
              data={messages}
              keyExtractor={(m) => m.id}
              onLayout={() => { if (followBottom.current) requestAnimationFrame(() => { if (followBottom.current) list.current?.scrollToEnd({ animated: false }); }); }}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              contentContainerStyle={chatStyles.list}
              ListFooterComponent={<>
                {online && activeChat && <ChatActivity name={activeActor?.name ?? 'Mino'} stage={activeChat.state === 'pending' ? 'pending' : activeChat.attempt?.stage === 'writing' ? 'writing' : 'running'} />}
                {missionsError && <Text accessibilityRole="alert" style={[s.muted, { marginVertical: 12 }]}>Je n’arrive pas à actualiser les missions. {missionsError}</Text>}
                {bot && otherMissions.map(m => <MissionChatCard drafts={drafts} key={m.id} mission={m} client={missionsClient} voice={voice} expandedId={expandedMissionId} expand={setExpandedMissionId} details={id => openPanel({ kind: 'mission', missionId: id })} />)}
              </>}
              ListEmptyComponent={
                <View
                  style={chatStyles.empty}
                >
                  <Mascot shape={bot?.shape ?? "sprout"} color={bot?.color ?? "#8de343"} size={112} alive={online} />
                  <Text style={chatStyles.emptyTitle}>{bot ? 'Qu’est-ce qu’on fait ?' : 'Mino n’est plus dans cet espace'}</Text>
                  {!bot && <><Text style={s.muted}>Les autres bots et leurs conversations sont conservés dans les détails.</Text><Button title="Voir les conversations" onPress={() => openPanel('threads')} /></>}
                </View>
              }
              renderItem={({ item }) => (
                <Message
                  enter={controller.newMessageIds.has(item.id)}
                  motion={motion}
                  item={item}
                  snapshot={snapshot}
                  openWork={(id) => openPanel({ kind: "work", workId: id })}
                  missions={{ view: missionsView, error: missionsError, drafts, expandedId: expandedMissionId, expand: setExpandedMissionId, details: id => openPanel({ kind: 'mission', missionId: id }) }}
                />
              )}
            />
            {showLatest && <View style={chatStyles.latest}><ChatIconButton icon="arrowDown" label="Aller en bas" onPress={()=>{followBottom.current=true;setShowLatest(false);list.current?.scrollToEnd({animated:motion});}} /></View>}
            </View>
            {!!local.queue.length && (
              <Pressable
                onPress={() => openPanel("outbox")}
                style={{ paddingHorizontal: 20, paddingVertical: 8 }}
              >
                <Text style={s.muted}>
                  {local.queue.length} envoi(s) en attente ·{" "}
                  {local.queue.some((p) => p.state === "unknown")
                    ? "réponse inconnue, reçu PC non confirmé"
                    : "conservé sur cet appareil"}
                </Text>
              </Pressable>
            )}
            <ChatComposer value={draft.text} botName={bot?.name ?? 'Mino'} enabled={!!bot}
              onChange={text => saveDraft(editDraft(draft, text))} onSelectionChange={setCursor}
              onSend={() => void say()} onInvite={() => openPanel('guests')}
              stop={online && activeChat ? () => send({ type: 'work.cancel', workId: activeChat.id }) : undefined}
              reviewerName={snapshot.bots.find(b => b.id === reviewer)?.name}
              onRemoveReviewer={() => setReviewer(undefined)} bottomInset={viewport.keyboardOpen ? 0 : insets.bottom} />
          </>
        )}
        {snapshot && <ThreadList key={snapshot.spaceId} visible={panel === 'threads'} snapshot={snapshot} online={online} client={missionsClient}
          close={closePanel} activity={() => openPanel('activity')} connection={() => openPanel('connection')}
          createBot={() => openPanel('create')} openMissions={() => openPanel('missions')}
          choose={row => {
            if (row.kind === 'mission') { openPanel({ kind: 'mission', missionId: row.missionId }); return; }
            if (row.botId === 'mino') goToChat();
            else openPanel({ kind: 'botThread', botId: row.botId });
          }} />}
        {snapshot && (panel === 'missions' || typeof panel === 'object' && panel?.kind === 'mission') && <MissionsSheet
          key={snapshot.spaceId + ':' + (typeof panel === 'object' && panel?.kind === 'mission' ? panel.missionId : 'missions')} client={missionsClient}
          close={closePanel} initialMissionId={typeof panel === 'object' && panel?.kind === 'mission' ? panel.missionId : undefined}
          leads={snapshot.bots.filter(b => b.id !== 'mino')} drafts={drafts}
          voice={voice} />}
        {panel === "fan" && snapshot && <BotFan bots={snapshot.bots} close={closePanel} choose={id => { if (id === 'mino') goToChat(); else openPanel({ kind: 'botThread', botId: id }); }} />}
        {detailBot && snapshot && <Sheet title={`Conversation avec ${detailBot.name}`} close={closePanel}>
          <Text style={s.muted}>Ce fil est conservé dans les détails. Pour poursuivre une demande, parle à Mino dans le chat principal.</Text>
          {snapshot.messages.filter(m => m.threadBotId === detailBot.id).map(item => <Message key={item.id} enter={false} motion={false} item={item} snapshot={snapshot} openWork={id => openPanel({ kind: 'work', workId: id })} />)}
        </Sheet>}
        {panel && panel !== "fan" && panel !== "threads" && panel !== "missions" && !(typeof panel === "object" && (panel.kind === "mission" || panel.kind === "botThread")) && (
          <Sheet
            title={
              typeof panel === "object"
                ? "Résultat"
                : {
                    guests: "Inviter un bot",
                    profile: "Profil",
                    create: "Nouveau bot",
                    activity: "Activité",
                    carnet: "Carnet local",
                    outbox: "Envois",
                    connection: "Votre PC",
                  }[panel]
            }
            close={closePanel}
          >
            {panel === "guests" &&
              snapshot?.bots
                .filter((b) => b.id !== bot?.id)
                .map((b) => (
                  <View key={b.id} style={s.card}>
                    <View style={s.row}>
                      <Mascot shape={b.shape} color={b.color} />
                      <Text style={s.title}>{b.name}</Text>
                    </View>
                    <Button
                      title={`Inviter @${b.name} dans le chat`}
                      onPress={() => {
                        saveDraft(
                          insertMention(
                            draft,
                            b,
                            Math.min(cursor, draft.text.length),
                          ),
                        );
                        goToChat();
                      }}
                    />
                    <Button
                      title={`Choisir ${b.name} pour une relecture explicite`}
                      onPress={() => {
                        setReviewer(b.id);
                        goToChat();
                      }}
                    />
                  </View>
                ))}
            {panel === "profile" && bot && snapshot && (
              <Profile key={bot.id} bot={bot} snapshot={snapshot} send={send} />
            )}
            {panel === "create" && <CreateBot send={send} />}
            {panel === "activity" && (
              <View>
                <Button title="Missions des exécutants" onPress={() => openPanel("missions")} />
                <Button title="Carnet local" onPress={() => openPanel("carnet")} />
                {snapshot?.works.map((w) => (
                  <View key={w.id} style={s.card}>
                    <Text style={s.title}>{w.title}</Text>
                    <Text style={s.muted}>
                      {snapshot.bots.find((b) => b.id === w.botId)?.name ??
                        "Bot supprimé"}{" "}
                      · {w.state} · {w.attempt?.stage ?? ""}
                    </Text>
                    <Button
                      title="Ouvrir le résultat et la tâche"
                      onPress={() => openPanel({ kind: "work", workId: w.id })}
                    />
                  </View>
                ))}
                {!snapshot?.works.length && (
                  <Text style={s.text}>Aucun travail reçu du PC.</Text>
                )}
              </View>
            )}
            {work && snapshot && (
              <Work
                key={work.id}
                work={work}
                snapshot={snapshot}
                send={send}
                canApprove={canApprove}
              />
            )}
            {panel === "carnet" && (
              <View>
                {snapshot?.carnet.map((item) => (
                  <View key={item.id} style={s.card}>
                    <Text style={s.title}>
                      {item.title} · v{item.versionN}
                    </Text>
                    <Code text={item.body} />
                    <Text style={s.muted}>
                      Publication locale sur le PC · {item.createdAt}
                    </Text>
                  </View>
                ))}
                {!snapshot?.carnet.length && (
                  <Text style={s.text}>Aucune publication locale.</Text>
                )}
              </View>
            )}
            {panel === "outbox" &&
              local.queue.map((p) => (
                <View key={p.command.requestId} style={s.card}>
                  <Text style={s.title}>
                    {p.command.type} · {p.state}
                  </Text>
                  <Text style={s.text}>
                    {p.message ??
                      "Un envoi sans réponse ne prouve pas son échec. Le même identifiant empêche une nouvelle intention."}
                  </Text>
                  <Code text={p.bytes} />
                  <Button
                    title="Réessayer les mêmes octets et le même identifiant"
                    disabled={!online}
                    onPress={() =>
                      void controller
                        .retry(p.command.requestId)
                        .then(() => controller.refresh())
                    }
                  />
                  <Button
                    title="Retirer de la file locale"
                    onPress={() => void controller.discard(p.command.requestId)}
                  />
                  <Text style={s.muted}>
                    Retirer ne peut pas annuler une commande déjà reçue par le
                    PC.
                  </Text>
                </View>
              ))}
            {panel === "connection" && (
              <View>
                <Text style={s.text}>{connectionLabel}</Text>
                <Text style={s.muted}>
                  Un délai réseau ne permet pas de savoir si le PC est éteint.
                </Text>
                {!snapshot && (
                  <Pairing
                    changed={() => void controller.refresh()}
                    report={setError}
                  />
                )}
                <Button
                  title="Actualiser"
                  onPress={() => void controller.refresh()}
                />
                <Button
                  title="Déconnecter cet appareil"
                  onPress={() => {
                    void (async () => {
                      if (browserAccess) await browserAccess.forget();
                      await controller.forget(browserAccess ? 'Cet appareil est déconnecté.' : undefined);
                      goToChat();
                    })().catch((e: unknown) => setError(readableError(e)));
                  }}
                />
                {Platform.OS === "web" && (
                  <Text style={s.muted}>
                    {browserAccess ? 'Accès Safari conservé par un cookie sécurisé. Retirable depuis le PC.' : 'Aperçu local. La connexion disparaît au rechargement.'}
                  </Text>
                )}
              </View>
            )}
          </Sheet>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
function Pairing({
  changed,
  report,
  connectRequest = 0,
  onConnectHandled,
}: {
  changed(): void;
  report(text: string): void;
  connectRequest?: number;
  onConnectHandled?(): void;
}) {
  const [raw, setRaw] = useState("");
  const [deviceName, setDeviceName] = useState("Mon téléphone");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const busy = useRef(false);
  const attempted = useRef(0);
  const claim = async (value: string) => {
    if (busy.current) return;
    busy.current = true;
    setScanning(false);
    try {
      const grant = parseGrant(value, allowDevWeb);
      const token = Array.from(await Crypto.getRandomBytesAsync(32), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
      await controller.pair(grant, {
        deviceId: Crypto.randomUUID(),
        deviceName,
        deviceToken: token,
      });
      setRaw("");
      changed();
    } catch (e) {
      report(readableError(e));
    } finally {
      busy.current = false;
    }
  };
  const claimBrowser = async () => {
    if (!browserAccess || busy.current) return;
    busy.current = true;
    try {
      const session = await browserAccess.claim(deviceName);
      await controller.connectBrowser(session);
      changed();
    } catch (error) { report(readableError(error)); }
    finally { busy.current = false; }
  };
  useEffect(() => {
    if (!browserAccess || !connectRequest || attempted.current >= connectRequest) return;
    attempted.current = connectRequest;
    onConnectHandled?.();
    if (controller.connection.kind === 'pairing' || controller.connection.kind === 'online') return;
    void claimBrowser();
  }, [connectRequest]);
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={s.title}>Associer le PC</Text>
      <Text style={s.text}>
        {browserAccess ? controller.connection.kind === 'pairing' ? 'Ta demande est arrivée sur l’ordinateur.' : 'Sur le PC, affiche le QR et scanne-le avec l’appareil photo de ton téléphone.' : 'Ouvrez l’association dans Mino sur votre PC. Scannez le QR, puis confirmez le nom et le code sur le PC.'}
      </Text>
      {controller.connection.kind === "pairing" && (
        <View style={s.card}>
          <Text style={s.heading}>
            {controller.connection.confirmCode || "En attente du PC…"}
          </Text>
          <Text style={s.text}>
            {browserAccess ? 'Sur le PC, clique sur « Connecter ce téléphone » si le même code est affiché. Aucun code à taper.' : 'Vérifiez ce code sur le PC avant d’accepter l’appareil.'}
          </Text>
          <Button title="Vérifier la confirmation" onPress={changed} />
        </View>
      )}
      {(!browserAccess || controller.connection.kind !== 'pairing') && <Field
        label="Nom de cet appareil"
        value={deviceName}
        onChange={setDeviceName}
      />}
      {browserAccess ? (
        controller.connection.kind !== 'pairing' && <Button title="Demander l’accès au PC" solid disabled={!deviceName.trim()} onPress={() => void claimBrowser()} />
      ) : <>
      <Button
        title="Scanner le QR"
        onPress={() => {
          void requestPermission().then((result) => {
            if (result.granted) setScanning(true);
            else report("Caméra refusée. Collez le JSON du QR ci-dessous.");
          });
        }}
      />
      {scanning && permission?.granted && (
        <View>
          <CameraView
            style={{ height: 260 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(event) => void claim(event.data)}
          />
          <Button
            title="Arrêter la caméra"
            onPress={() => setScanning(false)}
          />
        </View>
      )}
      <Field
        label="JSON du QR ou URI manuelle"
        value={raw}
        onChange={setRaw}
        multiline
      />
      <Button
        title="Associer cet appareil"
        solid
        disabled={!raw.trim() || !deviceName.trim()}
        onPress={() => void claim(raw)}
      />
      <Text style={s.muted}>
        HTTPS requis. Ne collez jamais les secrets d’association dans une
        conversation.
      </Text>
      </>}
    </View>
  );
}
function Message({
  item,
  snapshot,
  openWork,
  missions,
  enter,
  motion,
}: {
  enter: boolean;
  motion: boolean;
  item: MobileSnapshot["messages"][number];
  snapshot: MobileSnapshot;
  openWork(id: string): void;
  missions?: { view: AgentsView | null; error: string; drafts: MissionDrafts; expandedId: string | null; expand(id: string | null): void; details(id: string): void };
}) {
  const actor = snapshot.bots.find((b) => b.id === item.botId);
  const opacity = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const entered = useRef(false);
  useEffect(() => {
    if (enter && !entered.current) {
      entered.current = true;
      if (!motion) return;
      opacity.setValue(0);
      lift.setValue(6);
      const animation = Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(lift, { toValue: 0, duration: 220, useNativeDriver: Platform.OS !== 'web' }),
      ]);
      animation.start();
      return () => { animation.stop(); opacity.setValue(1); lift.setValue(0); };
    }
  }, [enter, motion, opacity, lift]);
  const user = item.role === 'user';
  const related = user ? snapshot.works.filter(w => w.requestMessageId === item.id && (w.taskId || w.versions.length || w.state === 'failed' || w.state === 'cancelled')) : [];
  const labels = { pending: 'En attente', running: 'En cours', review: 'À valider', done: 'Terminé', failed: 'Échoué', cancelled: 'Annulé' };
  return (
    <Animated.View
      testID="chat-message"
      style={[user ? chatStyles.userMessage : chatStyles.assistantMessage, { opacity, transform: [{ translateY: lift }] }]}
    >
      {user ? <View style={chatStyles.userBubble}><Text selectable style={chatStyles.userText}>{item.text}</Text></View> : <>
        <View style={chatStyles.assistantHeader}>
          {actor && <Mascot shape={actor.shape} color={actor.color} size={23} />}
          <Text style={chatStyles.assistantName}>{actor?.name ?? 'Bot supprimé'}{item.botId !== item.threadBotId ? ' · invité' : ''}</Text>
        </View>
        <ChatMarkdown text={item.text} color="#000" />
        {missions && item.handoff && item.botId === 'mino' && item.threadBotId === 'mino' && <HandoffCard handoff={item.handoff}
          origin={{ messageId: item.id, text: snapshot.messages.find(m => m.id === snapshot.works.find(w => w.id === item.workId)?.requestMessageId)?.text ?? '' }}
          view={missions.view} error={missions.error} drafts={missions.drafts} client={missionsClient} leads={snapshot.bots.filter(b => b.id !== 'mino')}
          voice={{ name: actor?.name ?? 'Mino', shape: actor?.shape ?? 'sprout', color: actor?.color ?? '#8de343' }}
          expandedId={missions.expandedId} expand={missions.expand} details={missions.details} />}
      </>}
      {item.attachments.map((a, i) => (
        <Text key={`${a.name}-${i}`} style={chatStyles.messageMeta}>
          {a.name} · {a.chars} caractères
        </Text>
      ))}
      {related.map(w => <View key={w.id} style={{ width: '100%', marginTop: 12 }}>
        {w.state === 'failed' && <Text accessibilityRole="alert" style={[chatStyles.messageMeta, { color: '#b42318' }]}>{w.attempt?.error ?? 'La réponse a échoué.'}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`Voir le travail : ${w.title}`} onPress={() => openWork(w.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 16, padding: 14 }}>
          <ChatIcon name="document" />
          <View style={{ flex: 1 }}><Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '600', color: '#000' }}>{w.versions.at(-1)?.title || w.title || 'Travail'}</Text><Text style={chatStyles.messageMeta}>{labels[w.state]}{w.versions.length ? ` · v${w.versions.at(-1)?.n}` : ''}</Text></View>
          <ChatIcon name="chevron" size={16} />
        </Pressable>
      </View>)}
    </Animated.View>
  );
}
