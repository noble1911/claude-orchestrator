import { useRef, useEffect, type RefObject } from "react";

interface SwipeHandlers {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

const SWIPE_THRESHOLD = 60;
const SWIPE_MAX_VERTICAL = 80;

/**
 * Attaches touch-based swipe detection to a ref'd element.
 * Fires onSwipeLeft / onSwipeRight when a horizontal swipe exceeds the threshold.
 */
export function useSwipe<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handlers: SwipeHandlers,
) {
  const startX = useRef(0);
  const startY = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      startX.current = e.touches[0].clientX;
      startY.current = e.touches[0].clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX.current;
      const dy = Math.abs(e.changedTouches[0].clientY - startY.current);
      if (dy > SWIPE_MAX_VERTICAL) return; // too vertical, ignore

      if (dx > SWIPE_THRESHOLD) {
        handlers.onSwipeRight?.();
      } else if (dx < -SWIPE_THRESHOLD) {
        handlers.onSwipeLeft?.();
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, [ref, handlers.onSwipeLeft, handlers.onSwipeRight]); // eslint-disable-line react-hooks/exhaustive-deps
}
