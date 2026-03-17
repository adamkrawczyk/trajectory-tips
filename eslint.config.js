import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['index.json', 'tips/**']
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'bin/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  }
];
