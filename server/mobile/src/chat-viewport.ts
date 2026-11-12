import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

type Viewport = { kind: 'native'; keyboardOpen: boolean }
  | { kind: 'web'; height: number; top: number; keyboardOpen: boolean };

export function useChatViewport(): Viewport {
  const [state, setState] = useState<Viewport>(() => Platform.OS === 'web' && typeof window !== 'undefined'
    ? { kind: 'web', height: window.innerHeight, top: 0, keyboardOpen: false }
    : { kind: 'native', keyboardOpen: false });
  useEffect(() => {
    if (Platform.OS !== 'web') {
      const shown = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setState({ kind: 'native', keyboardOpen: true }));
      const hidden = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setState({ kind: 'native', keyboardOpen: false }));
      return () => { shown.remove(); hidden.remove(); };
    }
    const viewport = window.visualViewport;
    let baseline = window.innerHeight;
    let width = window.innerWidth;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
      const height = Math.max(180, Math.round(viewport?.height ?? window.innerHeight));
      const top = Math.max(0, Math.round(viewport?.offsetTop ?? 0));
      if (Math.abs(window.innerWidth - width) > 40) { baseline = window.innerHeight; width = window.innerWidth; }
      const focused = document.activeElement instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (!focused) baseline = Math.max(baseline, height);
      const keyboardOpen = focused && baseline - height > 120;
      setState(previous => previous.kind === 'web' && previous.height === height && previous.top === top && previous.keyboardOpen === keyboardOpen
        ? previous : { kind: 'web', height, top, keyboardOpen });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const oldMeta = meta?.content;
    if (meta && !meta.content.includes('viewport-fit')) meta.content += ', viewport-fit=cover';
    const style = document.createElement('style');
    style.textContent = '[data-testid="chat-composer"] textarea{outline:none!important;box-shadow:none!important;resize:none!important;-webkit-appearance:none;border:0!important}';
    document.head.append(style);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      style.remove();
      if (meta && oldMeta !== undefined) meta.content = oldMeta;
    };
  }, []);
  return state;
}
