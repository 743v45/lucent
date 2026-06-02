import React, { createContext, useContext } from 'react';
import type { SettingsContextValue } from '../types';

export const SettingsContext = createContext<SettingsContextValue>({
  preferences: {
    theme: 'light',
    activeTab: 'request',
    sidebarWidth: 300,
    autoCollapse: true,
    showThinking: false,
    showFullTools: false,
  },
  updatePreferences: () => {},
});

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
