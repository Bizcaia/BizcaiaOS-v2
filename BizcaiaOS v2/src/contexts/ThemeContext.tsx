import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
type ContextValue = { theme: Theme; setTheme: (theme: Theme) => void };
const ThemeContext = createContext<ContextValue | null>(null);
export function ThemeProvider({ defaultTheme = 'light', children }: { defaultTheme?: Theme; children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('bizcaiaos-theme') as Theme) || defaultTheme);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('bizcaiaos-theme', theme); }, [theme]);
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
export function useTheme() { const value = useContext(ThemeContext); if (!value) throw new Error('useTheme must be used within ThemeProvider'); return value; }
