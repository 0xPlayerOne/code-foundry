# Changelog

## [0.32.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.32.1...v0.32.2) (2026-07-31)


### Bug Fixes

* **release:** mirror staging onto main and require rebase merges on main ([31ab9b1](https://github.com/0xPlayerOne/code-foundry/commit/31ab9b125e66ae35f7d2a2c6893d0a3aec5d4560))
* **release:** synchronize staging with a linear commit instead of a blocked fast-forward ([b808dff](https://github.com/0xPlayerOne/code-foundry/commit/b808dffeae38ec8211f8f0dee79e19d60f70b708))

## [0.32.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.32.0...v0.32.1) (2026-07-31)


### Bug Fixes

* **ci:** key runtime concurrency by event so promotion PRs do not cancel push checks ([5a8d8fd](https://github.com/0xPlayerOne/code-foundry/commit/5a8d8fd80e62feabc887869e07219a77f2c46c1a))
* **release:** bootstrap release-please manifest during sync ([98c7e5d](https://github.com/0xPlayerOne/code-foundry/commit/98c7e5d9341eedf22d49611f19825a5ef8d6d596))
* **release:** satisfy JSDoc type-check for manifest bootstrap ([02ddb45](https://github.com/0xPlayerOne/code-foundry/commit/02ddb459405ee9d54c91afdc3cf5602790a4c2b4))
* **release:** squash release PRs so staging can fast-forward after releases ([5d9a788](https://github.com/0xPlayerOne/code-foundry/commit/5d9a78843fde4ce764237eacfde9b1720d15696e))

## [0.32.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.18...v0.32.0) (2026-07-31)


### Features

* improve draft PR titles from branch conventions ([#290](https://github.com/0xPlayerOne/code-foundry/issues/290)) ([7b215db](https://github.com/0xPlayerOne/code-foundry/commit/7b215db961347dfdb74241fc2c3489d390b34533))

## [0.31.18](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.17...v0.31.18) (2026-07-30)


### Bug Fixes

* **codeql:** keep generated config in workspace ([9ca8f3b](https://github.com/0xPlayerOne/code-foundry/commit/9ca8f3b958e40209727f305bd0c0856f4820e1b6))

## [0.31.17](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.16...v0.31.17) (2026-07-30)


### Bug Fixes

* **sync:** preserve repository release policy ([8a8291b](https://github.com/0xPlayerOne/code-foundry/commit/8a8291b940bcc777e4aa9a426e56235b031fd002))

## [0.31.16](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.15...v0.31.16) (2026-07-30)


### Bug Fixes

* **release:** avoid duplicate release PR checks ([42d7354](https://github.com/0xPlayerOne/code-foundry/commit/42d735404cd7b77d5a30a03a4fb8856096e931b0))
* **workflows:** validate main promotion PRs ([4f41f90](https://github.com/0xPlayerOne/code-foundry/commit/4f41f90a3e4a5eec8e80d46c21083c1380655341))

## [0.31.15](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.14...v0.31.15) (2026-07-30)


### Bug Fixes

* **release:** suppress release-only promotion loops ([fb35a6f](https://github.com/0xPlayerOne/code-foundry/commit/fb35a6f6e03a8ab4da65eeaeeeec579389b508b3))

## [0.31.14](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.13...v0.31.14) (2026-07-30)


### Bug Fixes

* **codeql:** make Rust parallelism safe and configurable ([545454f](https://github.com/0xPlayerOne/code-foundry/commit/545454fa42a8bb4e6970ff858af186f1cba09900))

## [0.31.13](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.12...v0.31.13) (2026-07-30)


### Bug Fixes

* **runtime:** pin template defaults to v0.31.12 ([f84b62d](https://github.com/0xPlayerOne/code-foundry/commit/f84b62d50955c623b9bc67e981645d9c0fcb2bcd))

## [0.31.12](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.11...v0.31.12) (2026-07-30)


### Bug Fixes

* **package:** include ruff baseline ([645f63e](https://github.com/0xPlayerOne/code-foundry/commit/645f63e9e66d67338345bb3eb14949543f97f89b))

## [0.31.11](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.10...v0.31.11) (2026-07-30)


### Bug Fixes

* **package:** include prettier ignore baseline ([4cf91e1](https://github.com/0xPlayerOne/code-foundry/commit/4cf91e1d0ec6b53e3751469937b44f903ef09466))

## [0.31.10](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.9...v0.31.10) (2026-07-30)


### Bug Fixes

* **opencode:** avoid duplicate self checks ([71b1201](https://github.com/0xPlayerOne/code-foundry/commit/71b1201baf58624401676b99fa257780b1eb1abc))

## [0.31.9](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.8...v0.31.9) (2026-07-30)


### Bug Fixes

* **doctor:** deduplicate required check contexts ([f244494](https://github.com/0xPlayerOne/code-foundry/commit/f24449448f177c99978fe216b92385909f275d89))

## [0.31.8](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.7...v0.31.8) (2026-07-30)


### Bug Fixes

* **runtime:** pin self workflows to v0.31.7 ([565b5bc](https://github.com/0xPlayerOne/code-foundry/commit/565b5bcc2b8f4ade8b3addc02f72c96a42308325))

## [0.31.7](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.6...v0.31.7) (2026-07-30)


### Bug Fixes

* **ci:** remove duplicate promotion checks ([b210b7f](https://github.com/0xPlayerOne/code-foundry/commit/b210b7f0aa5bdb6cb7e121cc751b6f618512ebf3))

## [0.31.6](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.5...v0.31.6) (2026-07-30)


### Bug Fixes

* **release:** skip identical promotion trees ([d8242b9](https://github.com/0xPlayerOne/code-foundry/commit/d8242b9897c9210a2534712fedb12d2258573686))

## [0.31.5](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.4...v0.31.5) (2026-07-30)


### Bug Fixes

* **ci:** isolate reusable workflow concurrency ([330a939](https://github.com/0xPlayerOne/code-foundry/commit/330a9396390aef11a482bf370dbbbee22151759e))
* **ci:** use stable workflow concurrency keys ([a7eca35](https://github.com/0xPlayerOne/code-foundry/commit/a7eca35836f24f9fb240234b999462f95fa4e7da))
* **ci:** validate main promotion pull requests ([00377bb](https://github.com/0xPlayerOne/code-foundry/commit/00377bb6e54288e296245efa1466e8e61477f25a))
* **release:** allow manual promotion validation ([aaa453f](https://github.com/0xPlayerOne/code-foundry/commit/aaa453f3bc63c4e256352f094468f983dad236a9))
* **release:** promote staging runtime safeguards ([e53df8c](https://github.com/0xPlayerOne/code-foundry/commit/e53df8cca59e59a8ffd7aad3f05effc915ba2196))

## [0.31.4](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.3...v0.31.4) (2026-07-29)


### Bug Fixes

* harden fleet pins and github doctor ([c6efa7a](https://github.com/0xPlayerOne/code-foundry/commit/c6efa7a436308959950d958c5897574193cd763b))

## [0.31.3](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.2...v0.31.3) (2026-07-29)


### Bug Fixes

* **ci:** isolate runtime from consumer tooling ([9bb07da](https://github.com/0xPlayerOne/code-foundry/commit/9bb07daa383a3ec89a57c6279546f1d8d4483457))
* **ci:** keep runtime out of project tooling ([0aec04a](https://github.com/0xPlayerOne/code-foundry/commit/0aec04a01f6378f165b83dbedde670ddee61657e))

## [0.31.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.1...v0.31.2) (2026-07-29)


### Bug Fixes

* **release:** treat identical branch trees as aligned ([32b739e](https://github.com/0xPlayerOne/code-foundry/commit/32b739e8e663dca05fd89005b26c6457ec265c1c))

## [0.31.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.31.0...v0.31.1) (2026-07-29)


### Bug Fixes

* **release:** build clean staging sync branches ([03a7c19](https://github.com/0xPlayerOne/code-foundry/commit/03a7c191d7a5a6b95cce639e6ed9201b374f1010))

## [0.31.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.30.4...v0.31.0) (2026-07-29)


### Features

* **release:** open safe staging sync PRs ([6adb1dc](https://github.com/0xPlayerOne/code-foundry/commit/6adb1dc63966e5bfe70deb3ccd3c3aa5e93ccfad))


### Bug Fixes

* **release:** compare promoted branch tips ([081666b](https://github.com/0xPlayerOne/code-foundry/commit/081666b774418ab333d34eb9a3ca2a8c3bd60c78))

## [0.30.4](https://github.com/0xPlayerOne/code-foundry/compare/v0.30.3...v0.30.4) (2026-07-29)


### Bug Fixes

* **ci:** isolate runtime from consumer tooling ([32fe3ee](https://github.com/0xPlayerOne/code-foundry/commit/32fe3eea20ddad6086c1cfcacff6e7cb90606da0))
* **self-ci:** test the checked-out runtime revision ([93973ba](https://github.com/0xPlayerOne/code-foundry/commit/93973bac19da7d250e3ccda4d4c79b1b0033008b))

## [0.30.3](https://github.com/0xPlayerOne/code-foundry/compare/v0.30.2...v0.30.3) (2026-07-29)


### Bug Fixes

* **fleet:** branch upgrades from remote staging ([58d4389](https://github.com/0xPlayerOne/code-foundry/commit/58d43890436789ec5289e0aaeea71dea0375a140))

## [0.30.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.30.1...v0.30.2) (2026-07-29)


### Bug Fixes

* **fleet:** support explicit repository exclusions ([2c3a641](https://github.com/0xPlayerOne/code-foundry/commit/2c3a641814de392457f94f3581f01e5b625056ee))

## [0.30.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.30.0...v0.30.1) (2026-07-29)


### Bug Fixes

* **release:** retry generated PR discovery ([dba7233](https://github.com/0xPlayerOne/code-foundry/commit/dba72337a04e73a2436d417b9e6f68d67bf54f83))
* **sync:** include Python formatter baseline ([c7ce208](https://github.com/0xPlayerOne/code-foundry/commit/c7ce2084dcc7a7a3372056b879f435276e31aaa0))

## [0.30.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.29.0...v0.30.0) (2026-07-29)


### Features

* **ci:** recommend stack-aware runners ([83df327](https://github.com/0xPlayerOne/code-foundry/commit/83df32777344898651d71af28496202337ae6788))
* **doctor:** validate GitHub release configuration ([877525c](https://github.com/0xPlayerOne/code-foundry/commit/877525c11f6713b235aa3945dd98d017bef5732e))
* **fleet:** add isolated repository upgrades ([76d1765](https://github.com/0xPlayerOne/code-foundry/commit/76d176593ea025a2090bd62f21b275d261d3a9d5))
* **release:** add exactly-once post-release hooks ([f4ffa13](https://github.com/0xPlayerOne/code-foundry/commit/f4ffa136ef972665fe269b6685f9c4b840fc95a9))
* **release:** add non-destructive recovery planning ([6c45592](https://github.com/0xPlayerOne/code-foundry/commit/6c45592358d9ceb0335acc6584ac565971433737))
* **security:** add opt-in OpenCode release scan ([34512c1](https://github.com/0xPlayerOne/code-foundry/commit/34512c1507519d2b37a9bd665243490fa888beb9))
* **sync:** formalize custom workflow overlays ([ee540f9](https://github.com/0xPlayerOne/code-foundry/commit/ee540f9a80c0b128100e795471042fc12aefc226))


### Bug Fixes

* **release:** grant post-release dispatch permission ([c18a52d](https://github.com/0xPlayerOne/code-foundry/commit/c18a52dff2ac76e648eeb9fa1f92fab8a01dafec))

## [0.29.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.28.0...v0.29.0) (2026-07-29)


### Features

* **release:** detect mixed-language release manifests ([f2daa61](https://github.com/0xPlayerOne/code-foundry/commit/f2daa616f2d8cfd2883f960823e862768454fbd6))

## [0.28.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.18...v0.28.0) (2026-07-29)


### Features

* **release:** reconcile staging after release metadata ([4de1ad6](https://github.com/0xPlayerOne/code-foundry/commit/4de1ad64bd9276344368934ab555e6cb31a90784))

## [0.27.18](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.17...v0.27.18) (2026-07-29)


### Bug Fixes

* **release:** degrade gracefully without release token ([69ac43a](https://github.com/0xPlayerOne/code-foundry/commit/69ac43acfa2813495b8da0535942afbbedae3017))

## [0.27.17](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.16...v0.27.17) (2026-07-29)


### Bug Fixes

* **release:** auto-merge generated version PRs ([3032cfc](https://github.com/0xPlayerOne/code-foundry/commit/3032cfc458e4508ad637354ee98447c544a5a1d4))

## [0.27.16](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.15...v0.27.16) (2026-07-29)

### Bug Fixes

- **release:** honor manifest configuration ([2beb320](https://github.com/0xPlayerOne/code-foundry/commit/2beb32053e5b86319a3c44377e4cbe2f20592507))
- **release:** pass committed manifest config ([39ef227](https://github.com/0xPlayerOne/code-foundry/commit/39ef227828d9c7903e9d08cfcd0dd755f41a7c78))

## [0.27.15](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.14...v0.27.15) (2026-07-29)

### Bug Fixes

- **ci:** remove stale CodeQL change detection ([897d749](https://github.com/0xPlayerOne/code-foundry/commit/897d749d296c02751fda764b9fa069e32208182b))

## [0.27.14](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.13...v0.27.14) (2026-07-29)

### Bug Fixes

- **codeql:** skip unavailable analyzers ([9ddf8e3](https://github.com/0xPlayerOne/code-foundry/commit/9ddf8e30dab4da2ba1f6bb20dd3503e56ab1b880))
- **draft-pr:** pass repository explicitly ([6fbf289](https://github.com/0xPlayerOne/code-foundry/commit/6fbf289649ce2097e42b156cf2db0c39fb8ceee1))
- **draft-pr:** use explicit repository for lookups ([e498d6e](https://github.com/0xPlayerOne/code-foundry/commit/e498d6e125099e2437041112e1b3442a7ebea389))

## [0.27.13](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.12...v0.27.13) (2026-07-29)

### Bug Fixes

- **sync:** package the gitignore template ([e65c63d](https://github.com/0xPlayerOne/code-foundry/commit/e65c63dcb09a623d5ce0b55f734bbe73719c72f2))

## [0.27.12](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.11...v0.27.12) (2026-07-29)

### Bug Fixes

- **security:** skip irrelevant dependency audits ([cc206d4](https://github.com/0xPlayerOne/code-foundry/commit/cc206d4dea5311684b79ef3a04669aa7ce74421a))

## [0.27.11](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.10...v0.27.11) (2026-07-29)

### Bug Fixes

- **ci:** isolate reusable workflow concurrency ([ddfc3a6](https://github.com/0xPlayerOne/code-foundry/commit/ddfc3a6b8860629a12494ffd8ef273dfb2c354b4))
- **workflows:** clarify Code Foundry job hierarchy ([124327e](https://github.com/0xPlayerOne/code-foundry/commit/124327ec3f8f5907eca478580a62b7485e0cfd98))

## [0.27.10](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.9...v0.27.10) (2026-07-28)

### Bug Fixes

- **codeql:** make analyzer checks protection-safe ([5ab240e](https://github.com/0xPlayerOne/code-foundry/commit/5ab240e6ce62c2d87acf92f8776a107cffefd860))

## [0.27.9](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.8...v0.27.9) (2026-07-28)

### Bug Fixes

- **ci:** hoist Bun workspace dependencies ([f480ad6](https://github.com/0xPlayerOne/code-foundry/commit/f480ad671cf12435f632d9397dbc8f72d7a2e8fe))

## [0.27.8](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.7...v0.27.8) (2026-07-28)

### Bug Fixes

- **ci:** run required Bun postinstall setup safely ([0302604](https://github.com/0xPlayerOne/code-foundry/commit/0302604f877bedbef8d3ab06794ffd9599fb774c))

## [0.27.7](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.6...v0.27.7) (2026-07-28)

### Bug Fixes

- **ci:** avoid recursive Bun install lifecycle scripts ([780e90d](https://github.com/0xPlayerOne/code-foundry/commit/780e90dcbc4a93005091465594cb57d9d2154003))

## [0.27.6](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.5...v0.27.6) (2026-07-28)

### Bug Fixes

- **ci:** force complete Bun workspace installs ([1d391b8](https://github.com/0xPlayerOne/code-foundry/commit/1d391b8e481acd91d7ae293cdbbfc090a891dc47))

## [0.27.5](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.4...v0.27.5) (2026-07-28)

### Bug Fixes

- **ci:** install Rust formatting and lint components ([16da3fc](https://github.com/0xPlayerOne/code-foundry/commit/16da3fc416e64b2c5c62d2f3a7feaa270134c1a2))
- **test:** skip absent Python integration suites ([ee932ce](https://github.com/0xPlayerOne/code-foundry/commit/ee932cea048dc94175f395ac49ca65ed9dbb466f))

## [0.27.4](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.3...v0.27.4) (2026-07-28)

### Bug Fixes

- **runtime:** resolve Python tools from virtualenv ([788b1ae](https://github.com/0xPlayerOne/code-foundry/commit/788b1ae438451ee57ce55a8669d2710cb8755fcf))

## [0.27.3](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.2...v0.27.3) (2026-07-28)

### Bug Fixes

- **ci:** auto-detect format tooling ([2be5228](https://github.com/0xPlayerOne/code-foundry/commit/2be522821b5d3f93b92ca5e2c4b20df345396fc3))

## [0.27.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.1...v0.27.2) (2026-07-28)

### Bug Fixes

- **runtime:** harden dependency setup and audits ([f3c4f85](https://github.com/0xPlayerOne/code-foundry/commit/f3c4f85263232e5023e7e6b3ae50ad2c27f3a47a))

## [0.27.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.27.0...v0.27.1) (2026-07-28)

### Bug Fixes

- **ci:** cover framework and native test prerequisites ([53b8209](https://github.com/0xPlayerOne/code-foundry/commit/53b8209104cf52972e867eba65fed46d0b8f57bb))
- **ci:** install project format and Python tooling ([13fb972](https://github.com/0xPlayerOne/code-foundry/commit/13fb972e774e26c2d5794421a17c4ac685a28b0c))

## [0.27.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.26.0...v0.27.0) (2026-07-28)

### Features

- add typed javascript cli checks ([2d9464b](https://github.com/0xPlayerOne/code-foundry/commit/2d9464bcbef8aa51607cdf52a6a60e3fc1bdb054))
- make mise an optional toolchain ([e62f023](https://github.com/0xPlayerOne/code-foundry/commit/e62f0238f4ddc2d1b0f89e0f2b23bca3679b934e))
- make paid github security checks opt-in ([bbfe899](https://github.com/0xPlayerOne/code-foundry/commit/bbfe8993d88a8415129ce29bfa5d2181807232ba))
- skip irrelevant language configuration ([39a0003](https://github.com/0xPlayerOne/code-foundry/commit/39a00037ba92152926e7a89759f3255d86a4f26e))
- standardize optional github security policies ([2cf6bc3](https://github.com/0xPlayerOne/code-foundry/commit/2cf6bc3af161ed8757a03447aab16f3e7ea310d7))

### Bug Fixes

- include runtime libraries in every workflow job ([ce94cd9](https://github.com/0xPlayerOne/code-foundry/commit/ce94cd96a32eff54048712e1bf4b2d34a868ba2e))
- include runtime libraries in workflow checkout ([4b2c252](https://github.com/0xPlayerOne/code-foundry/commit/4b2c2527c37c82b498c2b3457df5dd52ef7c694f))
- migrate stale managed docs during sync ([380bab1](https://github.com/0xPlayerOne/code-foundry/commit/380bab1334c9125f97bf333cc29c796e1a16d57d))
- preserve authored notice files ([342e666](https://github.com/0xPlayerOne/code-foundry/commit/342e666f4e218e094180f10ecdc5a24b85a27b28))
- preserve repository notice attribution ([7d43911](https://github.com/0xPlayerOne/code-foundry/commit/7d439117ec89882d8d06895528d94ed717ade471))
- use pinned bun lockfile format ([0f75faf](https://github.com/0xPlayerOne/code-foundry/commit/0f75faf2c7614cc7055cbb4f26a01b3cf1639f85))

## [0.26.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.25.0...v0.26.0) (2026-07-28)

### Features

- default new repositories to gplv3 ([e200135](https://github.com/0xPlayerOne/code-foundry/commit/e200135939779693eb73a64aaf3587eccdc36ffc))

## [0.25.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.24.1...v0.25.0) (2026-07-28)

### Features

- simplify reusable workflow layout ([293b2a8](https://github.com/0xPlayerOne/code-foundry/commit/293b2a877500853778f311763cd4176e86f0b4f8))

### Bug Fixes

- use local self workflow references ([31ea5a5](https://github.com/0xPlayerOne/code-foundry/commit/31ea5a5a621039afd8e19febe9d2a9f814c9d6fa))

## [0.24.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.24.0...v0.24.1) (2026-07-28)

### Bug Fixes

- remove obsolete consumer helper ([4fcf85b](https://github.com/0xPlayerOne/code-foundry/commit/4fcf85b2c452e08aab47ec1fb6e00cdce5523cff))

## [0.24.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.23.1...v0.24.0) (2026-07-28)

### Features

- minimize consumer footprint ([2b29d2e](https://github.com/0xPlayerOne/code-foundry/commit/2b29d2e09072492c8ee8fc642d0477f416805cf2))

## [0.23.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.23.0...v0.23.1) (2026-07-28)

### Bug Fixes

- support repositories without package managers ([a126945](https://github.com/0xPlayerOne/code-foundry/commit/a126945d259875763ce89ddb3c0dbc182b74bb76))

## [0.23.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.22.2...v0.23.0) (2026-07-28)

### Features

- simplify initialization and synchronization ([9f4643e](https://github.com/0xPlayerOne/code-foundry/commit/9f4643e854a262eb923a4fe84ddb986c3f1bdf77))

## [0.22.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.22.1...v0.22.2) (2026-07-28)

### Bug Fixes

- remove legacy config after migration ([839a4bd](https://github.com/0xPlayerOne/code-foundry/commit/839a4bd7d818633f1aef201b4a2b3292218563f4))

## [0.22.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.22.0...v0.22.1) (2026-07-28)

### Bug Fixes

- pin callers to the canonical runtime ([321b93f](https://github.com/0xPlayerOne/code-foundry/commit/321b93fff2089ee61fa41f968ee584af864692b2))

## [0.22.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.21.2...v0.22.0) (2026-07-28)

### Features

- centralize repository configuration ([e1b4ef1](https://github.com/0xPlayerOne/code-foundry/commit/e1b4ef19ab1ecc899c06331cbfd3477062a73549))

### Bug Fixes

- bridge legacy runtime configuration ([d906b0d](https://github.com/0xPlayerOne/code-foundry/commit/d906b0d8f0bc65d2697ababbd5ab658ca2193684))
- keep legacy runtime callers valid ([c23f9e2](https://github.com/0xPlayerOne/code-foundry/commit/c23f9e2980bfcb8a0b7c685f1a9ba6d26f215eba))

## [0.21.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.21.1...v0.21.2) (2026-07-28)

### Bug Fixes

- **docs:** clarify package verification ([b2bb12d](https://github.com/0xPlayerOne/code-foundry/commit/b2bb12d1674acefe5e874df280dfd083f9966e19))

## [0.21.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.21.0...v0.21.1) (2026-07-28)

### Bug Fixes

- **template:** align reusable runtime pins ([c3195e8](https://github.com/0xPlayerOne/code-foundry/commit/c3195e8a3320821c5f891ef942cf5df59ecd09bb))

## [0.21.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.20.3...v0.21.0) (2026-07-28)

### Features

- **runtime:** configure reusable workflow refs ([55f20d2](https://github.com/0xPlayerOne/code-foundry/commit/55f20d278f23ece1fed1166f1cad1b15c985ee90))

## [0.20.3](https://github.com/0xPlayerOne/code-foundry/compare/v0.20.2...v0.20.3) (2026-07-28)

### Bug Fixes

- **release-pr:** pin no-op runtime ([af662ef](https://github.com/0xPlayerOne/code-foundry/commit/af662ef7206269f03438bc3983878024629f6056))

## [0.20.2](https://github.com/0xPlayerOne/code-foundry/compare/v0.20.1...v0.20.2) (2026-07-28)

### Bug Fixes

- **release-pr:** skip empty promotions ([7c3b21b](https://github.com/0xPlayerOne/code-foundry/commit/7c3b21b19e03ac8319b1217d4e3d0d8a6f0e2317))

## [0.20.1](https://github.com/0xPlayerOne/code-foundry/compare/v0.20.0...v0.20.1) (2026-07-28)

### Bug Fixes

- **workflows:** align callers with current runtime ([11629d3](https://github.com/0xPlayerOne/code-foundry/commit/11629d32b4c41a8bfd1ff8fdaa5638c43236e889))
- **workflows:** correct release caller indentation ([2688ca9](https://github.com/0xPlayerOne/code-foundry/commit/2688ca924552c9537151e76f486f6485bd4fb0d9))

## [0.20.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.19.0...v0.20.0) (2026-07-28)

### Features

- **workflows:** use reusable promotion callers ([8429b8f](https://github.com/0xPlayerOne/code-foundry/commit/8429b8f9dee4fa0eedce2d8342332603e88e3f38))

## [0.19.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.18.0...v0.19.0) (2026-07-28)

### Features

- **workflows:** add reusable promotion runtimes ([ac113a9](https://github.com/0xPlayerOne/code-foundry/commit/ac113a902700957cbf26d4a47b4e7828b157dd13))

## [0.18.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.17.0...v0.18.0) (2026-07-28)

### Features

- **init:** infer runtime from source template ([81a545b](https://github.com/0xPlayerOne/code-foundry/commit/81a545bc6a2d89c31be51a711e477c4e4ceca7dd))

## [0.17.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.16.0...v0.17.0) (2026-07-28)

### Features

- **release:** document centralized release runtime ([3e2a3f9](https://github.com/0xPlayerOne/code-foundry/commit/3e2a3f9b5e71bf5003819aa177afd265d989bb34))

### Bug Fixes

- **release:** grant trusted publishing permission ([025f78e](https://github.com/0xPlayerOne/code-foundry/commit/025f78e851d44a60e2e4e17d3718b0b2fbe147ae))

## [0.16.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.15.0...v0.16.0) (2026-07-28)

### Features

- **release:** add reusable release workflow runtime ([19c3433](https://github.com/0xPlayerOne/code-foundry/commit/19c3433af4ae1ed796030da77f07309e2bf3e98c))

## [0.15.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.14.0...v0.15.0) (2026-07-28)

### Features

- **runtime:** unify reusable workflow pins ([bd7aece](https://github.com/0xPlayerOne/code-foundry/commit/bd7aecefac9d02be698907cba686c536c6c242d6))

## [0.14.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.13.0...v0.14.0) (2026-07-28)

### Features

- **init:** minimize consumer workflow footprint ([4427c1f](https://github.com/0xPlayerOne/code-foundry/commit/4427c1f964c3a0dc6ffe080ea3779ad2b8a1d170))

## [0.13.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.12.0...v0.13.0) (2026-07-28)

### Features

- **codeql:** document centralized CodeQL runtime ([2aa20a9](https://github.com/0xPlayerOne/code-foundry/commit/2aa20a946d0979cb12af87cb2ea2d0b50f279965))

## [0.12.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.11.0...v0.12.0) (2026-07-28)

### Features

- **codeql:** add reusable CodeQL workflow runtime ([65896bb](https://github.com/0xPlayerOne/code-foundry/commit/65896bb407ad9d792c962e86d63384849f711a16))

## [0.11.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.10.0...v0.11.0) (2026-07-28)

### Features

- **security:** document centralized security runtime ([f8427fe](https://github.com/0xPlayerOne/code-foundry/commit/f8427fe740b2753c83a400766d7dd7ac453f3c5b))

## [0.10.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.9.0...v0.10.0) (2026-07-28)

### Features

- **security:** add reusable security workflow runtime ([b21d014](https://github.com/0xPlayerOne/code-foundry/commit/b21d014e85cfcdef4181d488b1df91e3c950503b))

## [0.9.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.8.0...v0.9.0) (2026-07-28)

### Features

- **init:** configure reusable workflow repository ([95d17e9](https://github.com/0xPlayerOne/code-foundry/commit/95d17e9a4af2e2075fcdc2c357af414876655fb3))

## [0.8.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.7.0...v0.8.0) (2026-07-28)

### Features

- **test:** add reusable test workflow runtime ([5a1f4cf](https://github.com/0xPlayerOne/code-foundry/commit/5a1f4cfadb6b11f27b001ba8f6424b11de32fd64))

### Bug Fixes

- **test:** keep local workflow during runtime release ([8827659](https://github.com/0xPlayerOne/code-foundry/commit/88276590451ee6b3230ad3b1349ccd4785a686bf))

## [0.7.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.6.0...v0.7.0) (2026-07-28)

### Features

- **ci:** use reusable workflow wrapper ([77c7075](https://github.com/0xPlayerOne/code-foundry/commit/77c7075d23f48b44da276406c0000fe23c7f1dcf))

### Bug Fixes

- **ci:** declare read-only workflow permissions ([e7b7397](https://github.com/0xPlayerOne/code-foundry/commit/e7b739739979b1572760c1f81d9c7229d156c7e3))
- **ci:** name reusable checks consistently ([4a194f4](https://github.com/0xPlayerOne/code-foundry/commit/4a194f40b4f2a2660526eefac0e366402de0782d))

## [0.6.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.5.0...v0.6.0) (2026-07-28)

### Features

- **ci:** add reusable workflow runtime ([4900da5](https://github.com/0xPlayerOne/code-foundry/commit/4900da5e6141015146c4be2059bbce7da0c25f5d))

## [0.5.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.4.0...v0.5.0) (2026-07-28)

### Features

- **init:** preserve authored repository docs ([9fab688](https://github.com/0xPlayerOne/code-foundry/commit/9fab6880ad82762cf4e2eb7d813355ab22cdb905))

## [0.4.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.3.0...v0.4.0) (2026-07-28)

### Features

- **hooks:** centralize generated pre-commit runtime ([8e8111c](https://github.com/0xPlayerOne/code-foundry/commit/8e8111c1b1b95fcb356fe1b1366e369393cbf946))

## [0.3.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.2.0...v0.3.0) (2026-07-28)

### Features

- **init:** add configurable license generation ([6ea7d93](https://github.com/0xPlayerOne/code-foundry/commit/6ea7d93637620bbb2f46475eeba4789d8a3b580c))

## [0.2.0](https://github.com/0xPlayerOne/code-foundry/compare/v0.1.4...v0.2.0) (2026-07-28)

### Features

- document repository profile diagnostics ([29f132a](https://github.com/0xPlayerOne/code-foundry/commit/29f132a2b15053b06c7fe22c27324dc59151adee))

## Changelog

All notable changes to this project are documented here.
