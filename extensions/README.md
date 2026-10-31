# Extension Registry

TRP grows through extensions, as described in Sections 7 and 12 of the specification. A profile can carry extension fields at the top level and inside any defined object, and a consumer that does not recognize an extension ignores it. This folder holds the registry of top-level `x_` keys so that two modules never claim the same name.

## Key Forms

An `x_` key is short and suits vendor fields and modules, for example `x_provenance`. Use lowercase letters, digits and underscores after the prefix. Vendor fields that stay inside one organization's profiles do not need to be registered.

A URI-namespaced key is an absolute `https://` URI or a `urn:` URN that the defining organization controls, for example `https://example.org/trp/ext/risk-tier` or `urn:example:trp:ext:program-code`. It needs no entry here, because the namespace owner prevents collisions. Other standards bodies and integrations that extend TRP should use this form.

Plain `http://` keys and any other key outside these forms fail schema validation.

## Registering A Module Key

A module intended for wide use registers its top-level `x_` key by pull request to `registry.json`. Each entry records the key, a name, a status, the maintainer, a one-line summary, links to the module's specification and repository, and the registration date. The status is `reserved` while the module is being built, `active` once a release is published, and `retired` when the key may no longer be reused. A retired key is never reassigned.

The steward reviews registrations under [GOVERNANCE.md](../GOVERNANCE.md). The conformance suite checks that every key starts with `x_`, that keys are unique, and that each status is one of the three above.

## How A Module Changes Assessment

A module never changes the core evaluation semantics. It ships an evidence adapter that reads the module's configuration from the profile and writes ordinary evidence values. The profile's scored signals and hard rules consume those values, so any conforming evaluator produces the same standing without knowing the module exists. [INTEGRATIONS.md](../INTEGRATIONS.md) describes the adapter pattern.

An adapter should write every field its rules inspect on every run. Section 3.4 treats a missing hard rule field as inconclusive, so a dropped field marks the assessment incomplete instead of letting the rule pass.

## Promotion

When an extension proves broadly useful across domains, the steward may promote it into the core in a later version, as Section 12 describes. The registry entry then points to the core section that replaced it.
