"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type UserLanguage = "zh-CN" | "en";
export type ColorTheme = "light" | "dark" | "system";

type UserPreferences = {
  language: UserLanguage;
  color_theme: ColorTheme;
};

type UserPreferencesContextValue = UserPreferences & {
  setColorTheme: (theme: ColorTheme) => void;
  setLanguage: (language: UserLanguage) => void;
};

const UserPreferencesContext = createContext<UserPreferencesContextValue | null>(null);

function apiUrl() {
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  return `${configured ?? `${window.location.protocol}//${window.location.hostname}:3005`}/api/preferences`;
}

async function request(init?: RequestInit): Promise<UserPreferences> {
  const response = await fetch(apiUrl(), init);
  const payload = await response.json() as UserPreferences & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

export function UserPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<UserPreferences>({
    language: "zh-CN",
    color_theme: "system",
  });
  const localRevision = useRef(0);

  const apply = useCallback((next: UserPreferences) => {
    setPreferences(next);
    localStorage.setItem("capybara-locale", next.language);
    localStorage.setItem("capybara-theme", next.color_theme);
    document.documentElement.dataset.locale = next.language;
    document.documentElement.lang = next.language;
  }, []);

  useEffect(() => {
    const revision = localRevision.current;
    const cachedLanguage = document.documentElement.dataset.locale;
    const cachedTheme = document.documentElement.dataset.themeMode;
    let frame: number | undefined;
    if (
      (cachedLanguage === "zh-CN" || cachedLanguage === "en") &&
      (cachedTheme === "light" || cachedTheme === "dark" || cachedTheme === "system")
    ) {
      frame = requestAnimationFrame(() => {
        apply({ language: cachedLanguage, color_theme: cachedTheme });
      });
    }
    void request().then((loaded) => {
      if (localRevision.current !== revision) return;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      apply(loaded);
    }).catch(() => undefined);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [apply]);

  const persist = useCallback((changes: Partial<UserPreferences>) => {
    void request({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(changes),
    }).catch(() => undefined);
  }, []);

  const setLanguage = useCallback((language: UserLanguage) => {
    localRevision.current += 1;
    setPreferences((current) => ({ ...current, language }));
    localStorage.setItem("capybara-locale", language);
    document.documentElement.dataset.locale = language;
    document.documentElement.lang = language;
    persist({ language });
  }, [persist]);

  const setColorTheme = useCallback((color_theme: ColorTheme) => {
    localRevision.current += 1;
    setPreferences((current) => ({ ...current, color_theme }));
    localStorage.setItem("capybara-theme", color_theme);
    persist({ color_theme });
  }, [persist]);

  const value = useMemo(() => ({
    ...preferences,
    setColorTheme,
    setLanguage,
  }), [preferences, setColorTheme, setLanguage]);

  return (
    <UserPreferencesContext.Provider value={value}>
      {children}
    </UserPreferencesContext.Provider>
  );
}

export function useUserPreferences() {
  const context = useContext(UserPreferencesContext);
  if (!context) throw new Error("useUserPreferences must be used within UserPreferencesProvider");
  return context;
}
