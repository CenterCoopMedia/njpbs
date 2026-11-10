// Theme-agnostic Babylon.js particle "New Jersey" hero.
// The state is rendered as a point cloud sampled from real NJ geometry
// (src/data/nj-points.json). Themes drive look + motion entirely through
// NJHeroConfig, so one engine serves all three design systems.
//
// Motion reacts to native scroll position (scrollY) — it never intercepts,
// delays, or snaps scrolling. prefers-reduced-motion renders a static cloud.
//
// Rendering: a single custom Mesh drawn in point-fill mode with a ~10-line
// ShaderMaterial. We deliberately do NOT use PointsCloudSystem, because it
// attaches a StandardMaterial to its mesh, and StandardMaterial drags the whole
// material/lighting pipeline plus the default vertex/fragment shaders (~250 kB)
// into a payload a flat point cloud never uses. The custom material renders
// gl_POINTS with a per-vertex color and a single point-size uniform and nothing
// else, so the island bundles to roughly half its former size. The CPU motion
// (idle drift, scroll dissolve, pointer repel) is unchanged from the
// PointsCloudSystem era except that the pointer repel now eases per point (see
// writePositions) so the cloud parts and reforms smoothly instead of snapping; the
// upload primitive moved from PointsCloudSystem.setParticles() to
// mesh.updateVerticesData(positions).

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";

import {
  DEFAULT_CONFIG,
  mergeHeroConfig,
  parseHexColor,
  type NJHeroConfig,
} from "./hero-config";
import {
  toHomePoint,
  scrollProgress,
  repelOffset,
  approach,
  easeFactor,
} from "./nj-points-transform";

// Re-export so existing import sites (NJHero.astro) keep resolving via nj-hero,
// while hero-config remains the single source of truth for the type + defaults.
export { DEFAULT_CONFIG };
export type { NJHeroConfig };

interface NJPoints {
  fill: [number, number][];
  edge: [number, number][];
}

interface HomePoint {
  hx: number;
  hy: number;
  hz: number;
  phase: number;
  isEdge: boolean;
}

// Minimal point shader: project the vertex, carry its color, set a fixed pixel
// size. Square points (no gl_PointCoord rounding) match the look the old
// PointsCloudSystem path produced. Babylon binds "worldViewProjection" and
// "pointSize" automatically because they are declared in the material's uniforms.
const POINT_VERTEX_SHADER = `precision highp float;
attribute vec3 position;
attribute vec4 color;
uniform mat4 worldViewProjection;
uniform float pointSize;
varying vec4 vColor;
void main(void) {
  vColor = color;
  gl_Position = worldViewProjection * vec4(position, 1.0);
  gl_PointSize = pointSize;
}`;

const POINT_FRAGMENT_SHADER = `precision highp float;
varying vec4 vColor;
void main(void) {
  gl_FragColor = vColor;
}`;

function hexToColor4(hex: string, alpha = 1): Color4 {
  const c = parseHexColor(hex);
  return new Color4(c.r, c.g, c.b, alpha);
}

function resolveColorReference(color: string): string {
  const trimmed = color.trim();
  const variable = trimmed.match(/^var\(--([a-zA-Z0-9-]+)\)$/)?.[1];
  if (!variable || typeof window === "undefined") return trimmed;

  const resolved = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(`--${variable}`)
    .trim();
  return resolved ? resolveColorReference(resolved) : trimmed;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}

/**
 * Mount the hero on a canvas. Returns a dispose() that tears everything down
 * (engine, listeners, observers) so islands can unmount cleanly.
 */
