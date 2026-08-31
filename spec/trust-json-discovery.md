# trust.json Discovery Specification

**Version:** 0.1.0 draft
**Status:** Proposal
**License:** Apache-2.0

## Abstract

This document specifies a discovery mechanism for Trust Requirements Profiles
(TRP). A service operator publishes a `trust.json` file at a well-known
location on their domain. Clients, agents, and orchestration systems fetch this
file to discover what trust requirements the service enforces, before initiating
a governed interaction.

The pattern follows established conventions: `robots.txt` for crawlers,
`security.txt` (RFC 9116) for vulnerability reporting, `.well-known/openid-configuration`
for identity providers, and `auth.md` for agent authentication. `trust.json`
extends this model to trust requirements.

## Motivation

Identity protocols tell you who is calling. Authorization protocols tell you
what they may access. Neither tells you the conditions under which the
interaction itself is acceptable.

Trust requirements today take the form of legal contracts, compliance questionnaires,
and vendor assessments. None of these are machine-readable. An AI agent that
can authenticate in milliseconds still cannot programmatically determine
whether it meets a service's operational trust requirements.

`trust.json` fills that gap. A service publishes its trust requirements at a
known location. A client reads them, evaluates its own evidence, and knows
whether to proceed before the first API call.

## Specification

### Location

A `trust.json` file MUST be served at the root of a domain:

```
https://example.com/trust.json
```

Alternatively, it MAY be served at the IETF well-known URI path:

```
https://example.com/.well-known/trust.json
```

If both locations are populated, the well-known path takes precedence.

### Content Type

The file MUST be served with `Content-Type: application/json`.

### Schema

```json
{
  "$schema": "https://aitrustalliance.com/schema/trust-discovery/0.1/trust.json",
  "version": "0.1.0",
  "entity": {
    "name": "Example Corp",
    "domain": "example.com",
    "contact": "trust@example.com"
  },
  "profiles": [
    {
      "id": "api-consumer-requirements",
      "name": "API Consumer Trust Requirements",
      "description": "Requirements for any agent, service, or integration consuming our API.",
      "profile_url": "https://example.com/trust/api-consumer.trp.json",
      "spec_version": "0.5",
      "scope": "api-consumers",
      "enforcement": "required",
      "evaluation": {
        "mode": "self-attestation",
        "endpoint": null
      }
    },
    {
      "id": "data-partner-requirements",
      "name": "Data Partner Trust Requirements",
      "description": "Requirements for partners receiving PII or regulated data.",
      "profile_url": "https://example.com/trust/data-partner.trp.json",
      "spec_version": "0.5",
      "scope": "data-partners",
      "enforcement": "required",
      "evaluation": {
        "mode": "independent",
        "endpoint": "https://example.com/api/trust/evaluate"
      }
    }
  ],
  "policy": {
    "default_action": "deny",
    "documentation": "https://example.com/docs/trust-policy"
  }
}
```

### Field Definitions

#### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | Yes | Version of the trust.json specification. |
| `entity` | object | Yes | The organization publishing trust requirements. |
| `profiles` | array | Yes | One or more TRP profiles the entity enforces. |
| `policy` | object | No | Default behavior when no profile matches. |

#### Entity Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Legal or common name of the entity. |
| `domain` | string | Yes | Primary domain. |
| `contact` | string | No | Contact for trust-related inquiries. |

#### Profile Entry

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Stable identifier for this profile entry. |
| `name` | string | Yes | Human-readable name. |
| `description` | string | No | What this profile governs. |
| `profile_url` | string | Yes | URL of the full TRP profile document. |
| `spec_version` | string | Yes | TRP spec version the profile targets. |
| `scope` | string | Yes | What class of interaction this profile governs. |
| `enforcement` | string | Yes | One of: `required`, `recommended`, `informational`. |
| `evaluation` | object | No | How compliance is evaluated. |

#### Evaluation Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | One of: `self-attestation`, `independent`, `automated`. |
| `endpoint` | string | No | URL of an evaluation API, if mode is `automated`. |

### Discovery Flow

```
1. Client intends to interact with example.com
2. Client fetches https://example.com/.well-known/trust.json
3. Client reads the profiles array
4. Client selects the profile matching its interaction scope
5. Client fetches the full TRP profile from profile_url
6. Client evaluates its own evidence against the profile
7. If standing meets required_standing: proceed
   If not: halt, remediate, or request exception
```

### Relationship to Other Discovery Protocols

| Protocol | Discovers | trust.json Complements |
|----------|-----------|----------------------|
| `robots.txt` | Crawl permissions | trust.json governs what conditions apply beyond access |
| `security.txt` | Vulnerability reporting | trust.json governs operational trust requirements |
| `.well-known/openid-configuration` | Identity provider endpoints | trust.json governs what trust evidence the IdP requires |
| `auth.md` | Agent authentication flows | trust.json governs what trust requirements apply after authentication |
| `trust.json` | Trust requirements | The requirements layer of the stack |

### Interaction with auth.md

When a domain publishes both `auth.md` and `trust.json`, the interaction
sequence is:

1. The agent discovers authentication requirements via `auth.md`.
2. The agent authenticates using the specified flow (OAuth 2.1, ID-JAG, etc.).
3. The agent discovers trust requirements via `trust.json`.
4. The agent evaluates its evidence against the applicable TRP profile.
5. If both authentication and trust requirements are met, the governed
   interaction proceeds.

Authentication establishes identity. Trust requirements establish the
conditions of the interaction. Both are necessary; neither is sufficient alone.

## Security Considerations

A `trust.json` file describes the trust requirements a service enforces. It
does not grant access, issue tokens, or bypass authorization. Fetching a
`trust.json` file is a read-only discovery operation.

The file MUST be served over HTTPS. Clients MUST verify TLS certificates. A
`trust.json` file served over HTTP MUST be ignored.

Profile URLs referenced in the `profiles` array SHOULD be on the same domain
or a subdomain of the publishing entity. Cross-domain profile references
require additional verification by the client.

## Example: Minimal trust.json

```json
{
  "version": "0.1.0",
  "entity": {
    "name": "Startup Co",
    "domain": "startup.co"
  },
  "profiles": [
    {
      "id": "default",
      "name": "Default Trust Requirements",
      "profile_url": "https://startup.co/trust/default.trp.json",
      "spec_version": "0.5",
      "scope": "all",
      "enforcement": "recommended"
    }
  ]
}
```

## References

- [Trust Requirements Profile (TRP) Specification](trp-spec.md)
- [RFC 9116: A File Format to Aid in Security Vulnerability Disclosure (security.txt)](https://www.rfc-editor.org/rfc/rfc9116)
- [auth.md: Agent Authentication Discovery](https://github.com/workos/auth.md)
- [RFC 8615: Well-Known Uniform Resource Identifiers](https://www.rfc-editor.org/rfc/rfc8615)
