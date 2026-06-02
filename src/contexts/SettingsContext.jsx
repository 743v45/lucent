import React from 'react';

export const SettingsContext = React.createContext({
  preferences: {
    theme: 'light',
    activeTab: 'request',
    sidebarWidth: 300,
    autoCollapse: true,
    showThinking: false,
    showFullTools: false,
  },
  updatePreferences: () => {},
  claudeSettings: {},
  updateClaudeSettings: () => {},
});
