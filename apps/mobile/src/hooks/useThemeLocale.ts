import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { normalizeLocale } from '@aidb/core';
import { setLocale, type Locale } from '../i18n';
import { applyTheme } from '../styles';
import type { ThemeResolved } from '../theme';

export function useThemeLocale() {
  const scheme = useColorScheme();
  const [themeMode, setThemeMode] = useState<'dark' | 'light' | 'system'>(() => {
    try {
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('aidb.mobile.theme') : null;
      return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
    } catch {
      return 'system';
    }
  });
  const resolvedTheme: ThemeResolved = themeMode === 'system' ? (scheme === 'light' ? 'light' : 'dark') : themeMode;
  applyTheme(resolvedTheme);
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('aidb.mobile.locale') : null;
      return normalizeLocale(stored ?? 'en');
    } catch {
      return 'en';
    }
  });
  setLocale(locale);
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('aidb.mobile.locale', locale);
    } catch {
      /* ignore */
    }
  }, [locale]);
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('aidb.mobile.theme', themeMode);
    } catch {
      /* ignore */
    }
  }, [themeMode]);

  return { themeMode, setThemeMode, resolvedTheme, locale, setLocale: setLocaleState };
}
