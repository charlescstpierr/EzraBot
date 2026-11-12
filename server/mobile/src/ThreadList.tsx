import React, { useEffect, useMemo, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MobileSnapshot } from './generated/mobile-protocol';
import type { AgentsView } from './generated/agent-protocol';
import type { MissionsClient } from './missions/client';
import { RemoteError } from './controller';
import { Mascot, useMotion } from './ui';
import { ChatIcon, ChatIconButton } from './chat';
import { filterThreads, projectThreads, type ThreadRow, type ThreadFilter } from './threads';

const filters: { id: ThreadFilter; label: string }[] = [
  { id: 'all', label: 'Tous' }, { id: 'attention', label: 'Votre avis' },
  { id: 'working', label: 'En cours' }, { id: 'done', label: 'Terminés' },
];

export function ThreadList({ visible, snapshot, online, client, choose, close, activity, connection, createBot, openMissions }: {
  visible: boolean; snapshot: MobileSnapshot; online: boolean; client: MissionsClient;
  choose(row: ThreadRow): void; close(): void; activity(): void; connection(): void;
  createBot(): void; openMissions(): void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [view, setView] = useState<AgentsView | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const motion = useMotion();
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!visible || !online || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision: number | null = null;
    const read = async () => {
      try {
        const next = await client.view(revision, controller.signal);
        if (controller.signal.aborted) return;
        setView(next); setError(''); revision = next.rev;
        timer = setTimeout(() => void read(), 50);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof RemoteError && e.status === 404
          ? 'Les missions ne sont pas encore disponibles sur ce PC.'
          : e instanceof Error ? e.message : 'Les projets ne sont pas disponibles pour le moment.');
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, visible, online, active, retry]);
  const rows = useMemo(() => filterThreads(projectThreads(snapshot, view), query, filter), [snapshot, view, query, filter]);
  const sections = [
    { title: 'Votre fil principal', rows: rows.filter(r => r.kind === 'conversation' && r.primary) },
    { title: 'Conversations des bots', rows: rows.filter(r => r.kind === 'conversation' && !r.primary) },
    { title: 'Fils de projet · missions', rows: rows.filter(r => r.kind === 'mission') },
  ];
  const mino = snapshot.bots.find(b => b.id === 'mino');
  return <Modal visible={visible} animationType={motion ? 'slide' : 'none'} onRequestClose={close}>
    <SafeAreaView style={st.page}>
      <View style={st.frame}>
        <View style={st.top}>
          <View style={st.brand}>{mino && <Mascot shape={mino.shape} color={mino.color} size={32} />}<Text style={st.brandName}>Mimobot</Text></View>
          <View style={st.topActions}><ChatIconButton icon="computer" label={online ? 'Ordinateur connecté' : 'Ordinateur hors ligne'} badge={online} onPress={connection} /><ChatIconButton icon="close" label="Fermer" onPress={close} /></View>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={st.content}>
          <View style={st.headingRow}><View style={{ flex: 1 }}><Text accessibilityRole="header" style={st.heading}>Vos fils</Text><Text style={st.subtitle}>Retrouvez vos conversations et vos projets.</Text></View><ChatIconButton icon="plus" label="Créer un bot" filled onPress={createBot} /></View>
          {!online && <Text accessibilityRole="alert" style={st.notice}>PC hors ligne. Dernier état enregistré sur cet appareil.</Text>}
          <View style={st.search}><ChatIcon name="search" color="#777" size={20} /><TextInput accessibilityLabel="Rechercher un fil" value={query} onChangeText={setQuery} placeholder="Un sujet, un projet, un bot…" placeholderTextColor="#888" style={st.searchInput} autoCapitalize="none" autoCorrect={false} />{query ? <ChatIconButton icon="close" label="Effacer la recherche" onPress={() => setQuery('')} /> : null}</View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.filters}>
            {filters.map(f => <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={f.label} accessibilityState={{ selected: filter === f.id }} onPress={() => setFilter(f.id)} style={[st.filter, filter === f.id && st.filterOn]}><Text style={[st.filterText, filter === f.id && st.filterTextOn]}>{f.label}</Text></Pressable>)}
          </ScrollView>
          {sections.map(section => section.rows.length ? <View key={section.title} style={st.section}>
            <Text accessibilityRole="header" style={st.sectionTitle}>{section.title}</Text>
            {section.rows.map(row => <ThreadCard key={row.key} row={row} choose={() => choose(row)} />)}
          </View> : null)}
          {!rows.length && <Text style={st.empty}>Aucun fil ne correspond à votre sélection.</Text>}
          {!!error && <View style={st.noticeCard}><Text accessibilityRole="alert" style={st.notice}>{view ? 'Dernier état connu des missions. ' : ''}{error}</Text><Pressable accessibilityRole="button" onPress={() => setRetry(r => r + 1)} style={st.retry}><Text style={st.retryText}>Réessayer</Text></Pressable></View>}
          {!view && !error && online && <Text style={st.empty}>Lecture des projets sur le PC…</Text>}
          {view && !view.missions.length && !error && <Text style={st.empty}>Aucune mission de projet pour le moment.</Text>}
          {view?.projects.some(p => !p.archived) && <Pressable accessibilityRole="button" onPress={openMissions} style={st.newMission}><ChatIcon name="threads" size={18} /><Text style={st.newMissionText}>Voir les missions</Text></Pressable>}
        </ScrollView>
        <View style={st.dock}><View style={st.navigation}>
          <Nav label="Fils" icon="threads" selected onPress={() => { setQuery(''); setFilter('all'); }} />
          <Nav label="Activité" icon="activity" onPress={activity} />
          <Nav label="Mon PC" icon="computer" onPress={connection} />
        </View></View>
      </View>
    </SafeAreaView>
  </Modal>;
}