export function mountNJHero(
  canvas: HTMLCanvasElement,
  points: NJPoints,
  userConfig: Partial<NJHeroConfig> = {},
): () => void {
  const config: NJHeroConfig = mergeHeroConfig(userConfig);
  const reduced = prefersReducedMotion();
  const coarse = isCoarsePointer();

  // Mobile perf budget, DPR side: we intentionally omit Babylon's
  // adaptToDeviceRatio (4th arg), so the engine renders at 1x CSS resolution
  // instead of multiplying by devicePixelRatio. A full-frame point cloud on a 3x
  // phone would otherwise pay ~9x the fragment cost for no visible gain. The
  // point-count side of the budget is the coarse-pointer interior thinning below.
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: false,
    stencil: false,
    antialias: true,
    powerPreference: "high-performance",
  });
  const scene = new Scene(engine);
  scene.clearColor =
    config.background === "transparent"
      ? new Color4(0, 0, 0, 0)
      : hexToColor4(resolveColorReference(config.background), 1);

  const camera = new FreeCamera("cam", new Vector3(0, 0, -3.1), scene);
  camera.setTarget(Vector3.Zero());

  // Build the point set. NJ is tall (y in ~[-1,1]); scale to fill the frame.
  const SCALE = 1.32;
  const all: HomePoint[] = [];
  const pushAll = (arr: [number, number][], isEdge: boolean) => {
    for (const [x, y] of arr) {
      all.push({ ...toHomePoint(x, y, SCALE), isEdge });
    }
  };
  // Mobile perf budget, point-count side: on coarse/touch pointers, halve the
  // interior points (keep the edge crisp) so the cloud stays cheap on phones.
  const fillPts = coarse ? points.fill.filter((_, i) => i % 3 === 0) : points.fill;
  pushAll(fillPts, false);
  pushAll(points.edge, true);

  const count = all.length;
  const fill = parseHexColor(
    resolveColorReference(coarse ? config.compactFill : config.fill),
  );
  const edge = parseHexColor(
    resolveColorReference(coarse ? config.compactEdge : config.edge),
  );
  const pointSize = coarse ? config.compactPointSize : config.pointSize;

  // positions: re-uploaded every animated frame. colors: written once.
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const h = all[i];
    positions[i * 3] = h.hx;
    positions[i * 3 + 1] = h.hy;
    positions[i * 3 + 2] = h.hz;
    const c = h.isEdge ? edge : fill;
    colors[i * 4] = c.r;
    colors[i * 4 + 1] = c.g;
    colors[i * 4 + 2] = c.b;
    colors[i * 4 + 3] = 1;
  }

  const mesh = new Mesh("nj", scene);
  mesh.alwaysSelectAsActiveMesh = true; // a point cloud has no useful bounds; skip culling
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.colors = colors;
  // Identity index buffer so the mesh has a valid draw range; in point-fill mode
  // each index renders as one gl_POINT. Use 16-bit indices while the cloud fits
  // (NJ is a few thousand points, far under the 65,536 ceiling) so the hero still
  // draws on WebGL1 targets that lack OES_element_index_uint — older mobile Safari
  // and WebView. PointsCloudSystem auto-picked 16-bit the same way; a Uint32Array
  // would force the 32-bit path and regress those devices. 32-bit only kicks in if
  // a point set ever exceeds what 16-bit can address.
  const indices =
    count > 65536 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  vertexData.indices = indices;
  vertexData.applyToMesh(mesh, true); // updatable: positions change every frame

  const material = new ShaderMaterial(
    "njPoints",
    scene,
    {
      vertexSource: POINT_VERTEX_SHADER,
      fragmentSource: POINT_FRAGMENT_SHADER,
    },
    {
      attributes: ["position", "color"],
      uniforms: ["worldViewProjection", "pointSize"],
    },
  );
  material.pointsCloud = true; // draw gl_POINTS, not triangles
  material.backFaceCulling = false;
  material.setFloat("pointSize", pointSize);
  mesh.material = material;

  let scrollDissolve = 0; // 0..1, driven by native scroll over the hero
  let pointerWorld: Vector3 | null = null;

  // Per-point repel offset, carried across frames so the push has inertia: each frame
  // it eases toward the target offset (0 when the pointer is away). This is what makes
  // the cloud part smoothly on hover and reform smoothly on leave, instead of the old
  // single-frame snap. REPEL_TAU is the easing time constant in seconds (the gap shrinks
  // ~63% per tau); the per-frame fraction is derived from it and the frame delta, so the
  // feel is the same at 60 or 144 Hz. One scratch object holds each frame's target push,
  // reused across all points so the hot loop allocates nothing.
  const REPEL_TAU = 0.085;
  const repelX = new Float32Array(count);
  const repelY = new Float32Array(count);
  const repelTarget = { dx: 0, dy: 0 };
  let lastRepelT = performance.now() * 0.001;

  let disposed = false;
  const animate = !reduced;

  // Recompute every point's live position from its home + the active motion, then
  // hand the whole buffer to the mesh. Idle drift and scroll dissolve mirror the old
  // PointsCloudSystem math; the pointer repel adds per-point inertia (repelX/repelY
  // eased toward the target each frame) so it no longer snaps.
  const writePositions = () => {
    const t = performance.now() * 0.001;
    // Frame delta for the repel easing, clamped so a long pause (e.g. a backgrounded
    // tab) eases back over the next few frames instead of snapping in one giant step.
    const dt = Math.min(0.1, Math.max(0, t - lastRepelT));
    lastRepelT = t;
    const ease = easeFactor(dt, REPEL_TAU);
    for (let i = 0; i < count; i++) {
      const h = all[i];
      // idle drift
      let x = h.hx + Math.sin(t * 0.6 + h.phase) * config.drift;
      let y = h.hy + Math.cos(t * 0.5 + h.phase) * config.drift;
      let z = h.hz + Math.sin(t * 0.4 + h.phase) * config.drift;
      // scroll dissolve: scatter outward as the hero scrolls away
      if (scrollDissolve > 0) {
        const d = scrollDissolve * config.dissolve;
        x += Math.sin(h.phase * 3.1) * d;
        y += Math.cos(h.phase * 2.3) * d;
        z += Math.sin(h.phase) * d * 0.6;
      }
      // pointer repel, with inertia: compute this frame's target push, then ease the
      // stored offset toward it. Target is 0 when the pointer is absent or this point
      // is outside the radius, so the offset decays smoothly back to home rather than
      // snapping the instant the cursor leaves or moves on.
      let targetX = 0;
      let targetY = 0;
      if (pointerWorld) {
        repelOffset(
          repelTarget,
          x,
          y,
          pointerWorld.x,
          pointerWorld.y,
          config.repelRadius,
          config.repelStrength,
        );
        targetX = repelTarget.dx;
        targetY = repelTarget.dy;
      }
      repelX[i] = approach(repelX[i], targetX, ease);
      repelY[i] = approach(repelY[i], targetY, ease);
      x += repelX[i];
      y += repelY[i];
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
  };

  if (!animate) {
    // Static render: one frame, no loop. Home positions are already in the buffer.
    // The ShaderMaterial effect compiles asynchronously, so a bare scene.render()
    // here can run before the effect is ready — Babylon then skips the mesh and the
    // frame paints blank, and on desktop nothing repaints it (no resize fires).
    // Defer the single frame to executeWhenReady, which runs it once the effect has
    // compiled; it polls on its own timer, so no render loop is needed.
    scene.executeWhenReady(() => {
      if (!disposed) scene.render();
    });
  } else {
    engine.runRenderLoop(() => {
      if (disposed) return;
      writePositions();
      scene.render();
    });
  }

  // --- listeners (all passive; none block scroll) ---
  // engine.resize() resizes AND clears the framebuffer. The animated path redraws
  // every frame, so the clear is invisible. The reduced-motion path renders ONE
  // static frame with no loop, so a resize blanks the cloud until a next frame that
  // never comes. Mobile browsers fire a resize right after load as the URL bar
  // settles — that is the "cloud flashes then disappears on mobile" bug. Repaint the
  // static frame after every resize so both modes survive one.
  const onResize = () => {
    engine.resize();
    if (!animate && !disposed) scene.render();
  };
  window.addEventListener("resize", onResize);
  // iOS Safari (and some Android browsers) change the layout viewport when the URL
  // bar shows/hides WITHOUT firing a window 'resize' — only visualViewport fires.
  // In static mode that silent change still clears the one frame, so listen there too.
  const vv = !animate ? window.visualViewport : null;
  vv?.addEventListener("resize", onResize);

  let onScroll: (() => void) | null = null;
  let onPointerMove: ((e: PointerEvent) => void) | null = null;
  let onPointerLeave: (() => void) | null = null;

  if (animate) {
    const heroEl = canvas.closest("[data-nj-hero]") ?? canvas;
    onScroll = () => {
      const rect = (heroEl as HTMLElement).getBoundingClientRect();
      // 0 while hero fills view, → 1 as it scrolls above the fold. We READ scroll
      // position; we never alter it.
      scrollDissolve = scrollProgress(rect.top, window.innerHeight);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    if (!coarse) {
      onPointerMove = (e: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        // Map normalized device coords onto the world plane at z=0 — in the SAME
        // span the point cloud occupies. With a vertical-fixed fov the visible
        // half-height at that plane is tan(fov/2) * camera distance, and the
        // half-width is that times the aspect ratio. The old code used a fixed
        // span of 1.7, which overshot the ~1.31 the camera actually frames, so
        // near the edges the cursor landed beyond every point and the repel only
        // caught a few. Deriving the span from the camera makes the ripple track
        // the cursor across the whole state.
        const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        const aspect = rect.width / rect.height;
        const halfH = Math.tan(camera.fov / 2) * Math.abs(camera.position.z);
        pointerWorld = new Vector3(ndcX * halfH * aspect, ndcY * halfH, 0);
      };
      onPointerLeave = () => {
        pointerWorld = null;
      };
      canvas.addEventListener("pointermove", onPointerMove, { passive: true });
      canvas.addEventListener("pointerleave", onPointerLeave, { passive: true });
    }
  }

  // Babylon's scene InputManager sets tabindex="1" on the canvas so it can
  // capture keyboard input. This canvas is decorative (aria-hidden in
  // NJHero.astro) and the hero uses its own native pointer listeners, not
  // Babylon's input — so a tab stop here is a focusable element hidden from
  // assistive tech, a WCAG 2.1 AA failure (axe "aria-hidden-focus"). Reset it
  // after all Babylon setup has run, so the InputManager can't override it.
  canvas.tabIndex = -1;

  return function dispose() {
    disposed = true;
    window.removeEventListener("resize", onResize);
    vv?.removeEventListener("resize", onResize);
    if (onScroll) window.removeEventListener("scroll", onScroll);
    if (onPointerMove) canvas.removeEventListener("pointermove", onPointerMove);
    if (onPointerLeave) canvas.removeEventListener("pointerleave", onPointerLeave);
    engine.stopRenderLoop();
    scene.dispose();
    engine.dispose();
  };
}
