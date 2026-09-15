import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      quotes: ['warn', 'single', { avoidEscape: true }],
      semi: ['warn', 'always'],
      'comma-dangle': ['warn', 'always-multiline'],
      indent: ['warn', 2, { SwitchCase: 1 }],
      'eol-last': ['warn', 'always'],
      curly: ['warn', 'all'],
      eqeqeq: ['warn', 'smart'],
      'no-console': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Plain-JS tooling: Node scripts, not part of the TS program.
    files: ['tools/**/*.mjs', 'test/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { console: 'readonly', process: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', Buffer: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } },
    rules: { 'no-console': 'off' },
  },
);
