import js from '@eslint/js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url))

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/data/licenses.generated.ts',
      'src/data/spdx-exceptions.generated.ts',
      'src/data/spdx-license-ids.generated.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
  },
  {
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        AbortController: 'readonly',
        clearTimeout: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
)
