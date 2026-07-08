# what-license

what-license is a privacy-friendly, browser-only tool for identifying likely open-source licenses from pasted license text.

## What This Is

Paste a license, source header, or SPDX license identifier and what-license ranks likely SPDX matches. The tool is designed for quick identification and maintainable license data, not legal review.

## Online Use

Visit **[https://peterdavehello.github.io/what-license/](https://peterdavehello.github.io/what-license/)** to use the tool online.

## Privacy

All matching runs locally in your browser. The pasted text is not uploaded to any server.

## Not Legal Advice

This tool is for quick identification only and does not provide legal advice. Ask a qualified professional when license obligations matter.

## Supported Licenses

The first phase intentionally supports a focused SPDX snapshot instead of the full SPDX catalog.

<!-- supported-licenses:start -->

- 0BSD - BSD Zero Clause License
- AFL-3.0 - Academic Free License v3.0
- AGPL-3.0-only - GNU Affero General Public License v3.0 only
- AGPL-3.0-or-later - GNU Affero General Public License v3.0 or later
- Apache-2.0 - Apache License 2.0
- Artistic-2.0 - Artistic License 2.0
- BSD-2-Clause - BSD 2-Clause "Simplified" License
- BSD-3-Clause - BSD 3-Clause "New" or "Revised" License
- BSL-1.0 - Boost Software License 1.0
- BlueOak-1.0.0 - Blue Oak Model License 1.0.0
- CC0-1.0 - Creative Commons Zero v1.0 Universal
- CDDL-1.0 - Common Development and Distribution License 1.0
- CDDL-1.1 - Common Development and Distribution License 1.1
- EPL-1.0 - Eclipse Public License 1.0
- EPL-2.0 - Eclipse Public License 2.0
- EUPL-1.2 - European Union Public License 1.2
- GPL-2.0-only - GNU General Public License v2.0 only
- GPL-2.0-or-later - GNU General Public License v2.0 or later
- GPL-3.0-only - GNU General Public License v3.0 only
- GPL-3.0-or-later - GNU General Public License v3.0 or later
- ISC - ISC License
- LGPL-2.1-only - GNU Lesser General Public License v2.1 only
- LGPL-2.1-or-later - GNU Lesser General Public License v2.1 or later
- LGPL-3.0-only - GNU Lesser General Public License v3.0 only
- LGPL-3.0-or-later - GNU Lesser General Public License v3.0 or later
- MIT - MIT License
- MIT-0 - MIT No Attribution
- MPL-1.0 - Mozilla Public License 1.0
- MPL-1.1 - Mozilla Public License 1.1
- MPL-2.0 - Mozilla Public License 2.0
- MS-PL - Microsoft Public License
- NCSA - University of Illinois/NCSA Open Source License
- PostgreSQL - PostgreSQL License
- Unlicense - The Unlicense
- WTFPL - Do What The F\*ck You Want To Public License
- Zlib - zlib License
<!-- supported-licenses:end -->

Legacy GNU IDs such as GPL-2.0, GPL-3.0, LGPL-2.1, LGPL-3.0, and AGPL-3.0 are treated as aliases. They are not returned as primary results because SPDX now distinguishes -only and -or-later IDs.

## How To Use

1. Paste license text, a source header, or an SPDX identifier.
2. Review the ranked result cards.
3. Check the confidence, input type, and explanation before relying on the result.
4. Copy the SPDX ID when the result is reliable enough for your workflow.

## Local Development

Use Node.js 22.13.0 from `.nvmrc`.

```sh
npm ci
npm run dev
```

Open the local Vite URL printed by the command.

## Updating License Data

License data is generated from the official SPDX license-list-data repository and checked into source control so the browser app can run without external requests.

```sh
npm run licenses:refresh
npm run licenses:verify
npm run licenses:update-readme
```

When refreshing to a different SPDX version, update the pinned version and
generated data counts in `tests/data.test.ts`, plus the default SPDX version in
`scripts/refresh-spdx.mjs` and documented below, as needed.

Refresh uses SPDX `v3.28.0` by default. Set the
`SPDX_LICENSE_LIST_VERSION` environment variable to refresh from a different
SPDX tag:

```sh
SPDX_LICENSE_LIST_VERSION=v3.27.0 npm run licenses:refresh
```

## Adding A License

1. Add the SPDX ID to `scripts/supported-licenses.mjs`.
2. Update curated title, header alias, and marker heuristics in
   `src/core/classify-input.ts`, `src/data/license-header-aliases.ts`, and
   `src/core/normalize.ts` when the new license should be recognized from short
   titles, alternate headers, or comment markers.
3. Run `npm run licenses:refresh`.
4. Run `npm run licenses:verify`.
5. Run `npm run licenses:update-readme`.
6. Add or update affected tests or fixtures, including `tests/data.test.ts` when the supported license count changes.
7. Run the full local verification commands.

## Tests

```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

## Known Limits

- The first phase supports a focused set of common licenses, not the full SPDX list.
- SPDX expression syntax is recognized, but compound expressions and WITH exceptions are not resolved into license results yet.
- Package manifest analysis, repository URL analysis, CLI support, and license compatibility checks are out of scope for v0.1.0.
- Results are heuristic and should be reviewed when compliance or legal risk matters.

## Roadmap

- Expand SPDX license and exception coverage.
- Resolve compound SPDX expressions and WITH exceptions into structured results.
- Add package manifest and repository analysis.
- Consider CLI support after the browser core stabilizes.

## License

Apache-2.0
