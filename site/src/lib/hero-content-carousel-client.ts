import {
  HERO_CAROUSEL_AUTOPLAY_MS,
  getHeroCarouselLayout,
  heroCarouselVisibility,
  nearestHeroCarouselRotation,
  normalizeHeroCarouselAngle,
  wrapHeroCarouselIndex,
} from "./hero-content-carousel";
import { readConnection, shouldLoadHeavyEnhancement } from "./network-preference";

type Point3 = {
  set: (x: number, y: number, z: number) => void;
  z: number;
};

type Scale3 = {
  setScalar: (value: number) => void;
};

type Object3DLike = {
  position: Point3;
  rotation: { y: number };
  scale: Scale3;
  visible: boolean;
  add: (object: Object3DLike) => void;
  remove: (object: Object3DLike) => void;
};

type CameraLike = Object3DLike & {
  aspect: number;
  updateProjectionMatrix: () => void;
};

type CSS3DObjectLike = Object3DLike & {
  element: HTMLElement;
};

type RendererLike = {
  domElement: HTMLElement;
  setSize: (width: number, height: number) => void;
  render: (scene: Object3DLike, camera: CameraLike) => void;
};

type ThreeCoreModule = {
  Object3D: new () => Object3DLike;
  PerspectiveCamera: new (
    fov: number,
    aspect: number,
    near: number,
    far: number,
  ) => CameraLike;
};

type CSS3DRendererModule = {
  CSS3DObject: new (element: HTMLElement) => CSS3DObjectLike;
  CSS3DRenderer: new () => RendererLike;
};

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number },
  ) => number;
};

const THREE_CORE_URL = "/vendor/three/build/three.core.min.js";
const THREE_CSS3D_URL = "/vendor/three/examples/jsm/renderers/CSS3DRenderer.js";
const TAU = Math.PI * 2;
const mounted = new WeakSet<HTMLElement>();
let modulesPromise:
  | Promise<[ThreeCoreModule, CSS3DRendererModule]>
  | undefined;

function loadThreeModules(): Promise<[ThreeCoreModule, CSS3DRendererModule]> {
  modulesPromise ??= Promise.all([
    import(/* @vite-ignore */ THREE_CORE_URL) as Promise<ThreeCoreModule>,
    import(/* @vite-ignore */ THREE_CSS3D_URL) as Promise<CSS3DRendererModule>,
  ]);
  return modulesPromise;
}

function motionIsReduced(query: MediaQueryList): boolean {
  return (
    query.matches ||
    document.documentElement.getAttribute("data-motion") === "off"
  );
}

function setButtonText(button: HTMLButtonElement, text: string): void {
  const label = button.querySelector<HTMLElement>("[data-carousel-toggle-label]");
  if (label) label.textContent = text;
}

