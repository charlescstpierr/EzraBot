import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useMotion } from "./ui";

const iconPaths = {
  menu: "M5 7h14M5 12h10M5 17h14",
  back: "M19 12H5m6-6-6 6 6 6",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0",
  threads: "M4 4h16v13H8l-4 4zM8 8h8M8 12h5",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  more: "",
  computer: "M4 4.5h16v11H4zM9 20h6M12 15.5V20",
  send: "M12 19V5M6.5 10.5 12 5l5.5 5.5",
  chevron: "m9 5 7 7-7 7",
  document: "M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6",
  close: "m6 6 12 12M18 6 6 18",
  arrowDown: "M12 5v14m-5.5-5.5L12 19l5.5-5.5",
  stop: "M8 8h8v8H8z",
};
export type ChatIconName = keyof typeof iconPaths;

export function ChatIcon({
  name,
  color = "#000",
  size = 22,
}: {
  name: ChatIconName;
  color?: string;
  size?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
    >
      {name === "more" ? (
        [5, 12, 19].map((cx) => (
          <Circle key={cx} cx={cx} cy={12} r={1.5} fill={color} stroke="none" />
        ))
      ) : (
        <Path d={iconPaths[name]} />
      )}
    </Svg>
  );
}

function ChatTap({
  label,
  onPress,
  disabled = false,
  filled = false,
  light = false,
  children,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  filled?: boolean;
  light?: boolean;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const motion = useMotion();
  useEffect(() => {
    if (!motion || disabled) {
      scale.stopAnimation();
      scale.setValue(1);
    }
  }, [motion, disabled, scale]);
  const animate = (toValue: number) => {
    if (!motion) return;
    Animated.timing(scale, {
      toValue,
      duration: toValue === 1 ? 140 : 80,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  };
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => animate(0.94)}
        onPressOut={() => animate(1)}
        style={[
          styles.tap,
          filled && styles.tapFilled,
          light && styles.tapLight,
          disabled && styles.tapDisabled,
        ]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

export function ChatIconButton({
  icon,
  label,
  onPress,
  disabled,
  filled,
  light,
  badge = false,
}: {
  icon: ChatIconName;
  label: string;
  onPress(): void;
  disabled?: boolean;
  filled?: boolean;
  light?: boolean;
  badge?: boolean;
}) {
  return (
    <ChatTap
      label={label}
      onPress={onPress}
      disabled={disabled}
      filled={filled}
      light={light}
    >
      <ChatIcon name={icon} color={filled && !light ? "#fff" : "#000"} />
      {badge && <View pointerEvents="none" style={styles.badge} />}
    </ChatTap>
  );
}

export function ChatComposer({
  value,
  botName,
  onChange,
  onSelectionChange,
  onSend,
  onInvite,
  enabled,
  reviewerName,
  onRemoveReviewer,
  bottomInset = 0,
  stop,
}: {
  value: string;
  botName: string;
  onChange(text: string): void;
  onSelectionChange(cursor: number): void;
  onSend(): void;
  onInvite(): void;
  enabled: boolean;
  reviewerName?: string;
  onRemoveReviewer?(): void;
  bottomInset?: number;
  stop?(): Promise<void>;
}) {
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [height, setHeight] = useState(24);
  const [stopping, setStopping] = useState(false);
  const filled = value.length > 0;
  const canStop = !!stop && !value.trim();
  useEffect(() => {
    if (!value) setHeight(24);
  }, [value]);
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !(input.current instanceof HTMLTextAreaElement)) return;
    const node = input.current;
    const measure = () => {
      node.style.height = '0px';
      const next = value ? Math.min(128, Math.max(24, node.scrollHeight)) : 24;
      node.style.height = `${next}px`;
      node.style.overflowY = next >= 128 ? 'auto' : 'hidden';
      setHeight(next);
    };
    measure();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; measure(); }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [value]);
  return (
    <View testID="chat-composer" style={[styles.composerDock, { paddingBottom: Math.max(10, bottomInset) }]}>
      {reviewerName && (
        <View style={styles.reviewer}>
          <Text numberOfLines={1} style={styles.reviewerText}>
            Relecture par {reviewerName}
          </Text>
          {onRemoveReviewer && (
            <ChatIconButton
              icon="close"
              label={`Retirer ${reviewerName} de la relecture`}
              onPress={onRemoveReviewer}
            />
          )}
        </View>
      )}
      <View testID="chat-composer-bar" style={[styles.composerBar, filled && styles.composerFilled]}>
        <ChatTap label="Inviter un bot" onPress={onInvite} disabled={!enabled}>
          <Text style={[styles.invite, filled && styles.whiteText]}>@</Text>
        </ChatTap>
        <TextInput
          ref={input}
          accessibilityLabel="Message"
          value={value}
          multiline
          editable={enabled}
          placeholder={`Écrire à ${botName}…`}
          placeholderTextColor="#858585"
          selectionColor={filled ? "#c5c5c5" : "#000"}
          onChangeText={onChange}
          onSelectionChange={(event) => onSelectionChange(event.nativeEvent.selection.end)}
          onContentSizeChange={(event) => {
            if (Platform.OS !== 'web') {
              const measured = Math.ceil(event.nativeEvent.contentSize.height);
              setHeight(Math.min(128, Math.max(24, measured)));
            }
          }}
          scrollEnabled={height >= 128}
          underlineColorAndroid="transparent"
          style={[
            styles.composerInput,
            { height },
            filled && styles.whiteText,
          ]}
        />
        <ChatIconButton
          icon={canStop ? 'stop' : 'send'}
          label={canStop ? 'Arrêter la réponse' : 'Envoyer'}
          light={filled}
          filled={!filled}
          disabled={!enabled || (canStop ? stopping : !value.trim())}
          onPress={() => {
            if (Platform.OS === 'web' && !canStop) input.current?.focus();
            if (stop && canStop) {
              setStopping(true);
              void stop().finally(() => setStopping(false));
            } else onSend();
          }}
        />
      </View>
    </View>
  );
}

export type ChatActivityStage = "pending" | "running" | "writing";
const activityText: Record<ChatActivityStage, string> = {
  pending: "en attente",
  running: "travaille",
  writing: "rédige",
};

export function ChatActivity({ name, stage }: { name: string; stage: ChatActivityStage }) {
  const motion = useMotion();
  const dots = useRef([new Animated.Value(0.3), new Animated.Value(0.3), new Animated.Value(0.3)]).current;
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!motion || !active) {
      dots.forEach((dot) => dot.setValue(0.45));
      return;
    }
    const loop = Animated.loop(
      Animated.stagger(140, dots.map((dot) => Animated.sequence([
        Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(dot, { toValue: 0.3, duration: 500, useNativeDriver: Platform.OS !== "web" }),
        Animated.delay(250),
      ]))),
    );
    loop.start();
    return () => loop.stop();
  }, [motion, active, dots]);
  return (
    <View accessible accessibilityLabel={`${name} ${activityText[stage]}`} style={styles.activity}>
      <Text style={styles.activityText}>{name} {activityText[stage]}</Text>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.dots}>
        {dots.map((opacity, index) => (
          <Animated.View key={index} style={[styles.dot, { opacity }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tap: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  tapFilled: { backgroundColor: "#000" },
  tapLight: { backgroundColor: "#fff" },
  tapDisabled: { opacity: 0.3 },
  badge: { position: "absolute", top: 8, right: 8, width: 5, height: 5, borderRadius: 3, backgroundColor: "#000", borderWidth: 1, borderColor: "#fff" },
  composerDock: { backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 8 },
  composerBar: { minHeight: 58, borderWidth: 1, borderColor: "#e5e5e5", borderRadius: 29, padding: 6, flexDirection: "row", alignItems: "flex-end", gap: 2, backgroundColor: "#fff" },
  composerFilled: { backgroundColor: "#000", borderColor: "#000" },
  composerInput: { flex: 1, minWidth: 0, alignSelf: "center", paddingHorizontal: 5, paddingVertical: 0, fontSize: 17, lineHeight: 24, color: "#000", textAlignVertical: "top", outlineWidth: 0 },
  invite: { fontSize: 25, lineHeight: 30, fontWeight: "400", color: "#747474" },
  whiteText: { color: "#fff" },
  reviewer: { minHeight: 44, flexDirection: "row", alignItems: "center", alignSelf: "flex-start", borderRadius: 22, backgroundColor: "#f5f5f5", marginBottom: 8, paddingLeft: 14, maxWidth: "100%" },
  reviewerText: { color: "#686868", fontSize: 13, flexShrink: 1 },
  activity: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 36, marginBottom: 20 },
  activityText: { fontSize: 14, lineHeight: 22, color: "#747474", flexShrink: 1 },
  dots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: "#747474" },
});

export const chatStyles = StyleSheet.create({
  header: { minHeight: 58, paddingHorizontal: 16, paddingTop: 4, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#fff" },
  headerProfile: { minHeight: 44, flexShrink: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 8 },
  headerTitle: { fontSize: 17, lineHeight: 23, fontWeight: "600", color: "#000", flexShrink: 1 },
  connectionButton: { minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, paddingBottom: 5 },
  connectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
  connectionText: { fontSize: 11, lineHeight: 16, color: "#7b7b7b", textAlign: "center" },
  connectionDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: "#787878" },
  list: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 20, flexGrow: 1 },
  userMessage: { alignItems: "flex-end", marginBottom: 28 },
  userBubble: { backgroundColor: "#f4f4f3", borderRadius: 20, maxWidth: "86%", paddingHorizontal: 16, paddingVertical: 12 },
  userText: { fontSize: 17, lineHeight: 25, color: "#000" },
  assistantMessage: { width: "100%", marginBottom: 28 },
  assistantHeader: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10, minHeight: 28 },
  assistantName: { fontSize: 13, lineHeight: 19, color: "#777", flexShrink: 1 },
  assistantBody: { fontSize: 17, lineHeight: 27, color: "#000" },
  messageMeta: { fontSize: 12, lineHeight: 18, color: "#858585", marginTop: 8 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40, paddingHorizontal: 12 },
  emptyTitle: { fontSize: 27, lineHeight: 34, fontWeight: "600", letterSpacing: -0.6, color: "#000", textAlign: "center", marginTop: 22 },
  emptySubtitle: { fontSize: 15, lineHeight: 23, color: "#858585", textAlign: "center", marginTop: 10 },
  latest: { position: "absolute", alignSelf: "center", bottom: 12, width: 46, height: 46, borderWidth: 1, borderColor: "#ebebeb", borderRadius: 23, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", boxShadow: "0 3px 14px #0000000d" },
  workLink: { alignSelf: "flex-start", minHeight: 44, flexDirection: "row", alignItems: "center", gap: 7, paddingRight: 12, marginTop: 8 },
});
