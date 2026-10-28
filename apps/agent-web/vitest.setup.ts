import '@testing-library/jest-dom/vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});

type IntersectionObserverCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver,
) => void;

/**
 * jsdom 不提供 IntersectionObserver；用可控 stub 驱动「是否在底部」的组件测试。
 * 测试内通过 (globalThis as any).__triggerIntersection(isIntersecting) 主动触发。
 */
const observerInstances = new Set<ControllableIntersectionObserver>();

class ControllableIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
  private readonly callback: IntersectionObserverCallback;
  readonly targets = new Set<Element>();

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    const threshold = options?.threshold;
    this.thresholds = threshold === undefined
      ? [0]
      : Array.isArray(threshold) ? threshold : [threshold];
    observerInstances.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    observerInstances.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(isIntersecting: boolean): void {
    const entries = [...this.targets].map((target) => ({
      isIntersecting,
      target,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: Date.now(),
    })) as unknown as IntersectionObserverEntry[];
    this.callback(entries, this);
  }
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: ControllableIntersectionObserver,
});

(globalThis as unknown as {
  __triggerIntersection: (isIntersecting: boolean) => void;
  __resetIntersectionObservers: () => void;
}).__triggerIntersection = (isIntersecting: boolean) => {
  for (const observer of [...observerInstances]) {
    observer.trigger(isIntersecting);
  }
};

(globalThis as unknown as {
  __triggerIntersection: (isIntersecting: boolean) => void;
  __resetIntersectionObservers: () => void;
}).__resetIntersectionObservers = () => {
  observerInstances.clear();
};
