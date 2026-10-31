# Trust Requirements Profile (TRP)

Version 0.5 public working draft. Expect field names and normative requirements may change before 1.0.

Author: Striv AI.
Steward: Striv AI during the formative stage, with stewardship transferring to the AI Trust Alliance once its governance is formalized (see GOVERNANCE.md).
Copyright 2026 Striv AI.
Licensed under Apache License 2.0.

## Conformance

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are used as defined in RFC 2119 and RFC 8174.

There are two levels of conformance:

A valid TRP document satisfies structural and referential rules in Sections 2 through 4 and validates against the published JSON Schema (provided in the repository as a v0.5 draft, under review).

The JSON Schema is provided in the repository at `schema/trp.schema.json`. Any standard JSON Schema validator can check a profile against it. This validates the profile's structure and is separate from any assessment of a subject against the profile, which is performed by an evaluation source and is out of scope for this standard.

A conformant profile is a valid Trust Requirements Profile (TRP) document whose thresholds, rules, and bands reflect the requirements of a real domain and are authored by a qualified author (Section 5).

A consumer MUST reject an invalid document. Whether a valid document is conformant is decided by the authoring authority and any reviewing body.

## Definitions

Assurance mapping: An optional note linking a profile's requirements to outside frameworks such as NIST AI RMF or ISO/IEC 42001. It is informative and does not change what the profile requires (Section 10).

Author: The domain expert who writes and maintains a profile.

Authority: The party responsible for a profile. It is named in the profile and used to say who it came from and, when signing is used, to confirm it (Section 3.1).

Conformant: A valid profile whose values reflect a real domain and were set by a qualified author. Whether a valid profile is also conformant is a human judgment, not an automatic check (see Conformance).

Domain: The area of use a profile is written for, for example, manufacturing safety or clinical workflow.

Domain template: A profile populated for a class of environment, published for others to adopt and adapt (Section 9).

Drift: A steady trend toward an unsafe state across repeated checks, separate from the thresholds. A signal can drift even while its values stay in an acceptable range (Section 3.5).

Evaluation source: Any source that assesses a subject against a profile and produces a standing. This standard defines the profile the source reads and the standing it emits. It does not define how the assessment is performed.

Hard rule: A condition that is decisive on its own. If met, its action applies regardless of scored standing (Section 3.4).

Profile: A TRP document. It states the trust requirements that apply at a point of use.

Relying party: Any party that reads a profile, or a standing produced against it, to decide whether to trust or interact with the subject.

Required standing: The minimum standing a profile requires of a subject (Section 3.7).

Scored signal: Something measurable a profile watches, with the points at which it becomes a concern or a problem. Scored signals feed into the standing. The profile lists them; the evaluation source measures them (Section 3.3).

Severity: The rank of a standing band, where lower is better. It lets any reader order the bands without relying on their names (Section 3.6).

Standing: The labeled outcome of an assessment, drawn from the profile's declared bands, for example good, review, or failing.

Subject: The system, workflow, or agent assessed against a profile. The profile belongs to the domain or point of use. The subject is measured against it, not described by it.

Valid: A TRP document that follows the structural rules in Sections 2 through 4 and passes the schema. This check is automatic (see Conformance).

## 1. Overview

A Trust Requirements Profile specifies the behavior expected of a subject, the system, workflow, or agent being assessed, in a given domain, and is authored by a domain expert. An evaluation source reads the profile, assesses the subject, and produces a standing. Keeping the profile separate from the evaluation source means one source can serve any domain by loading a different profile, and the people who understand a domain define what expected and trustworthy behavior mean in it.

A TRP is a data document. It contains no executable logic. It does not define how signals are combined into a standing. The profile is the open, portable requirements contract. Assessment against it can come from any source.

This specification is a developing framework that defines a profile's structure. Each industry, and each organization within it, writes its own profiles to its own requirements. Think of it as a machine-readable language for stating trust requirements rather than a template.

## 2. Document format

A TRP is a JSON object (RFC 8259). UTF-8 is REQUIRED. A conforming document MUST set `additionalProperties` to false at each defined object level except within the extension namespace (Section 7).