function ThreadCard({ row, choose }: { row: ThreadRow; choose(): void }) {
  const conversation = row.kind === 'conversation';
  const date = row.updatedAt && Number.isFinite(Date.parse(row.updatedAt))
    ? new Date(row.updatedAt).toLocaleDateString('fr', { day: 'numeric', month: 'short' }) : null;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Ouvrir ${conversation ? 'la conversation' : 'la mission'} ${row.title}`} onPress={choose} style={({ pressed }) => [st.card, conversation && row.primary && st.mainCard, pressed && st.cardPressed]}>
    <View style={st.face}>{conversation ? <Mascot shape={row.bot.shape} color={row.bot.color} size={43} /> : <ChatIcon name="document" color="#333" size={24} />}</View>
    <View style={st.cardBody}>
      <View style={st.meta}><Text style={st.context} numberOfLines={1}>{conversation ? row.primary ? 'CONVERSATION PRINCIPALE' : 'CONVERSATION' : row.projectLabel}</Text>{date && <Text style={st.date}>{date}</Text>}</View>
      <Text style={st.title} numberOfLines={2}>{row.title}</Text>
      {row.preview && <Text style={st.preview} numberOfLines={2}>{row.preview}</Text>}
      {!conversation && <Text style={st.preview}>Mission · objectif v{row.goalRev}</Text>}
      <View style={st.cardBottom}>
        {conversation ? <Text style={st.participants} numberOfLines={1}>Vous{row.participants.map(p => ` · ${p.name}`).join('')}</Text> : <Text style={st.participants}>Mission de projet</Text>}
        <View style={st.state}><View style={[st.stateDot, { backgroundColor: row.status.group === 'attention' ? '#946b19' : row.status.group === 'working' ? '#25784c' : '#999' }]} /><Text style={st.stateText}>{row.status.label}</Text></View>
      </View>
    </View>
  </Pressable>;
}
function Nav({ label, icon, selected, onPress }: { label: string; icon: 'threads' | 'activity' | 'computer'; selected?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }} onPress={onPress} style={[st.navItem, selected && st.navSelected]}><ChatIcon name={icon} color={selected ? '#fff' : '#777'} size={20} /><Text style={[st.navLabel, selected && { color: '#fff' }]}>{label}</Text></Pressable>;
}
const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fafafa' }, frame: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
  top: { minHeight: 68, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#ededed' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 }, brandName: { fontSize: 20, fontWeight: '700', letterSpacing: -0.7, color: '#181818' }, topActions: { flexDirection: 'row' },
  content: { padding: 20, paddingBottom: 24 }, headingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8, marginBottom: 22 },
  heading: { fontSize: 30, lineHeight: 36, fontWeight: '600', letterSpacing: -1, color: '#181818' }, subtitle: { fontSize: 14, lineHeight: 21, color: '#777', marginTop: 5 },
  search: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 16, paddingLeft: 14, backgroundColor: '#fff' }, searchInput: { flex: 1, minWidth: 0, paddingVertical: 12, paddingRight: 10, fontSize: 16, color: '#181818', outlineWidth: 0 },
  filters: { gap: 8, marginTop: 15, marginBottom: 5 }, filter: { minHeight: 42, paddingHorizontal: 15, borderRadius: 21, borderWidth: 1, borderColor: '#e2e2e2', justifyContent: 'center' }, filterOn: { backgroundColor: '#202020', borderColor: '#202020' }, filterText: { fontSize: 13, color: '#777' }, filterTextOn: { color: '#fff' },
  section: { marginTop: 22 }, sectionTitle: { fontSize: 11, fontWeight: '500', color: '#777', marginBottom: 12, letterSpacing: 0.6 },
  card: { flexDirection: 'row', gap: 12, padding: 16, marginBottom: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5e5e5', borderRadius: 20 }, mainCard: { borderColor: '#bdbdbd', backgroundColor: '#f5f5f5' }, cardPressed: { backgroundColor: '#ededed' }, face: { width: 43, alignItems: 'center', paddingTop: 2 }, cardBody: { flex: 1, minWidth: 0 },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 5 }, context: { fontSize: 9, lineHeight: 15, color: '#858585', flex: 1 }, date: { fontSize: 10, lineHeight: 15, color: '#858585' }, title: { fontSize: 16, lineHeight: 23, fontWeight: '600', letterSpacing: -0.2, color: '#181818' }, preview: { fontSize: 13, lineHeight: 21, color: '#777', marginTop: 5 }, cardBottom: { gap: 6, marginTop: 12 }, participants: { fontSize: 11, lineHeight: 16, color: '#858585', flexShrink: 1 }, state: { flexDirection: 'row', alignItems: 'center', gap: 5 }, stateDot: { width: 5, height: 5, borderRadius: 3 }, stateText: { fontSize: 11, lineHeight: 16, color: '#727272' },
  dock: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 10 }, navigation: { flexDirection: 'row', alignSelf: 'center', gap: 6, padding: 5, borderRadius: 30, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e5e5e5', boxShadow: '0 6px 25px #0000000c' }, navItem: { minWidth: 88, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 12, borderRadius: 25 }, navSelected: { backgroundColor: '#202020' }, navLabel: { fontSize: 12, fontWeight: '500', color: '#777' },
  notice: { fontSize: 12, lineHeight: 19, color: '#946b19' }, noticeCard: { paddingTop: 16 }, retry: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }, retryText: { fontSize: 13, textDecorationLine: 'underline', color: '#333' }, empty: { fontSize: 13, lineHeight: 21, color: '#858585', marginTop: 18 }, newMission: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }, newMissionText: { fontSize: 14, fontWeight: '500', color: '#202020' },
});
