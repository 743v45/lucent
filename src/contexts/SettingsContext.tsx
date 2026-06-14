import { createContext, useContext } from 'react';
import type { SettingsContextValue } from '../types';
import { DEFAULT_THEME, DEFAULT_ACTIVE_TAB, SIDEBAR_DEFAULT_WIDTH } from '../constants';

export const SettingsContext = createContext<SettingsContextValue>({
  preferences: {
    theme: DEFAULT_THEME,
    activeTab: DEFAULT_ACTIVE_TAB as SettingsContextValue['preferences']['activeTab'],
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    autoCollapse: true,
    showThinking: false,
    showFullTools: false,
    conversationView: 'timeline',
  },
  updatePreferences: () => {},
});

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
