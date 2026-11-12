import React, { useMemo } from 'react';
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { parseChatMarkdown, safeChatLink, type ChatBlock, type ChatInline } from './chat-markdown';

function openLink(url: string) {
  const allowed = safeChatLink(url);
  if (allowed) void Linking.openURL(allowed).catch(() => Alert.alert('Lien indisponible', 'Impossible d’ouvrir ce lien.'));
}

function Inlines({ nodes, color }: { nodes: ChatInline[]; color: string }) {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text': return <Text key={index}>{node.text}</Text>;
      case 'break': return <Text key={index}>{'\n'}</Text>;
      case 'code': return <Text key={index} style={s.inlineCode}>{node.text}</Text>;
      case 'image': return <Text key={index}>{`[Image${node.label ? ` : ${node.label}` : ''}]${node.source ? ` (${node.source})` : ''}`}</Text>;
      case 'strong':
      case 'emphasis':
      case 'strike': return <Text key={index} style={node.kind === 'strong' ? s.strong : node.kind === 'emphasis' ? s.emphasis : s.strike}>
        <Inlines nodes={node.children} color={color} />
      </Text>;
      case 'link': return <Text key={index} accessibilityRole="link" style={[s.link, { color }]} onPress={() => openLink(node.url)}>
        <Inlines nodes={node.children} color={color} />
      </Text>;
    }
  });
}

function Blocks({ blocks, color, compact = false }: { blocks: ChatBlock[]; color: string; compact?: boolean }) {
  return <View style={[s.blocks, compact && s.compact]}>{blocks.map((block, index) => {
    switch (block.kind) {
      case 'paragraph': return <Text key={index} selectable style={[s.text, { color }]}>
        <Inlines nodes={block.children} color={color} />
      </Text>;
      case 'heading': return <Text key={index} selectable accessibilityRole="header" style={[
        s.text, s.heading, block.level <= 2 ? s.largeHeading : s.smallHeading, { color },
      ]}><Inlines nodes={block.children} color={color} /></Text>;
      case 'quote': return <View key={index} style={s.quote}><Blocks blocks={block.children} color={color} /></View>;
      case 'list': return <View key={index} style={s.list}>{block.items.map((item, itemIndex) => <View key={itemIndex} style={s.listItem}>
        <Text selectable style={[s.text, s.marker, { color }]}>{block.start === null ? '•' : `${block.start + itemIndex}.`}</Text>
        <View style={s.listBody}><Blocks blocks={item} color={color} compact /></View>
      </View>)}</View>;
      case 'code': return <View key={index} style={s.codeBlock}>
        {block.language ? <Text selectable style={s.language}>{block.language}</Text> : null}
        <ScrollView horizontal style={s.horizontal} contentContainerStyle={s.codeContent} showsHorizontalScrollIndicator>
          <Text selectable style={[s.codeText, { color }]}>{block.text}</Text>
        </ScrollView>
      </View>;
      case 'table': return <ScrollView key={index} horizontal style={s.horizontal} showsHorizontalScrollIndicator>
        <View style={s.table}>{block.rows.map((row, rowIndex) => <View key={rowIndex} style={s.tableRow}>{row.map((cell, cellIndex) =>
          <View key={cellIndex} style={[s.cell, cell.header && s.headerCell]}><Text selectable style={[
            s.text, cell.header && s.strong, { color, textAlign: cell.align },
          ]}><Inlines nodes={cell.children} color={color} /></Text></View>,
        )}</View>)}</View>
      </ScrollView>;
      case 'rule': return <View key={index} style={s.rule} />;
    }
  })}</View>;
}

export function ChatMarkdown({ text, color = '#171717' }: { text: string; color?: string }) {
  const blocks = useMemo(() => parseChatMarkdown(text), [text]);
  return <Blocks blocks={blocks} color={color} />;
}

const codeFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const s = StyleSheet.create({
  blocks: { width: '100%', maxWidth: '100%', minWidth: 0, gap: 12 },
  compact: { gap: 7 },
  text: { fontSize: 17, lineHeight: 26 },
  strong: { fontWeight: '700' },
  emphasis: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  inlineCode: { fontFamily: codeFont, fontSize: 15, backgroundColor: '#f0f0f0' },
  heading: { fontWeight: '700', marginTop: 5 },
  largeHeading: { fontSize: 22, lineHeight: 30 },
  smallHeading: { fontSize: 18, lineHeight: 27 },
  quote: { borderLeftWidth: 3, borderLeftColor: '#d8d8d8', paddingLeft: 14, minWidth: 0 },
  list: { gap: 8 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  marker: { minWidth: 20, textAlign: 'right' },
  listBody: { flex: 1, minWidth: 0 },
  horizontal: { maxWidth: '100%', width: '100%', flexGrow: 0 },
  codeBlock: { maxWidth: '100%', minWidth: 0, borderRadius: 12, backgroundColor: '#f5f5f5', overflow: 'hidden' },
  language: { fontSize: 12, lineHeight: 18, color: '#686868', paddingHorizontal: 14, paddingTop: 10 },
  codeContent: { padding: 14 },
  codeText: { fontFamily: codeFont, fontSize: 14, lineHeight: 22 },
  table: { borderTopWidth: StyleSheet.hairlineWidth, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: '#d8d8d8' },
  tableRow: { flexDirection: 'row' },
  cell: { width: 180, paddingHorizontal: 12, paddingVertical: 9, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#d8d8d8' },
  headerCell: { backgroundColor: '#f5f5f5' },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: '#dedede', marginVertical: 4 },
});
