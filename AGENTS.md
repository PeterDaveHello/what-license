# Repository Guidelines

## Project Structure & Module Organization

`what-license` is a Vite + TypeScript browser app for identifying likely SPDX
licenses from local input. Application code lives under `src/`: matching logic is
in `src/core/`, generated and curated license data is in `src/data/`, and DOM UI
helpers are in `src/ui/`. Unit tests live in `tests/`, Playwright smoke tests in
`e2e/`, and SPDX maintenance scripts in `scripts/`. Build output goes to `dist/`
and should not be edited directly.

## Build, Test, and Development Commands

Use Node.js 22.13.0 from `.nvmrc`.

- `npm ci` installs locked dependencies.
- `npm run dev` starts the local Vite server.
- `npm run build` runs `tsc --noEmit` and builds the production bundle.
- `npm test` runs Vitest unit tests once.
- `npm run test:e2e` runs Playwright smoke tests.
- `npm run lint` runs ESLint across the repo.
- `npm run format` checks Prettier formatting; `npm run format:fix` rewrites it.
- `npm run licenses:verify` checks generated license data consistency.
- `npm run licenses:refresh` regenerates SPDX data from SPDX `v3.28.0` by
  default. To refresh from a different SPDX tag, set the
  `SPDX_LICENSE_LIST_VERSION` environment variable, for example
  `SPDX_LICENSE_LIST_VERSION=v3.27.0 npm run licenses:refresh`, and follow
  with `npm run licenses:update-readme` when the supported list changes.

## Adding a License

Follow the README checklist, and update affected tests or fixtures, including
`tests/data.test.ts` when the supported license count changes.

## Coding Style & Naming Conventions

Write TypeScript as ES modules. Follow existing Prettier settings: single quotes
and no semicolons. Use two-space indentation, descriptive camelCase variables and
functions, and PascalCase only for types. Keep pure matching code in `src/core/`
separate from DOM behavior in `src/ui/`. Do not hand-edit
`src/data/licenses.generated.ts` or `src/data/spdx-exceptions.generated.ts`;
update source lists and rerun the scripts.

## Testing Guidelines

Use Vitest for unit tests named `*.test.ts` under `tests/`. Keep fixtures in
`tests/fixtures/` when test inputs are long or security-sensitive. Use Playwright
for browser flows in `e2e/**/*.spec.ts`; the config starts `npm run dev` on
`127.0.0.1:5173`. For behavior changes, run `npm run lint`, `npm test`, and
`npm run build`; run `npm run test:e2e` for UI or file-drop changes.

## Commit & Pull Request Guidelines

Recent commits use short, capitalized, imperative subjects such as
`Add the license matching core`; avoid Conventional Commit prefixes unless the
project adopts them later. Keep commits focused and explain what and why in the
body when the subject is not enough. Pull requests should describe the user-facing
change, list verification commands run, link related issues, and include
screenshots for visible UI changes. Mention generated SPDX or README list updates
explicitly.

## Agent-Specific Instructions

Keep diffs minimal and repository-scoped. Avoid unrelated generated-output churn,
especially in `dist/`, `src/data/licenses.generated.ts`, and
`src/data/spdx-exceptions.generated.ts`. For behavior changes, follow the
Testing Guidelines section above: run `npm run lint`, `npm test`, and
`npm run build`, and include `npm run test:e2e` for UI or file-drop changes.
Use the smallest relevant verification command only as a fallback for truly
narrow non-behavior fixes, and report any command that could not be completed.
