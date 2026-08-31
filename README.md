[![CI](https://github.com/aitrustalliance/trp/actions/workflows/ci.yml/badge.svg)](https://github.com/aitrustalliance/trp/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE) [![Spec](https://img.shields.io/badge/Spec-v0.5_Draft-orange.svg)](spec/trp-spec.md) [![Schema](https://img.shields.io/badge/Schema-Draft_2020--12-green.svg)](schema/trp.schema.json) [![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22099404.svg)](https://doi.org/10.5281/zenodo.22099404)

# Trust Requirements Profile (TRP)

The promise of AI, from breakthroughs in medicine to broad economic opportunity, depends on trust. The real question is whether we will solve standardization and interoperability across the entire AI ecosystem, or leave it fragmented inside a handful of closed platforms. Trust is the enablement layer for a broad and inclusive AI economy, yet today the greatest developments in AI are controlled by fewer than ten companies. This creates technical uncertainty, economic co-dependence, and establishes monopolies on AI's potential while stifling development and concentrating many kinds of risk. Trust cannot be solved in a vacuum. This is the Trust Gap: the absence of shared, open infrastructure for declaring and verifying trust across the AI ecosystem. Ecosystems are built on standards, primitives, and collaborative development among all participants.

Remarkable research and transformational capabilities are sitting on the sidelines, waiting for a trusted path to mainstream use. At the same time, companies reshape their AI strategies around cost, access, control, and ownership of their data, models, weights, and infrastructure. We believe open standards that invite greater investment, sovereign development, and collaborative innovation open the door to economic inclusion and human flourishing. Open trust standards are the pathway to democratized access and adoption of the world's most promising technology.

Trust infrastructure is the foundation of the AI economy. TRP is the standard that lets every part of the AI ecosystem operate with openly shared and enforced trust requirements, opening the door to more participants and to inference that is more specialized, more efficient, and closer to the value creators. We are building and recruiting into an open ecosystem to put the promise of AI within everyone's reach, starting with the foundational Trust Requirements Profile (TRP) standard.

Trust requirements for AI will be defined with or without an open standard. Without open trust, authority defaults according to resources rather than utility. TRP exists to prevent that outcome.

Version 0.5, public working draft. Field names and normative requirements may still change before 1.0.

Licensed under the Apache License 2.0. Copyright 2026 Striv AI.

---

## Technical Overview

A Trust Requirements Profile (TRP) is a universal trust taxonomy and machine-readable contract that specifies the operating requirements, trust boundaries, and standing criteria for any subject, system, agent, model, workflow, or data source in a given domain. A domain expert authors the profile. Any qualified evaluation source reads that contract, assesses a subject against it, and produces a standing.

The standard defines the profile, the requirements it carries, and the vocabulary of outcomes. Assessment against a profile is open to any qualified evaluation source, which is what gives the standard its reach: one source can serve any domain by loading a different profile; independent implementations interoperate because they share the format. Practitioners who understand a domain are best positioned to define what trustworthy behavior means in it.

TRP follows a document-based governance model: simple, declarative, machine-readable documents that carry trust requirements across organizational boundaries, the same pattern that has proven most durable for coordination at scale.

A TRP is declarative and precise: it states what trust requires and how outcomes are expressed, in a form any machine can read and verify. Defined tightly enough that any conforming evaluation source acting on the same profile reaches the same result, it makes trust checkable and portable across the ecosystem rather than locked to one vendor's tooling. The standard is open, and the implementations built on it- the engines, tools, and services that act on a profile are what evolve into an ecosystem.

## The Trust Requirements Layer

Trust is not a property of any single part of the stack. It lives in the interactions between parts: between a model and the data it draws on, between a workflow and the service it calls, and between an agent and the system it acts upon. Each of these is a point where one element must trust another to do what is required and stay within bounds. Identity establishes who or what each party is, and authorization defines what it may access. Still, neither describes the terms of the interaction itself, and neither leaves a shared record of whether those terms were met.

A trust requirement is that missing piece: a portable contract of interaction requirements that any two parties can read, describing how they are allowed to interact and holding the evidence of whether they did. It is not limited to behavior, and it is not limited to agents. A profile can specify what may pass between parties (payload), where it may go (region), how long it may run (dwell time), the ceilings it must stay under (limits such as token counts), and how far conditions may drift before the interaction is no longer trusted (drift tolerance), along with whatever else a domain demands. The requirements run both ways, so each side knows what it is agreeing to and is measured against the same terms. That is what makes trust portable across the whole stack instead of something argued over at every boundary.

A trust requirement cannot belong to a frontier lab. When the definition of a trusted interaction lives inside one company's platform, every other participant is trusting that company rather than the system, and the record is theirs to shape. Trust that can only be issued by the same few providers who build and sell AI models is not trust; it is a conflict of interest. This is a big part of the trust gap in AI: compartmentalized or held hostage inside individual platforms, and fragmented into private formats and protocols that cannot agree across parties. An open standard confronts fragmentation and breaks platform lock-in. Trust orchestration is the problem: ensuring every party in an interaction can prove it met the requirements. TRP solves it. TRP integrates with identity, authorization, and enforcement. It must be open, because it requires shared agreement and understanding across the ecosystem.

## Repository Contents

```
spec/
  trp-spec.md                                    the specification
  trust-json-discovery.md                        trust.json discovery protocol specification
schema/trp.schema.json                           the JSON Schema a profile validates against
examples/
  trust.json                                     example trust.json discovery file
  manufacturing-safety/trp.json                  reference profile: collaborative robot cell safety
  healthcare-data-governance/trp.json            reference profile: AI processing of protected health information
tools/
  evaluate.py                                    reference evaluator (Python)
  evaluate.js                                    reference evaluator (Node.js)
  README.md                                      evaluator documentation and usage
tests/
  run_conformance.py                             conformance test suite (17 tests)
  profiles/valid/                                profiles that must pass schema validation
  profiles/invalid/                              profiles that must fail schema validation
  evidence/                                      evidence samples with expected evaluation outcomes
  README.md                                      test suite documentation
.github/workflows/ci.yml                         CI pipeline: runs on every push and PR
INTEGRATIONS.md                                  integration architecture with SPIFFE, AAuth, MCP, VCs, A2A
docs/
  authoring-guide.md                             step-by-step guide to writing your first TRP profile
CONTRIBUTING.md                                  how to contribute profiles and spec changes
GOVERNANCE.md                                    stewardship model and decision process
ROADMAP.md                                       project direction and planned work
CHANGELOG.md                                     release history
SECURITY.md                                      vulnerability reporting policy
requirements.txt                                 Python dependencies
LICENSE                                          Apache License 2.0
```

## Getting Started

Read the specification in `spec/` for the full field-by-field definition. For a hands-on walkthrough, see the [Profile Authoring Guide](docs/authoring-guide.md), which takes you from an empty file to a validated, evaluator-tested profile in nine steps. Then look at the reference profiles in `examples/` to see the format in use across two domains:

- **Manufacturing safety** (`examples/manufacturing-safety/trp.json`): a collaborative robot cell with scored signals for human distance, robot speed, vibration, temperature, model confidence, and data quality, plus hard rules for emergency stop, exclusion zone, and certification status.
- **Healthcare data governance** (`examples/healthcare-data-governance/trp.json`): an AI system processing protected health information, with scored signals for de-identification confidence, consent coverage, subgroup performance gaps, and access log completeness, plus hard rules for HIPAA basis, IRB status, and data use agreements.

To check a profile against the schema, use any standard JSON Schema validator (Draft 2020-12):

```bash
pip install jsonschema
python -c "import json,jsonschema; jsonschema.Draft202012Validator(json.load(open('schema/trp.schema.json'))).validate(json.load(open('examples/manufacturing-safety/trp.json')))"
```

No output means the profile is valid.

To evaluate data against a profile, use the TRP Reference Evaluator:

```bash
# Generate a sample with safe default values
python3 tools/evaluate.py examples/manufacturing-safety/trp.json --generate-sample > sample.json

# Evaluate the sample against the profile
python3 tools/evaluate.py examples/manufacturing-safety/trp.json sample.json
```

The evaluator loads the profile, checks hard rules, scores signals against thresholds, tracks drift, and assigns a standing from the profile's declared bands. See `tools/README.md` for full documentation.

## Conformance Testing

There are two levels. A *valid* profile satisfies the structural and referential rules in the specification and validates against the schema. A *conformant* profile is a valid profile whose thresholds, rules, and bands reflect the requirements of a real domain and were set by a qualified author. Validation is automatic; whether a valid profile is also conformant is a judgment for the authoring authority and any reviewing body, not for a validator. See the specification for the full definitions.

The repository includes a conformance test suite that validates all profiles against the schema, verifies that intentionally malformed profiles are correctly rejected, and checks that the reference evaluator produces deterministic results for known inputs:

```bash
pip install -r requirements.txt
python tests/run_conformance.py --verbose
```

The GitHub Actions CI pipeline runs this suite on every push and pull request. See `tests/README.md` for the full test inventory and instructions for adding new test cases.

## Governance

An independent steward governs the TRP core and the decision to promote extensions into the core, the AI Trust Alliance, a neutral standards body separate from any single vendor. The Ohio State University is a founding member. See [GOVERNANCE.md](GOVERNANCE.md) for the full stewardship model and decision process. Openness under this standard covers the TRP core and its published profiles. Implementations built on it may be licensed however their authors choose.

## Your Contribution

The defining technology of our time is being shaped, designed, and distributed right now. The standards that determine access, interoperability, and success will set the boundaries and the battlegrounds, and ultimately the impact, across the entire AI economy. Trust is the frontier. Between every participant and every layer, trust is the most critical challenge and the greatest opportunity facing the AI industry.

Join a growing consortium of leaders, industry practitioners, academic and technical researchers, and those driven to bring the power of autonomy to novel challenges. Bring your technical depth, your industry expertise, or the perspective only your vantage point can offer. What you help build stays open to everyone, and your work remains your own.

To take part, see [CONTRIBUTING.md](CONTRIBUTING.md) for how to submit profiles, propose spec changes, or improve tooling. Profiles you contribute carry their own author, version, license, and taxonomy, so your work stays attributed, versioned, and yours.

TRP is a foundational element of the trust infrastructure the AI economy requires.

## Status

This is an early public draft. While it is complete enough to read, validate against, and author profiles, it is unfinished enough that field names and requirements will likely change before 1.0. See [ROADMAP.md](ROADMAP.md) for planned work. Feedback from practitioners at any and all levels is our top priority.

## License

Released under the Apache License 2.0. Individual profiles carry their own license field.