A TRP has these parts: identification and metadata, scope, scored signals, hard rules, drift definition, standing bands, required standing, and optional assurance mapping, integrity, and extensions.

Every document SHOULD declare `$schema`, the URI of the JSON Schema it validates against, and `$id`, a stable URI for the profile.

## 3. Fields

### 3.1 Identification and metadata

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| trp_id | string | 1 | MUST | Stable identifier, unique within its authoring authority. Pattern `[a-z0-9][a-z0-9-]*`. |
| spec_version | string | 1 | MUST | Version of this specification the document targets, for example 0.5. |
| version | string | 1 | MUST | The profile's own version, MAJOR.MINOR.PATCH. A consumer MUST reject a profile whose MAJOR version it does not support. |
| name | string | 1 | SHOULD | Human-readable name. |
| description | string | 1 | SHOULD | Human-readable summary. |
| authority | string | 1 | MUST | Identifier of the party responsible for the profile. |
| author | object | 0..1 | SHOULD | The authoring domain expert: name, role, optional credential. |
| created_at | string (date-time) | 1 | SHOULD | RFC 3339 / ISO 8601 date-time timestamp of creation. Validated by the schema date-time format. |
| valid_from | string (date-time) | 0..1 | MAY | RFC 3339 date-time. The profile is not in force before this time. |
| valid_to | string (date-time) | 0..1 | MAY | RFC 3339 date-time. The profile is not in force after this time. If both are present, valid_to MUST be at or after valid_from. |
| license | string | 0..1 | SHOULD | License identifier for the profile, for example an SPDX identifier. |
| taxonomy | object | 1 | SHOULD | Classification: industry and use_case (Section 9). |

### 3.2 Scope

`scope` states where the profile applies and where it does not.

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| intended_use | string | 1 | MUST | What the profile is for, in plain language. |
| boundary | string | 1 | SHOULD | The system or operational boundary the profile governs. |
| jurisdiction | array of string | 0..1 | MAY | Applicable jurisdictions or regulatory contexts. |
| out_of_scope | array of string | 1 | SHOULD | What the profile does not cover. |

### 3.3 Scored signals

`scored_signals` is an array. Each element is one measurable signal and the thresholds at which it becomes a concern or critical. At least one element MUST be present.

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| signal | string | 1 | MUST | Name of the signal. Unique within the array. |
| weight | number | 1 | MUST | Relative importance, at least 0. Weight 0 means the signal is monitored but does not contribute to standing. Nonzero interpretation is left to the evaluation source. |
| direction | string | 1 | MUST | lower_is_unsafe or higher_is_unsafe. |
| warning_threshold | number | 1 | MUST | Value at which the signal is a concern. |
| critical_threshold | number | 1 | MUST | Value at which the signal is critical, at least as far in the unsafe direction as warning_threshold. |
| unit | string | 0..1 | SHOULD | Unit of the signal. |
| reason | string | 0..1 | SHOULD | Why the signal matters. |
| on_missing | string | 0..1 | SHOULD | Behavior when the signal is absent from an assessment. ignore, critical, or incomplete. Default incomplete. |

When a declared signal is absent, its `on_missing` value governs. `ignore` drops it from that assessment. `critical` treats the absence as a critical condition. `incomplete` marks the assessment incomplete so that a relying party can tell it apart from a pass. The default is incomplete, so a silently missing signal never reads as good. This three-valued treatment follows the established three-valued runtime-monitoring semantics: satisfied, violated, and inconclusive.

### 3.4 Hard rules

`hard_rules` is an array of conditions that are decisive on their own. A hard rule is not weighed against scored signals. If any hard rule is met, its action applies regardless of standing.

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| rule | string | 1 | MUST | Identifier, unique within the array. Pattern `[A-Za-z0-9][A-Za-z0-9_-]*`. |
| field | string | 1 | MUST | The evaluation input this rule inspects. |
| condition | string | 1 | MUST | is_true, is_false, equals, not_equals, less_than, or greater_than. |
| value | scalar | 0..1 | MUST when the condition needs an operand | The operand. Omitted for is_true and is_false. |
| action | string | 1 | MUST | halt, block_startup, or require_review. The action an enforcement layer MUST apply when the condition is met. |

