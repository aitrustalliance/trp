# Roadmap

This roadmap reflects the current planning direction for the TRP specification and ecosystem. Priorities will evolve based on community feedback and the outcomes of the scoping work with NSF and OSU.

## Current (v0.5 Draft)

- [x] Core specification published
- [x] JSON Schema for automated validation (Draft 2020-12)
- [x] Manufacturing safety reference profile
- [x] Healthcare data governance reference profile
- [x] Reference evaluator (tools/)
- [x] Apache 2.0 licensing
- [x] Contribution and governance guidelines

## Near-Term

- [x] Conformance test suite for cross-evaluator agreement
- [x] GitHub Actions CI pipeline (Python 3.10, 3.12)
- [x] Zenodo DOI for academic citation (10.5281/zenodo.22099404)
- [ ] Additional domain profiles (financial operations, insurance, defense)
- [ ] Per-signal drift window configuration (see [Issue #2][issue-2])
- [ ] Extension namespacing and registry design (see [Issue #3][issue-3])
- [ ] Evidence format specification for evaluation results
- [ ] Community feedback on v0.5 draft incorporated

## Medium-Term

- [ ] Spec v1.0 candidate with community input
- [ ] Formal semantics for the requirement language
- [ ] Composition and inheritance verification tooling
- [ ] Integration guidance for agent-identity and authorization systems (SPIFFE, AAuth, auth.md)
- [ ] Integration guidance for tool invocation protocols (MCP, A2A)
- [ ] Integration guidance for credential systems (DID/VC, W3C Verifiable Credentials)
- [ ] Training pathway and profile-authoring guide
- [ ] Domain working groups seeded through workshops

## Long-Term

- [ ] Promotion to an independent standards body
- [ ] Multi-stakeholder governance fully operational
- [ ] Interoperability testing across independent evaluation sources
- [ ] Adoption in regulated industries (healthcare, manufacturing, financial services)

## How to Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose profiles, spec changes, or new tooling. Open an issue to suggest a roadmap item.

[issue-2]: https://github.com/aitrustalliance/trp/issues/2
[issue-3]: https://github.com/aitrustalliance/trp/issues/3
