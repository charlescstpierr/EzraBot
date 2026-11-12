import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, Pressable, Text, View, useWindowDimensions } from 'react-native';
import type { MobileBot } from './generated/mobile-protocol';
import { Mascot, useMotion } from './ui';

export function BotFan({ bots, choose, close }: { bots: MobileBot[]; choose(id: string): void; close(): void }) {
  const { width, height } = useWindowDimensions();
  const motion = useMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const center = { x: width / 2, y: Math.min(260, height * .36) };
  const items = bots.slice(0, 5).map((bot, i, all) => {
    const angle = all.length === 1 ? Math.PI / 2 : Math.PI - (i / (all.length - 1)) * Math.PI;
    return { bot, x: Math.cos(angle) * Math.min(width * .34, 145), y: -Math.sin(angle) * 100 };
  });
  useEffect(() => { progress.setValue(0); Animated.spring(progress, { toValue: 1, useNativeDriver: true, tension: 75, friction: 9 }).start(); return () => progress.stopAnimation(); }, [progress]);
  const responder = PanResponder.create({
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: (_, gesture) => {
      let nearest: string | null = null; let distance = 65;
      for (const item of items) { const d = Math.hypot(gesture.moveX - center.x - item.x, gesture.moveY - center.y - item.y); if (d < distance) { nearest = item.bot.id; distance = d; } }
      selectedRef.current = nearest; setSelected(nearest);
    },
    onPanResponderRelease: () => { if (selectedRef.current) choose(selectedRef.current); else close(); },
    onPanResponderTerminate: close,
  });
  return <Modal transparent visible animationType="none" onRequestClose={close}>
    <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,.96)' }} {...responder.panHandlers}>
      <Pressable accessibilityLabel="Fermer le sélecteur de bots" onPress={close} style={{ position: 'absolute', top: 45, right: 25, padding: 15 }}><Text style={{ fontSize: 22 }}>×</Text></Pressable>
      {items.map(({ bot, x, y }) => <Animated.View key={bot.id} style={{ position: 'absolute', left: center.x - 38, top: center.y - 38, width: 76, opacity: motion ? progress : 1, transform: [{ translateX: motion ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, x] }) : x }, { translateY: motion ? progress.interpolate({ inputRange: [0, 1], outputRange: [40, y] }) : y }, { scale: selected === bot.id ? 1.18 : 1 }] }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Choisir ${bot.name}`} onPress={() => choose(bot.id)} style={{ alignItems: 'center', minHeight: 80 }}><Mascot shape={bot.shape} color={bot.color} size={65} /><Text style={{ color: '#000', marginTop: 6, fontWeight: selected === bot.id ? '700' : '400' }}>{bot.name}</Text></Pressable>
      </Animated.View>)}
      <Text style={{ position: 'absolute', top: center.y + 90, alignSelf: 'center', color: '#555', fontSize: 13 }}>Glisse vers un bot</Text>
    </View>
  </Modal>;
}