When more than one hard rule is met in the same assessment, the most restrictive action applies. The actions are ordered, from most to least restrictive: halt, block_startup, require_review. The resulting action is the most restrictive among all met rules. All met rules SHOULD be recorded even though one action governs, so the full basis of the outcome is visible to a relying party.

A condition is valid only for the operand type it applies to. A scalar value is a boolean, number, or string. is_true and is_false apply only to a boolean field and take no value. less_than and greater_than apply only to a numeric field and a numeric value. equals and not_equals apply to a boolean, number, or string and compare by exact match. A profile MUST NOT pair a condition with an incompatible operand type, for example greater_than with a string. A document that does so is malformed and MUST be rejected. An evaluation source that encounters a type mismatch at assessment time, for example a field expected to be numeric that arrives as a string, MUST treat the rule as inconclusive rather than passed, consistent with the three-valued treatment in Section 3.3. The expected type of a field is the type its condition requires. For equals and not_equals it is the type of the rule's value, and a boolean is never treated as a number.

When the field a hard rule inspects is absent from an assessment, the evaluation source MUST treat the rule as inconclusive. A missing input never counts as a passed rule.

An inconclusive hard rule marks the assessment incomplete, the same outcome as a scored signal whose on_missing value is incomplete. It does not apply the rule's action, because the condition was neither met nor shown to be unmet. The evaluation source SHOULD record each inconclusive rule and the reason, missing or type mismatch, so a relying party can tell an incomplete assessment apart from a pass.

### 3.5 Drift definition

Drift describes a sustained trend toward an unsafe state across successive assessments. It is independent of the thresholds and does not require a crossing: a signal may drift while its values remain within an acceptable range. Thresholds evaluate a signal's current value; drift evaluates its trend over the window. A signal may show one, both, or neither.

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| window | integer | 1 | MUST | Number of consecutive samples over which a trend is assessed. Greater than 1. |
| signals | array of string | 1 | MUST | Signals monitored for drift. Each MUST also appear in scored_signals. |

The evaluation source determines how a trend is judged over the window. The profile declares which signals to watch and over what window.

### 3.6 Standing bands

`standing_bands` declares the vocabulary of standings and their order. It declares how standing is expressed, not how the value is computed.

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| band | string | 1 | MUST | Band name, for example good, review, failing. Unique within the array. |
| severity | integer (0-10) | 1 | MUST | Ordinal rank from 0 to 10, lower is better, so consumers compare bands without hardcoding names. |
| range | string | 0..1 | MAY | Description of what falls in the band. |

Any artifact that reports a standing for a subject MUST use a band declared here.

### 3.7 Required standing

`required_standing` specifies the minimum standing the profile requires of a subject and, optionally, the expected response for each observed band. A profile states a bar. It specifies a minimum acceptable rating without prescribing how the standing is determined.

| Field | Type | Card. | Req. | Description |
| :-- | :-- | :-- | :-- | :-- |
| minimum_acceptable_band | string | 1 | MUST | The lowest acceptable band. A subject whose standing is more severe than this band does not meet the requirement. MUST be a declared band. |
| source_requirement | string | 0..1 | SHOULD | Any requirement the profile places on the evaluation source, for example that it be independent or accredited. The standard does not name a source. A profile MAY require properties of one. |
| response_bands | array | 0..1 | MAY | The response expected at each observed band, applied to the subject's authorization to operate, using the vocabulary full, restricted, suspended, revoked. The profile specifies the intended response for each band. How a subject arrives at a band is out of scope. |

`response_bands` lets a profile express a graduated response, from full acceptance through restriction and suspension to revocation, while the hard rules in Section 3.4 remain the decisive switch. How an observed band is computed is the evaluation source's concern and is out of scope.

## 4. Referential integrity

