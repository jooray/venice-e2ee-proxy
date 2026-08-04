# NOTICE

venice-e2ee-proxy
Copyright © Juraj Bednár and contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License, version 3, as published by the Free
Software Foundation. The full text is in [`LICENSE`](./LICENSE).

## Why GPL-3.0

The proxy vendors [`venice-e2ee`](https://github.com/jooray/venice-e2ee) as a git
submodule and links it at runtime. That library is **GPL-3.0-only**, so any
distributed build of this proxy is a combined work covered by the GPL. Licensing
the proxy itself GPL-3.0-only removes the ambiguity rather than leaving a
permissive licence sitting on top of a copyleft dependency.

What this means in practice:

- **Running it yourself** — locally, or as a service others reach over the
  network — triggers no distribution obligation. This is the GPL, not the AGPL;
  network use is not distribution.
- **Distributing it** — shipping a bundle, a container image, or anything that
  installs `venice-e2ee` alongside it — obliges you to offer the corresponding
  source under GPL-3.0.

This notice is informational and is not legal advice.

## Third-party dependencies

Each package below belongs to its own authors and is used under its own licence.

### Vendored

| Component | Licence | Source |
| --- | --- | --- |
| `venice-e2ee` (git submodule) | **GPL-3.0-only** | <https://github.com/jooray/venice-e2ee> |

The submodule tracks `feat/gpu-attestation`, which stacks NVIDIA GPU attestation
on top of `fix/tool-call-parsing` — the latter carries tool-call parsing repairs
currently open as [PR #10](https://github.com/elkimek/venice-e2ee/pull/10)
against upstream [`elkimek/venice-e2ee`](https://github.com/elkimek/venice-e2ee).
Neither is upstream yet, so this repo pins the fork.

### Runtime dependencies

| Package | Licence | Project |
| --- | --- | --- |
| `@phala/dcap-qvl` | Apache-2.0 | <https://github.com/Phala-Network/dcap-qvl> |
| `dotenv` | BSD-2-Clause | <https://github.com/motdotla/dotenv> |
| `express` | MIT | <https://github.com/expressjs/express> |
| `js-yaml` | MIT | <https://github.com/nodeca/js-yaml> |

### Notable transitive dependencies

Pulled in by `venice-e2ee` for the core cryptography:

| Package | Licence | Project |
| --- | --- | --- |
| `@noble/secp256k1` | MIT | <https://github.com/paulmillr/noble-secp256k1> |
| `@noble/hashes` | MIT | <https://github.com/paulmillr/noble-hashes> |

For the fully resolved tree, see `package-lock.json` or run
`npx license-checker --summary`.

## Acknowledgements

The GPL/permissive-licence interaction documented above was first written up by
[`@axlabs/venice-e2ee-proxy`](https://github.com/AxLabs/venice-e2ee-proxy), whose
`NOTICE.md` prompted this one.