function mountFallback(root: HTMLElement) {
  const viewport = root.querySelector<HTMLElement>("[data-carousel-viewport]");
  const track = root.querySelector<HTMLElement>("[data-carousel-track]");
  const cards = Array.from(
    root.querySelectorAll<HTMLAnchorElement>("[data-carousel-card]"),
  );
  const previous = root.querySelector<HTMLButtonElement>("[data-carousel-previous]");
  const next = root.querySelector<HTMLButtonElement>("[data-carousel-next]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-carousel-toggle]");
  const status = root.querySelector<HTMLElement>("[data-carousel-status]");

  if (!viewport || !track || cards.length < 2 || !previous || !next || !toggle) {
    return null;
  }

  // The section owns the controls and slides, so it is the accessible carousel
  // container. Move the rotation control before the other interactive content as
  // required by the WAI carousel pattern; absolute positioning keeps its visual
  // placement unchanged. Its changing action label communicates state without a
  // redundant aria-pressed value.
  root.setAttribute("aria-roledescription", "carousel");
  viewport.removeAttribute("aria-roledescription");
  if (viewport.id) toggle.setAttribute("aria-controls", viewport.id);
  toggle.removeAttribute("aria-pressed");
  toggle.removeAttribute("data-carousel-paused");
  if (previous.parentElement === root) root.insertBefore(toggle, previous);

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let activeIndex = 0;
  let fallbackScrollTimer = 0;
  let enhancedGoTo:
    | ((index: number, options?: { announce?: boolean }) => void)
    | null = null;
  let enhancedToggle: (() => void) | null = null;
  let enhancedDispose: (() => void) | null = null;

  const updateFallbackState = (announce: boolean) => {
    cards.forEach((card, index) => {
      if (index === activeIndex) card.setAttribute("aria-current", "true");
      else card.removeAttribute("aria-current");
    });

    if (announce && status) {
      status.textContent = `${cards[activeIndex].dataset.carouselTitle ?? "Item"}, ${
        activeIndex + 1
      } of ${cards.length}`;
    }
  };

  const scrollFallback = () => {
    const card = cards[activeIndex];
    const left = card.offsetLeft - (viewport.clientWidth - card.offsetWidth) / 2;
    viewport.scrollTo({
      left: Math.max(0, left),
      behavior: motionIsReduced(motionQuery) ? "auto" : "smooth",
    });
  };

  const goTo = (index: number, announce = true) => {
    activeIndex = wrapHeroCarouselIndex(index, cards.length);
    updateFallbackState(announce);
    if (enhancedGoTo) enhancedGoTo(activeIndex, { announce });
    else scrollFallback();
  };

  const move = (delta: number) => goTo(activeIndex + delta);

  previous.hidden = false;
  next.hidden = false;
  root.classList.add("is-ready");

  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  toggle.addEventListener("click", () => enhancedToggle?.());

  viewport.addEventListener(
    "scroll",
    () => {
      if (enhancedGoTo) return;
      window.clearTimeout(fallbackScrollTimer);
      fallbackScrollTimer = window.setTimeout(() => {
        const viewportCenter = viewport.scrollLeft + viewport.clientWidth / 2;
        const closestIndex = cards.reduce(
          (closest, card, index) => {
            const cardCenter = card.offsetLeft + card.offsetWidth / 2;
            const distance = Math.abs(cardCenter - viewportCenter);
            return distance < closest.distance ? { index, distance } : closest;
          },
          { index: activeIndex, distance: Number.POSITIVE_INFINITY },
        ).index;
        if (closestIndex !== activeIndex) {
          activeIndex = closestIndex;
          updateFallbackState(false);
        }
      }, 90);
    },
    { passive: true },
  );

  viewport.addEventListener("keydown", (event) => {
    const focusShouldFollow =
      event.target instanceof HTMLAnchorElement && cards.includes(event.target);
    const followActiveCard = () => {
      if (focusShouldFollow) cards[activeIndex].focus({ preventScroll: true });
    };

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
      followActiveCard();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
      followActiveCard();
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
      followActiveCard();
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(cards.length - 1);
      followActiveCard();
    }
  });

  updateFallbackState(false);

  return {
    viewport,
    track,
    cards,
    toggle,
    motionQuery,
    getActiveIndex: () => activeIndex,
    setActiveIndex: (index: number, announce = false) => {
      activeIndex = wrapHeroCarouselIndex(index, cards.length);
      updateFallbackState(announce);
    },
    connectEnhanced: (
      onGoTo: (index: number, options?: { announce?: boolean }) => void,
      onToggle: () => void,
      onDispose: () => void,
    ) => {
      enhancedGoTo = onGoTo;
      enhancedToggle = onToggle;
      enhancedDispose = onDispose;
    },
    disconnectEnhanced: () => {
      const dispose = enhancedDispose;
      enhancedGoTo = null;
      enhancedToggle = null;
      enhancedDispose = null;
      dispose?.();
    },
  };
}

function restoreFallback(
  root: HTMLElement,
  fallback: NonNullable<ReturnType<typeof mountFallback>>,
): void {
  fallback.disconnectEnhanced();
  root.classList.remove("is-enhanced");
  root.style.removeProperty("--hero-carousel-card-width");
  root.style.removeProperty("--hero-carousel-card-height");
  fallback.track.hidden = false;
  fallback.toggle.hidden = true;
  fallback.toggle.disabled = false;
  fallback.toggle.removeAttribute("aria-pressed");
  fallback.toggle.removeAttribute("data-carousel-paused");
  fallback.toggle.setAttribute("aria-label", "Pause automatic rotation");
  setButtonText(fallback.toggle, "Pause");
  root.querySelector<HTMLElement>(".hero-content-carousel__three-stage")?.remove();

  fallback.cards.forEach((card) => {
    fallback.track.append(card);
    for (const property of [
      "display",
      "filter",
      "opacity",
      "pointer-events",
      "position",
      "transform",
      "user-select",
      "z-index",
    ]) {
      card.style.removeProperty(property);
    }
    card.removeAttribute("aria-hidden");
    card.removeAttribute("data-carousel-active");
    card.removeAttribute("draggable");
    card.removeAttribute("tabindex");
  });
  fallback.setActiveIndex(fallback.getActiveIndex(), false);
}