Any artifact that references a TRP does so by trp_id and version. A valid TRP document MUST satisfy:

Every signal named in drift is defined in scored_signals. Every band in required_standing, including response_bands, is defined in standing_bands. standing_bands severities are unique. Any standing reported against the profile is a declared band. Timestamp ordering holds (Section 3.1).

A document that violates any of these is malformed and MUST be rejected.

## 5. Authoring and qualification (non-normative)

The author sets threshold values and SHOULD reflect the real limits of the environment and applicable practice. Example values in this repository are illustrative and are not certified limits.

A TRP is meant to be read by a domain expert who is not a programmer. Keep reason and scope fields plain.

Authoring a sound profile is domain work. The author block records who wrote a profile and their qualification, which a reviewing body MAY use when deciding whether a valid document is also conformant.

## 6. Non-goals

A TRP does not specify how scored signals are combined into a standing, how drift is judged, how any action is enforced, or how profiles and outcomes are exchanged between parties.

A TRP does not provide identity or credentials for a subject, nor is it a governance, risk, or security management platform. It states the requirements a subject is assessed against, and it is designed to interoperate with existing identity, credential, and governance systems.

Assessment, enforcement, and transport are left to the evaluation source and the implementation.

## 7. Extensibility

A profile MAY carry additional fields under an `x_` prefix or a URI-namespaced key, at the top level and inside any defined object. Consumers MUST ignore extension fields they do not recognize and MUST NOT treat an unrecognized extension as an error. Extensions MUST NOT change the meaning of the defined fields.

Two key forms are recognized, and both are accepted by the schema.

- An `x_` key is short and suits vendor fields and modules. Its name SHOULD be lowercase with underscores. A module intended for wide use SHOULD register its top-level key in the extension registry at `extensions/registry.json` so two modules never claim the same name.
- A URI-namespaced key is an absolute `https://` URI or a `urn:` URN controlled by the organization that defines the extension, for example `https://example.org/trp/ext/risk-tier`. It needs no registration, because the namespace owner prevents collisions. Another standards body or integration that extends TRP SHOULD use this form.

A module that changes how a subject is assessed does so through an evidence adapter. The adapter reads the module's configuration from the profile and writes ordinary evidence values that the profile's scored signals and hard rules consume. The core evaluation semantics stay unchanged, and a consumer that does not know the module still reads the profile.

A profile MAY declare inheritance from a base profile via `extends`, giving a trp_id and version. A domain template can serve as a base for a specific profile to refine. A consumer that does not support extends MUST reject a profile that uses it rather than ignore the base.

Inheritance resolves as follows:

- The child inherits all fields of the base.
- For single-valued fields, a value declared in the child replaces the base value. A field the child does not declare keeps the base value.
- For scored_signals and hard_rules, entries are matched by their identifier (signal name or rule). A child entry with the same identifier as a base entry replaces that entry. A child entry with a new identifier is added.
- A child MUST NOT remove a signal or rule declared in the base. Inheritance may add or override, not delete. This prevents a refinement from silently weakening a base profile.
- extends chains to a single base. A base that itself uses extends is resolved first, from the root down.

## 8. Integrity and signing (optional)

A profile MAY be signed by its authoring authority so a relying party can confirm it is unaltered and attributed. When signing is used, the signed content MUST be a canonical serialization of the profile, for example JSON Canonicalization Scheme (RFC 8785). Canonical serialization means writing the JSON in a single agreed-upon, byte-for-byte form, so two systems produce identical bytes for the same content, and a signature verifies on both. Without it, a trivial reformat would break the signature. The signature SHOULD use an established signed-document format rather than a bespoke one, and the profile SHOULD record the verification key's algorithm and location.

This draft leaves the exact canonicalization and envelope to the implementation and expects to fix them in a later version.

## 9. Domain taxonomy and templates

A two-level taxonomy classifies profiles by industry, then by use_case. This organizes profiles the way an author looks for them, making coverage gaps visible.

