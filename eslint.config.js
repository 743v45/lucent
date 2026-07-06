import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  // ==================== 忽略 ====================
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'logs/**',
      '*.log',
      'tailwindcss-*.log',
      'settings-modal.png',
    ],
  },

  // ==================== ESLint 基线 ====================
  js.configs.recommended,

  // ==================== typescript-eslint recommended（3 个 config: base + eslint-recommended + recommended） ====================
  ...tsPlugin.configs['flat/recommended'],

  // ==================== 全局 globals + 自定义规则 ====================
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // ==================== 测试文件放宽（e2e/tests 从 helpers 批量导入工具，未用部分属模板代码；Playwright fixture 无依赖时必须用 {} 解构） ====================
  {
    files: ['tests/**', 'e2e/**'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty-pattern': 'off',
    },
  },
];