async function upgradeToThree(
  root: HTMLElement,
  fallback: NonNullable<ReturnType<typeof mountFallback>>,
): Promise<void> {
  if (!root.isConnected || root.classList.contains("is-enhanced")) return;
  const [three, css3d] = await loadThreeModules();
  const { viewport, track, cards, toggle, motionQuery } = fallback;
  if (!root.isConnected || root.classList.contains("is-enhanced")) return;

  const scene = new three.Object3D();
  const camera = new three.PerspectiveCamera(42, 1, 1, 5_000);
  const renderer = new css3d.CSS3DRenderer();
  renderer.domElement.className = "hero-content-carousel__three-stage";
  viewport.append(renderer.domElement);

  const objects = cards.map((card) => {
    const object = new css3d.CSS3DObject(card);
    scene.add(object);
    return object;
  });

  const count = objects.length;
  const step = TAU / count;
  const speed = TAU / HERO_CAROUSEL_AUTOPLAY_MS;
  let rotation = nearestHeroCarouselRotation(0, fallback.getActiveIndex(), count);
  let targetRotation = rotation;
  let activeIndex = fallback.getActiveIndex();
  let snapping = false;
  let userPaused = false;
  let hoverPaused = false;
  let focusPaused = root.contains(document.activeElement);
  let focusFromPointer = false;
  let dragging = false;
  let pointerActive = false;
  let inView = true;
  let disposed = false;
  let dirty = true;
  let frameHandle = 0;
  let lastTime = performance.now();
  let suppressClick = false;
  const listenerController = new AbortController();
  let htmlObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let intersectionObserver: IntersectionObserver | null = null;

  const disposeEnhanced = () => {
    if (disposed) return;
    disposed = true;
    window.cancelAnimationFrame(frameHandle);
    listenerController.abort();
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    htmlObserver?.disconnect();
    objects.forEach((object) => scene.remove(object));
    renderer.domElement.remove();
  };

  const isReduced = () => motionIsReduced(motionQuery);

  const updateToggle = () => {
    const reduced = isReduced();
    const paused = userPaused || focusPaused;
    toggle.disabled = reduced;
    toggle.toggleAttribute("data-carousel-paused", paused || reduced);
    if (reduced) {
      toggle.setAttribute("aria-label", "Automatic rotation off because reduced motion is enabled");
      setButtonText(toggle, "Motion off");
    } else if (paused) {
      toggle.setAttribute("aria-label", "Resume automatic rotation");
      setButtonText(toggle, "Play");
    } else {
      toggle.setAttribute("aria-label", "Pause automatic rotation");
      setButtonText(toggle, "Pause");
    }
  };

  const updateAccessibleCards = (index: number, announce = false) => {
    activeIndex = wrapHeroCarouselIndex(index, count);
    fallback.setActiveIndex(activeIndex, announce);
  };

  const resizeAndRender = () => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const layout = getHeroCarouselLayout(width, height, count);
    root.style.setProperty("--hero-carousel-card-width", `${layout.cardWidth}px`);
    root.style.setProperty("--hero-carousel-card-height", `${layout.cardHeight}px`);

    camera.aspect = width / height;
    camera.position.set(0, 0, layout.cameraZ);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);

    objects.forEach((object, index) => {
      const angle = normalizeHeroCarouselAngle(index * step + rotation);
      const frontness = Math.max(0, Math.cos(angle));
      const opacity = heroCarouselVisibility(angle, layout.visibleAngle);
      const depthScale = 0.8 + frontness * 0.2;

      object.position.set(
        Math.sin(angle) * layout.radius,
        (1 - frontness) * layout.arcLift - layout.arcLift * 0.18,
        Math.cos(angle) * layout.radius,
      );
      object.rotation.y = angle;
      object.scale.setScalar(depthScale);
      object.visible = opacity > 0.008;
      object.element.style.opacity = opacity.toFixed(3);
      object.element.style.filter = `saturate(${(0.72 + frontness * 0.28).toFixed(
        3,
      )}) brightness(${(0.74 + frontness * 0.26).toFixed(3)})`;
      object.element.style.zIndex = String(Math.round(frontness * 1_000));
      const isActive = index === activeIndex;
      const isExposed = isActive || opacity > 0.08;
      object.element.style.pointerEvents = isExposed ? "auto" : "none";
      object.element.tabIndex = isActive ? 0 : -1;
      object.element.setAttribute("aria-hidden", String(!isExposed));
      if (isActive) object.element.setAttribute("aria-current", "true");
      else object.element.removeAttribute("aria-current");
      object.element.toggleAttribute("data-carousel-active", isActive);
    });

    renderer.render(scene, camera);
    dirty = false;
  };

  const goTo = (index: number, options: { announce?: boolean } = {}) => {
    activeIndex = wrapHeroCarouselIndex(index, count);
    targetRotation = nearestHeroCarouselRotation(rotation, activeIndex, count);
    if (isReduced()) {
      rotation = targetRotation;
      snapping = false;
    } else {
      snapping = true;
    }
    updateAccessibleCards(activeIndex, options.announce === true);
    dirty = true;
  };

  const toggleAutoplay = () => {
    if (isReduced()) return;
    if (focusPaused) {
      focusPaused = false;
      userPaused = false;
    } else {
      userPaused = !userPaused;
    }
    updateToggle();
  };

  fallback.connectEnhanced(goTo, toggleAutoplay, disposeEnhanced);

  const shouldAutoplay = () =>
    !isReduced() &&
    !userPaused &&
    !hoverPaused &&
    !focusPaused &&
    !pointerActive &&
    !dragging &&
    !snapping &&
    inView &&
    !document.hidden;

  const animate = (time: number) => {
    if (disposed) return;
    const elapsed = Math.min(Math.max(time - lastTime, 0), 64);
    lastTime = time;

    if (snapping) {
      const difference = targetRotation - rotation;
      if (isReduced() || Math.abs(difference) < 0.0007) {
        rotation = targetRotation;
        snapping = false;
      } else {
        rotation += difference * (1 - Math.exp(-elapsed / 145));
      }
      dirty = true;
    } else if (shouldAutoplay()) {
      rotation -= elapsed * speed;
      const nearestIndex = wrapHeroCarouselIndex(Math.round(-rotation / step), count);
      if (nearestIndex !== activeIndex) updateAccessibleCards(nearestIndex, false);
      dirty = true;
    }

    if (dirty) resizeAndRender();
    frameHandle = window.requestAnimationFrame(animate);
  };

  root.addEventListener(
    "pointerenter",
    () => {
      hoverPaused = true;
    },
    { signal: listenerController.signal },
  );
  root.addEventListener(
    "pointerleave",
    () => {
      hoverPaused = false;
    },
    { signal: listenerController.signal },
  );
  root.addEventListener(
    "pointerdown",
    () => {
      // Pointer users already receive the temporary hover/pointer pause. Do not
      // turn the focus caused by a click or tap into a keyboard-style latched
      // pause, or the visible pause button would invert its action on click.
      focusFromPointer = true;
      queueMicrotask(() => {
        focusFromPointer = false;
      });
    },
    { capture: true, signal: listenerController.signal },
  );
  root.addEventListener(
    "keydown",
    (event) => {
      const activatesRotationControl =
        event.target === toggle &&
        (event.key === "Enter" || event.key === " " || event.key === "Spacebar");
      if (activatesRotationControl || focusPaused) return;

      // A user can click into the carousel and then switch to the keyboard without
      // generating another focus-entry event. Latch the pause on that first key so
      // rotation never continues underneath keyboard interaction.
      focusPaused = true;
      updateToggle();
    },
    { capture: true, signal: listenerController.signal },
  );
  root.addEventListener(
    "focusin",
    (event) => {
      const previousTarget = event.relatedTarget;
      if (
        focusFromPointer ||
        (previousTarget instanceof Node && root.contains(previousTarget))
      ) {
        return;
      }
      // Keyboard focus latches the pause. It remains stopped after focus leaves
      // until the user explicitly activates the rotation control.
      focusPaused = true;
      updateToggle();
    },
    { signal: listenerController.signal },
  );

  let pointerId: number | null = null;
  let pointerStartX = 0;
  let pointerStartRotation = 0;

  viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (
        !event.isPrimary ||
        (event.pointerType === "mouse" && event.button !== 0)
      ) {
        return;
      }
      pointerId = event.pointerId;
      pointerStartX = event.clientX;
      pointerStartRotation = rotation;
      pointerActive = true;
      dragging = false;
      suppressClick = false;
      viewport.setPointerCapture(pointerId);
    },
    { signal: listenerController.signal },
  );

  viewport.addEventListener(
    "pointermove",
    (event) => {
      if (pointerId !== event.pointerId) return;
      const delta = event.clientX - pointerStartX;
      if (!dragging && Math.abs(delta) < 7) return;
      dragging = true;
      suppressClick = true;
      snapping = false;
      rotation =
        pointerStartRotation +
        (delta / Math.max(viewport.clientWidth, 1)) * Math.PI;
      targetRotation = rotation;
      activeIndex = wrapHeroCarouselIndex(Math.round(-rotation / step), count);
      updateAccessibleCards(activeIndex, false);
      dirty = true;
      event.preventDefault();
    },
    { signal: listenerController.signal },
  );

  const finishPointer = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
    pointerId = null;
    pointerActive = false;
    const didDrag = dragging;
    dragging = false;
    if (didDrag) goTo(Math.round(-rotation / step), { announce: true });
  };

  viewport.addEventListener("pointerup", finishPointer, {
    signal: listenerController.signal,
  });
  viewport.addEventListener("pointercancel", finishPointer, {
    signal: listenerController.signal,
  });
  viewport.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    },
    { capture: true, signal: listenerController.signal },
  );

  const handleMotionChange = () => {
    if (isReduced()) {
      rotation = nearestHeroCarouselRotation(rotation, activeIndex, count);
      targetRotation = rotation;
      snapping = false;
    }
    updateToggle();
    dirty = true;
  };
  motionQuery.addEventListener("change", handleMotionChange, {
    signal: listenerController.signal,
  });

  htmlObserver = new MutationObserver(handleMotionChange);
  htmlObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-motion"],
  });

  const markDirty = () => {
    dirty = true;
  };
  resizeObserver =
    "ResizeObserver" in window ? new ResizeObserver(markDirty) : null;
  resizeObserver?.observe(viewport);
  if (!resizeObserver) {
    window.addEventListener("resize", markDirty, {
      signal: listenerController.signal,
    });
  }

  intersectionObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          ([entry]) => {
            inView = entry?.isIntersecting ?? true;
          },
          { threshold: 0.05 },
        )
      : null;
  intersectionObserver?.observe(root);

  root.classList.add("is-enhanced");
  track.hidden = true;
  updateToggle();
  updateAccessibleCards(activeIndex, false);
  resizeAndRender();
  frameHandle = window.requestAnimationFrame(animate);

  const handlePageHide = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    disposeEnhanced();
  };
  window.addEventListener("pagehide", handlePageHide, {
    signal: listenerController.signal,
  });
}