A domain template is a profile populated for a class of environment, published for others to adopt and adapt via `extends` (Section 7). This release seeds the library with one reference template, manufacturing safety (see the example). The library grows by contribution across industries and use cases. The seed is a starting point, not a complete catalog. Each template carries its own author, version, license, and taxonomy, so templates can be attributed, versioned, and shared.

## 10. Assurance mapping (optional)

A profile MAY carry an `assurance_mapping` array that relates its requirements to external frameworks, each entry naming a framework (for example, NIST AI RMF or ISO/IEC 42001) and a reference token. Mappings are informative and do not change the normative requirements.

## 11. Threat model (non-normative)

The format is designed to reduce specific failure modes. A profile can be versioned and signed, so changes are visible and attributable. The on_missing policy makes a missing signal explicit rather than an accident. Severity ordering lets any consumer compare bands without shared names. Optional signing binds a profile to its author.

Out of scope for the format: how a subject is scored, how enforcement is carried out, and how artifacts are moved between parties.

## 12. Extending the standard

This section states how the standard changes over time without fragmenting. It is the part most declaration formats leave undefined, which is why they either ossify or fork.

Stable core: The fields and rules in Sections 2 through 4 are the core. Every TRP everywhere has them, and they interoperate regardless of domain. The core changes rarely and only through a MAJOR version.

Profiles specialize the core: A domain template, and any profile that extends it, adds domain-specific signals, rules, and constraints on top of the core. A profile may require fields the core leaves optional and may tighten thresholds. A profile MUST NOT break the core or redefine a core field. This is how one standard serves manufacturing, healthcare, and finance without a separate standard for each. The domain-specific complexity lives in profiles, not in the core.

Extension points: New ideas enter at the declared extension points (Section 7), not by changing the core. An industry can innovate in its own profiles and extensions without changing the standard and without permission. A generic consumer still reads the document because it ignores unknown extensions rather than rejecting them.

Promotion: When an extension proves broadly useful across many domains, the standard's governing body MAY promote it into the core in a later version. This lets the core learn from the edges instead of trying to anticipate every domain at the start.

Governance of the core: The stable core and the promotion decision are governed by the standard's steward, which is Striv AI during the formative stage and the AI Trust Alliance after stewardship transfers (see GOVERNANCE.md). Openness under this standard covers the TRP core and its published profiles. Implementations built on the TRP standard may be licensed however their authors choose.

## 13. Versioning and change policy

The specification and each profile use semantic versioning. Within 0.x, MINOR versions may introduce breaking changes. From 1.0, breaking changes increment the MAJOR version. A profile's MAJOR version is in its version and, where used, its `$id` so that a consumer can reject incompatible profiles. Non-breaking additions increment MINOR and remain compatible with consumers that ignore unknown fields.

## 14. License

This specification is released under the Apache License 2.0. Individual profiles carry their own license field.

## 15. Example

See `examples/manufacturing-safety/trp.json` for a complete, valid TRP for a manufacturing robot cell.

Example Fields:

- Identity and metadata: this is the manufacturing-safety profile, version 1.0.0, written against spec version 0.5, by a named author, under a stated license, classified under industry manufacturing and use case robot-cell-safety.
- Scope: It governs one collaborative robot cell operating near people, and it explicitly does not cover how the system is scored or how a halt is enforced.
- Scored signals: it watches human distance, robot speed, vibration, temperature, model confidence, and data quality, each with the point at which it becomes a concern, the point at which it becomes critical, and what to do if the signal is missing.
- Hard rules: an emergency stop, a person in the exclusion zone, an expired safety certification, or critically poor data each stop the system on their own, regardless of any score.
- Drift: vibration and temperature are watched over five consecutive samples for a sustained trend toward an unsafe state.
- Standing bands: the system's overall standing is good, review, or failing, ordered by severity.
- Required standing: the system must hold at least review standing; the evaluation source should be independent for audit or insurance use; and each band maps to a response from full down to suspended.

The goal of this specification is to establish a single, open way to communicate trust requirements that any domain can use and any evaluator can read. Trust and transparency across autonomous systems can then live outside of proprietary, closed systems.
