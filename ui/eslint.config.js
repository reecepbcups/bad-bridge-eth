import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['dist', 'mockup', 'playwright-report', 'test-results', 'test-results-live', 'coverage'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // onClick={() => promise} is the normal React pattern; handle rejections inside the handler
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: ['src/**/*.{ts,tsx}', 'test/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.config.{ts,js}', 'e2e/**/*.ts', 'e2e-live/**/*.ts', 'scripts/**/*.mjs', 'api/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
)