function scheduleUpgrade(
  root: HTMLElement,
  fallback: NonNullable<ReturnType<typeof mountFallback>>,
): void {
  const constrained =
    document.documentElement.hasAttribute("data-saver") ||
    !shouldLoadHeavyEnhancement(readConnection());
  if (constrained) return;

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void upgradeToThree(root, fallback).catch(() => {
      // Restore every inline mutation if the 3D upgrade fails after it starts.
      restoreFallback(root, fallback);
    });
  };

  const queueIdle = () => {
    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleWindow.requestIdleCallback(start, { timeout: 2_500 });
    } else {
      window.setTimeout(start, 900);
    }
  };

  const queueAfterLoad = () => {
    if (document.readyState === "complete") queueIdle();
    else window.addEventListener("load", queueIdle, { once: true });
  };

  if (!("IntersectionObserver" in window)) {
    queueAfterLoad();
    return;
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      queueAfterLoad();
    },
    { rootMargin: "180px" },
  );
  observer.observe(root);
}

export function mountHeroContentCarousels(): void {
  document
    .querySelectorAll<HTMLElement>("[data-hero-content-carousel]")
    .forEach((root) => {
      if (mounted.has(root)) return;
      mounted.add(root);
      const fallback = mountFallback(root);
      if (fallback) scheduleUpgrade(root, fallback);
    });
}
