export const THEME_STORAGE_KEY = "claude_orchestrator_theme";

const COLOR_TOKEN_KEYS = [
  "--md-sys-color-primary",
  "--md-sys-color-on-primary",
  "--md-sys-color-surface",
  "--md-sys-color-surface-container",
  "--md-sys-color-surface-container-high",
  "--md-sys-color-outline",
  "--md-sys-color-on-surface",
  "--md-sys-color-on-surface-variant",
  "--md-sys-color-tertiary-container",
  "--md-sys-color-on-tertiary-container",
] as const;

type ThemeColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];

export interface ThemeDefinition {
  id: string;
  label: string;
  description: string;
  rootText: string;
  rootBackground: string;
  colors: Record<ThemeColorTokenKey, string>;
}

// Add additional themes here by appending to this map.
export const THEMES: Record<string, ThemeDefinition> = {
  dark: {
    id: "dark",
    label: "Dark",
    description: "Dark default with high contrast for long coding sessions.",
    rootText: "#d8dee9",
    rootBackground: "#0b0d12",
    colors: {
      "--md-sys-color-primary": "#8ab4f8",
      "--md-sys-color-on-primary": "#041b3f",
      "--md-sys-color-surface": "#0b0d12",
      "--md-sys-color-surface-container": "#11141b",
      "--md-sys-color-surface-container-high": "#171b24",
      "--md-sys-color-outline": "#3a4353",
      "--md-sys-color-on-surface": "#d8dee9",
      "--md-sys-color-on-surface-variant": "#aab4c3",
      "--md-sys-color-tertiary-container": "#1f1a2b",
      "--md-sys-color-on-tertiary-container": "#d9c8ff",
    },
  },
  light: {
    id: "light",
    label: "Light",
    description: "Light neutral palette for bright environments.",
    rootText: "#1a1f2b",
    rootBackground: "#f4f7fd",
    colors: {
      "--md-sys-color-primary": "#2f5fa3",
      "--md-sys-color-on-primary": "#ffffff",
      "--md-sys-color-surface": "#f4f7fd",
      "--md-sys-color-surface-container": "#ffffff",
      "--md-sys-color-surface-container-high": "#e8edf6",
      "--md-sys-color-outline": "#8c97aa",
      "--md-sys-color-on-surface": "#1a1f2b",
      "--md-sys-color-on-surface-variant": "#556175",
      "--md-sys-color-tertiary-container": "#e8ddff",
      "--md-sys-color-on-tertiary-container": "#3b285f",
    },
  },
};

export type ThemeId = keyof typeof THEMES;

export const DEFAULT_THEME_ID: ThemeId = "dark";

export const THEME_OPTIONS: Array<{ value: ThemeId; label: string; description: string }> = (
  Object.keys(THEMES) as ThemeId[]
).map((id) => ({
  value: id,
  label: THEMES[id].label,
  description: THEMES[id].description,
}));

export function isThemeId(value: string): value is ThemeId {
  return Object.prototype.hasOwnProperty.call(THEMES, value);
}

export function normalizeThemeId(raw: string | null | undefined): ThemeId {
  if (!raw) return DEFAULT_THEME_ID;
  const candidate = raw.trim().toLowerCase();
  return isThemeId(candidate) ? candidate : DEFAULT_THEME_ID;
}

export function getStoredThemeId(): ThemeId {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_ID;
  }
  try {
    return normalizeThemeId(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function applyTheme(themeId: ThemeId): void {
  if (typeof document === "undefined") return;
  const theme = THEMES[themeId] ?? THEMES[DEFAULT_THEME_ID];
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.id);
  root.style.color = theme.rootText;
  root.style.backgroundColor = theme.rootBackground;
  for (const token of COLOR_TOKEN_KEYS) {
    root.style.setProperty(token, theme.colors[token]);
  }
}

export function initializeTheme(): ThemeId {
  const themeId = getStoredThemeId();
  applyTheme(themeId);
  return themeId;
}
