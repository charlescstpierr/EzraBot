import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
export function Mascot({
  shape = "sprout",
  color = "#8de343",
  size = 40,
  animated = false,
}: {
  shape?: string;
  color?: string;
  size?: number;
  animated?: boolean;
}) {
  const [reduced, setReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!animated || !host.current || reduced) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return;
    }
    const node = host.current;
    let disposed = false,
      frame = 0;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-50, 50, 45, -45, 0.1, 100);
    camera.position.z = 10;
    renderer.setSize(size, size * 0.9);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    node.appendChild(renderer.domElement);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
    });
    const geometry = new THREE.PlaneGeometry(100, 90);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    let texture: THREE.Texture | undefined;
    const controller = new AbortController();
    fetch("/assets/symbols.svg", { signal: controller.signal })
      .then((r) => r.text())
      .then((raw) => {
        const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
        const symbol = doc.getElementById(`profile-${shape}`);
        if (!symbol) throw Error("Mascotte inconnue");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="360" viewBox="0 0 100 90">${symbol.innerHTML.replace(/var\(--bot-color,[^)]+\)/g, color)}</svg>`;
        const url =
          "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        new THREE.TextureLoader().load(
          url,
          (t) => {
            if (disposed) {
              t.dispose();
              return;
            }
            texture = t;
            t.colorSpace = THREE.SRGBColorSpace;
            material.map = t;
            material.needsUpdate = true;
            setReady(true);
            draw();
          },
          undefined,
          () => {},
        );
      })
      .catch(() => {});
    function draw() {
      if (disposed || document.hidden) return;
      const t = performance.now() / 1000;
      mesh.rotation.z = Math.sin(t * 0.8) * 0.025;
      mesh.scale.setScalar(1 + Math.sin(t * 1.6) * 0.012);
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    }
    const visibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden && texture) draw();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", visibility);
      geometry.dispose();
      material.dispose();
      texture?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      setReady(false);
    };
  }, [shape, color, size, animated, reduced]);
  return (
    <span
      ref={host}
      className="mascot"
      style={{ width: size, height: size * 0.9 }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 100 90"
        style={
          {
            "--bot-color": color,
            visibility: ready ? "hidden" : "visible",
          } as React.CSSProperties
        }
      >
        <use href={`/assets/symbols.svg#profile-${shape}`} />
      </svg>
    </span>
  );
}
