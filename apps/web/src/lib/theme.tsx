import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DesignSystemProvider } from '@xploryng/convergencia';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sac.hub.theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  setTheme: () => undefined,
  toggle: () => undefined,
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage can be unavailable (private mode) — fall back to light.
  }
  return 'light';
}

/**
 * Wraps the product in the Convergência `DesignSystemProvider` and owns the
 * light/dark preference. Light is the canonical identity (docs/foundations);
 * dark is available for night shifts and persisted per browser.
 */
export function ThemeRoot({ children }: { children: ReactNode }): JSX.Element {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // ignore storage failures
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: setThemeState,
      toggle: () => setThemeState((current) => (current === 'light' ? 'dark' : 'light')),
    }),
    [theme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <DesignSystemProvider theme={theme} className="sac-app">
        {children}
      </DesignSystemProvider>
    </ThemeContext.Provider>
  );
}
