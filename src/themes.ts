export const THEME_STORAGE_KEY = "claude_orchestrator_theme";
export const CUSTOM_THEMES_STORAGE_KEY = "claude_orchestrator_custom_themes";

export const COLOR_TOKEN_KEYS = [
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

export type ThemeColorTokenKey = (typeof COLOR_TOKEN_KEYS)[number];
export type ThemeMap = Record<string, ThemeDefinition>;

export interface ThemeDefinition {
  id: string;
  label: string;
  description: string;
  rootText: string;
  rootBackground: string;
  colors: Record<ThemeColorTokenKey, string>;
}

export const THEME_COLOR_FIELDS: Array<{ key: ThemeColorTokenKey; label: string }> = [
  { key: "--md-sys-color-primary", label: "Primary" },
  { key: "--md-sys-color-on-primary", label: "On primary" },
  { key: "--md-sys-color-surface", label: "Surface" },
  { key: "--md-sys-color-surface-container", label: "Surface container" },
  { key: "--md-sys-color-surface-container-high", label: "Surface container high" },
  { key: "--md-sys-color-outline", label: "Outline" },
  { key: "--md-sys-color-on-surface", label: "On surface" },
  { key: "--md-sys-color-on-surface-variant", label: "On surface variant" },
  { key: "--md-sys-color-tertiary-container", label: "Tertiary container" },
  { key: "--md-sys-color-on-tertiary-container", label: "On tertiary container" },
];

const BUILTIN_THEMES: ThemeMap = {
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

export type BuiltInThemeId = keyof typeof BUILTIN_THEMES;

export const DEFAULT_THEME_ID: BuiltInThemeId = "dark";

export function getBuiltinThemes(): ThemeMap {
  return { ...BUILTIN_THEMES };
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

function normalizeThemeDefinition(source: unknown): ThemeDefinition | null {
  if (!source || typeof source !== "object") return null;
  const candidate = source as Partial<ThemeDefinition>;
  const id = typeof candidate.id === "string" ? candidate.id.trim().toLowerCase() : "";
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
  const rootText = typeof candidate.rootText === "string" ? candidate.rootText.trim() : "";
  const rootBackground =
    typeof candidate.rootBackground === "string" ? candidate.rootBackground.trim() : "";
  const colors = candidate.colors;
  if (!id || !label || !description || !isHexColor(rootText) || !isHexColor(rootBackground)) {
    return null;
  }
  if (!colors || typeof colors !== "object") {
    return null;
  }

  const normalizedColors = {} as Record<ThemeColorTokenKey, string>;
  for (const key of COLOR_TOKEN_KEYS) {
    const value = (colors as Record<string, unknown>)[key];
    if (typeof value !== "string" || !isHexColor(value)) {
      return null;
    }
    normalizedColors[key] = value.trim();
  }

  return {
    id,
    label,
    description,
    rootText,
    rootBackground,
    colors: normalizedColors,
  };
}

export function loadCustomThemes(): ThemeMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};

    const output: ThemeMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeThemeDefinition(value);
      if (!normalized) continue;
      // Custom themes cannot override built-ins.
      if (Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, key)) {
        continue;
      }
      output[normalized.id] = normalized;
    }
    return output;
  } catch {
    return {};
  }
}

export function saveCustomThemes(customThemes: ThemeMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(customThemes));
  } catch {
    // Ignore persistence failures and keep runtime state.
  }
}

export function getAllThemes(customThemes: ThemeMap = loadCustomThemes()): ThemeMap {
  return {
    ...BUILTIN_THEMES,
    ...customThemes,
  };
}

export function isBuiltInTheme(themeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, themeId);
}

export function getThemeOptions(themes: ThemeMap): Array<{ value: string; label: string; description: string }> {
  return Object.values(themes).map((theme) => ({
    value: theme.id,
    label: theme.label,
    description: theme.description,
  }));
}

export function normalizeThemeId(raw: string | null | undefined, themes: ThemeMap = getAllThemes()): string {
  if (!raw) return DEFAULT_THEME_ID;
  const candidate = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(themes, candidate) ? candidate : DEFAULT_THEME_ID;
}

export function getStoredThemeId(themes: ThemeMap = getAllThemes()): string {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_ID;
  }
  try {
    return normalizeThemeId(window.localStorage.getItem(THEME_STORAGE_KEY), themes);
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function applyTheme(themeId: string, themes: ThemeMap = getAllThemes()): void {
  if (typeof document === "undefined") return;
  const theme = themes[themeId] ?? themes[DEFAULT_THEME_ID] ?? BUILTIN_THEMES[DEFAULT_THEME_ID];
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.id);
  root.style.color = theme.rootText;
  root.style.backgroundColor = theme.rootBackground;
  for (const token of COLOR_TOKEN_KEYS) {
    root.style.setProperty(token, theme.colors[token]);
  }
}

function slugifyThemeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function createThemeId(label: string, themes: ThemeMap): string {
  const base = slugifyThemeLabel(label) || "custom-theme";
  if (!Object.prototype.hasOwnProperty.call(themes, base)) {
    return base;
  }
  let counter = 2;
  while (Object.prototype.hasOwnProperty.call(themes, `${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export function initializeTheme(): string {
  const themes = getAllThemes();
  const themeId = getStoredThemeId(themes);
  applyTheme(themeId, themes);
  return themeId;
}
