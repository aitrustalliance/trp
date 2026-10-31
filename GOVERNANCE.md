# Governance

## Stewardship

Striv AI authored the Trust Requirements Profile specification and stewards it during its formative stage. Stewardship transfers to the AI Trust Alliance, an independent nonprofit standards body, once the Alliance's governance is formalized. The Alliance is being established to develop and steward the trust requirements of the AI economy as a neutral, multi-stakeholder organization, so the standard belongs to the ecosystem and stays separate from any single vendor. The Ohio State University is a founding participant.

During the formative stage the steward makes decisions in the open on GitHub, through the process below, so every change to the core is visible and attributable before and after the transfer.

## Decision-Making

Decisions about the TRP specification follow a transparent process.

- **Profiles** Anyone can author and contribute a domain profile. Profiles carry their own author attribution, version, and license. Contributing a profile does not require approval, only validation against the schema.
- **Spec changes** Changes to the core specification or schema are proposed as GitHub issues, discussed openly, and require review and approval by the steward before merging.
- **Extension keys** A module's top-level `x_` key is registered by pull request to `extensions/registry.json` and reviewed by the steward. URI-namespaced keys need no registration. See [extensions/README.md](extensions/README.md).
- **Extension promotion** A proven extension may be promoted into the core specification through the promotion path described in the spec. The steward decides promotion based on demonstrated adoption and technical merit.

## Contribution Workflow

1. Open an issue describing the proposed change or new profile.
2. Discuss with the community.
3. Submit a pull request.
4. For profiles, validation against the schema is sufficient for merge.
5. For spec or schema changes, steward review is required.

## Anti-Capture Safeguards

The transfer to the Alliance is designed so that, after it, no single company controls the standard, including its original author. Governance decisions will then require multi-stakeholder input. Formalizing the Alliance's governance will define membership tiers, decision rights, amendment processes, and long-term sustainability mechanisms, drawing on proven models such as the Cloud Security Alliance, the International Association of Privacy Professionals, and the Project Management Institute.

## Current Status

Governance is in its formative stage, with Striv AI as steward. This document will be updated as the Alliance formalizes its structure and as stewardship transfers. Feedback on governance design is welcome as a GitHub issue.
