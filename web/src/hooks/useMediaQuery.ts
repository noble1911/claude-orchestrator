import { useState, useEffect } from "react";

/**
 * Returns true when the viewport matches the given CSS media query string.
 * Re-evaluates on window resize via matchMedia listener.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** Viewport is < 768px (phone) */
export function useMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** Viewport is >= 768px and < 1024px (tablet) */
export function useTablet(): boolean {
  return useMediaQuery("(min-width: 768px) and (max-width: 1023px)");
}

/** Viewport is >= 1024px (desktop) */
export function useDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
