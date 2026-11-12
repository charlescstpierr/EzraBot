import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SvgXml } from "react-native-svg";
import catalog from "./generated/mascots.json";
export { catalog };
export function useMotion() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setEnabled(!v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) =>
      setEnabled(!v),
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return enabled;
}
export function Button({
  title,
  onPress,
  disabled = false,
  solid = false,
  plain = false,
  label,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  solid?: boolean;
  plain?: boolean;
  label?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const motion = useMotion();
  return (
    <Animated.View
      style={{ transform: [{ scale }], opacity: disabled ? 0.35 : 1 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ?? title}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() =>
          motion &&
          Animated.timing(scale, {
            toValue: 0.97,
            duration: 80,
            useNativeDriver: true,
          }).start()
        }
        onPressOut={() =>
          motion &&
          Animated.timing(scale, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
          }).start()
        }
        style={[s.button, solid && s.solid, plain && {borderWidth:0,paddingHorizontal:10}]}
      >
        <Text style={[s.buttonText, solid && { color: "#fff" }]}>{title}</Text>
      </Pressable>
    </Animated.View>
  );
}
export function Mascot({
  shape,
  color,
  size = 64,
  alive = false,
}: {
  shape: string;
  color: string;
  size?: number;
  alive?: boolean;
}) {
  const bob = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const [motion, setMotion] = useState(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => setMotion(!v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) =>
      setMotion(!v),
    );
    const app = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => {
      sub.remove();
      app.remove();
    };
  }, []);
  useEffect(() => {
    if (!motion || !active || !alive) {
      bob.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, {
          toValue: -3,
          duration: 1400,
          useNativeDriver: true,
        }),
        Animated.timing(bob, {
          toValue: 0,
          duration: 1400,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [motion, active, alive, bob]);
  useEffect(() => {
    if (!motion || !active || !alive) { blink.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([Animated.delay(3100),Animated.timing(blink,{toValue:.1,duration:90,useNativeDriver:true}),Animated.timing(blink,{toValue:1,duration:120,useNativeDriver:true})]));
    loop.start(); return () => loop.stop();
  },[motion,active,alive,blink]);
  const item = catalog.shapes.find((x) => x.id === shape) ?? catalog.shapes[0];
  const xml = item.xml.replace(
    /var\(--bot-color,[^)]+\)/g,
    /^#[a-f0-9]{6}$/i.test(color) ? color : item.defaultColor,
  );
  const blinkable = shape === "sprout" || shape === "radish";
  const body = blinkable ? xml.replace(/<g fill="#090909"[^>]*>[\s\S]*?<\/g>/, '') : xml;
  return (
    <Animated.View
      accessibilityLabel={item.label}
      style={{ transform: [{ translateY: bob }] }}
    >
      <SvgXml xml={body} width={size} height={size} />
      {blinkable && <Animated.View pointerEvents="none" style={{position:'absolute',left:size*.49,top:size*.59,width:size*.19,height:size*.13,flexDirection:'row',justifyContent:'space-between',transform:[{rotate:'-13deg'},{scaleY:blink}]}}><View style={{width:size*.06,height:size*.13,borderRadius:size*.04,backgroundColor:'#090909'}}/><View style={{width:size*.06,height:size*.13,borderRadius:size*.04,backgroundColor:'#090909'}}/></Animated.View>}
    </Animated.View>
  );
}
export function Sheet({
  title,
  close,
  children,
}: {
  title: string;
  close(): void;
  children: React.ReactNode;
}) {
  const motion = useMotion();
  return (
    <Modal
      visible
      transparent
      animationType={motion ? "slide" : "none"}
      onRequestClose={close}
    >
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.row}>
            <Text accessibilityRole="header" style={s.heading}>
              {title}
            </Text>
            <Button title="Fermer" onPress={close} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function Field({
  label,
  value,
  onChange,
  multiline = false,
  secure = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  multiline?: boolean;
  secure?: boolean;
}) {
  return (
    <View style={{ marginVertical: 8 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        multiline={multiline}
        secureTextEntry={secure}
        autoCapitalize="none"
        style={[
          s.input,
          multiline && { minHeight: 100, textAlignVertical: "top" },
        ]}
      />
    </View>
  );
}
export function Code({ text }: { text: string }) {
  return (
    <Text selectable style={s.code}>
      {text}
    </Text>
  );
}
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 20 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  heading: { fontSize: 24, fontWeight: "600", color: "#000", flexShrink: 1 },
  title: { fontSize: 18, fontWeight: "600", color: "#000", marginVertical: 8 },
  text: { fontSize: 16, lineHeight: 24, color: "#000" },
  label: { fontSize: 12, lineHeight: 18, color: "#000" },
  muted: { fontSize: 12, lineHeight: 19, color: "#000", opacity: 0.6 },
  button: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#000",
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    marginVertical: 4,
  },
  buttonText: { fontSize: 13, fontWeight: "600", color: "#000" },
  solid: { backgroundColor: "#000" },
  input: {
    borderWidth: 1,
    borderColor: "#000",
    borderRadius: 14,
    padding: 12,
    color: "#000",
    backgroundColor: "#fff",
    fontSize: 16,
    minHeight: 48,
  },
  card: {
    borderTopWidth: 1,
    borderColor: "#000",
    paddingVertical: 16,
    marginTop: 12,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "#00000055",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    maxHeight: "92%",
  },
  code: {
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 19,
    color: "#000",
    marginVertical: 10,
  },
});
