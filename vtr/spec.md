<!--
Copyright 2026 Striv AI, Inc.
SPDX-License-Identifier: Apache-2.0
-->

# Verifiable Trust Receipt (VTR) Version 0.5

## Status

Draft for public review, stewarded by the AI Trust Alliance next to the Trust Requirements Profile (TRP). Field names may change before version 1.0, and any change is recorded in `CHANGELOG.md`.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, NOT RECOMMENDED, MAY and OPTIONAL in this document are to be interpreted as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

## Purpose

A Verifiable Trust Receipt is a signed statement that one evaluation of an entity against a TRP happened, and what it found. A relying party can check a receipt without trusting the party that issued it. It confirms the signature against the issuer's published key, confirms which profile was applied from the profile's digest, and, when it has the evidence, runs the evaluation again and gets the same answer.

A receipt records a determination. It carries no score, and no member of a receipt may hold a numeric rating of the entity.

## Roles

VTR follows the remote attestation architecture of RFC 9334.

| RFC 9334 Role | VTR Role |
|---|---|
| Attester | The evaluator that measures the entity and runs the evaluation |
| Evidence | The evidence object the evaluator measured, bound by `evidence_digest` |
| Appraisal Policy | The TRP profile, bound by `trp_ref` |
| Attestation Result | The receipt |
| Relying Party | Anyone who checks the receipt |

The issuer is the party whose key signs the receipt. It MAY be the evaluator or a receipt service that signs on the evaluator's behalf. In either case the issuer's key set MUST be published as described in Key Discovery.

## Terms

| Term | Meaning |
|---|---|
| Determination | The standing, the coverage, the per-requirement results and the result digest of one evaluation |
| Requirement | One scored signal or one hard rule declared in the profile |
| Clause | The name of a requirement in a receipt, `signal:<signal>` for a scored signal and `rule:<rule>` for a hard rule |
| Standing | Whether the entity meets the profile, with the band the evaluator assigned and the response the profile declares for that band |
| Coverage | The share of the profile's requirements the evaluator could check, from 0 to 1 |
| Evaluator Output | The object a TRP evaluator returns for one evaluation, without its `evaluation` member |
| Mode | Whether the decision was enforced or only tested, shadowed or observed |
| Kind | What the receipt records, an evaluation in this version, or a conformance run, a drill or a variance run |
| Digest | RFC 8785 canonical JSON of a value, hashed with SHA-256, encoded as base64url without padding |

## Claims

The receipt payload is a JSON object. It MUST carry every required member and MAY carry optional members. It MUST NOT carry any other top-level member. An optional member MAY be present with the value `null`, and a verifier treats that member as present. `vtr/schema/vtr.schema.json` states these rules as JSON Schema.

| Claim | Type | Required | Meaning |
|---|---|---|---|
| `vtr_version` | string | Yes | `"0.5"` |
| `iss` | string | Yes | The issuer, resolvable to a key set |
| `iat` | integer | Yes | Issue time in Unix seconds |
| `sub` | string | Yes | The entity evaluated, as a URI |
| `kind` | string | Yes | `evaluation`, `conformance`, `drill` or `variance` |
| `mode` | string | Yes | `enforced`, `test`, `shadow` or `observed` |
| `trp_ref` | object | Yes | The profile applied, `{id, version, digest}`, where `digest` is the digest of the profile document |
| `standing` | object | Yes | `{result, band, response}`, defined in Determination |
| `coverage` | number | Yes | The share of requirements checked, from 0 to 1 |
| `results` | array | Yes | One `{clause, outcome}` per requirement, sorted by `clause` |
| `evidence_digest` | string | Yes | The digest of the evidence object |
| `result_digest` | string | Yes | The digest of the evaluator output, defined in Determination |
| `evaluator` | object | Yes | `{implementation, version, spec_version}` of the evaluator that ran |
| `window` | object | When time-based | `{start, end}` in RFC 3339, REQUIRED when any requirement was evaluated over a time window |
| `nonce` | string | No | A value a challenger supplied, echoed for freshness |
| `prev` | string | No | The digest of the issuer's previous claims for the same `sub` |
| `risk` | object | No | Reserved. It MUST be empty in version 0.5 |
| `evaluators` | array | No | `{name, version, decision}` for each detector or evaluator that contributed |
| `build` | string | No | The digest of the evaluator's build image |
| `fallback` | object | No | `{from, to, trp_clause}` when the system fell back to a safer state |
| `principal` | object | No | `{scheme, value, issuer}` of the person or system that started the action, or `null` when none was verified |
| `on_behalf_of` | object | No | `{scheme, value, issuer}` of the party the action served, or `null` |
| `agent` | object | No | `{id, version}` of the AI agent that acted |
| `model` | object | No | `{provider, version}` of the model behind the agent |
| `tool` | object | No | `{name, target}` of the tool the agent called |
| `cost` | object | No | `{tokens {input, output}, money {amount, currency}}`, with `amount` as a decimal string and `currency` as an ISO 4217 code |
| `outcome` | string | No | The verdict on the action, `allow`, `stop` or `escalate` |
| `trp_clauses` | array | No | The clauses that decided the verdict |
| `policy_digest` | string | No | The digest of a compiled policy the enforcement point ran, when it ran one |
| `input_digest` | string | No | The digest of the input that policy or gate judged, such as the tool name and arguments |
| `escalation` | object | No | `{decided_by, decision, decided_at}` when a person decided an escalated action, with `decision` one of `approved`, `denied` or `timed_out` |
| `details` | object | For some kinds | REQUIRED for the kinds `conformance`, `drill` and `variance` |

## Determination

An issuer computes the determination from the profile and the evidence with a conforming TRP evaluator. The reference evaluators in `tools/` are conforming. The issuer runs the evaluator with no drift history.

**Results** Each scored signal produces one result with clause `signal:<signal>`. The outcome is `inconclusive` when the evidence lacks the signal, `violated` when the value is in the critical range, `warning` when it is in the warning range and `satisfied` otherwise. Each hard rule produces one result with clause `rule:<rule>`. The outcome is `inconclusive` when the evaluator reports the rule inconclusive, `violated` when the rule triggered and `satisfied` otherwise. Results MUST be sorted by clause in ascending order of their UTF-16 code units.

**Coverage** A requirement is checked when the evaluator had the evidence it needs and produced an outcome other than `inconclusive`. A hard rule whose field is present with the wrong type is inconclusive, so it is not checked. The checked count is the number of requirements checked, and the total is the number of scored signals plus the number of hard rules. Coverage is checked divided by total, rounded half to even at four decimal places, and 1 when the total is 0. Coverage is reported beside the standing and MUST NOT change it, so a relying party can require a minimum coverage apart from a minimum band.

**Standing** The standing is an object with exactly these members.

| Member | Type | Meaning |
|---|---|---|
| `result` | string | `meets`, `does_not_meet` or `incomplete` |
| `band` | string or null | The band the evaluator assigned, which is a band the profile declares, or `null` when the result is `incomplete` |
| `response` | string or null | The response the profile's `required_standing.response_bands` gives that band, one of `full`, `restricted`, `suspended` or `revoked`, or `null` when the profile gives none or the result is `incomplete` |

The result is `incomplete` when a scored signal is missing from the evidence and its `on_missing` is `incomplete`, which is the default. The result is also `incomplete` when any hard rule is inconclusive, because TRP Section 3.4 gives an inconclusive rule the same outcome. A triggered hard rule does not change an incomplete result, and the triggered rule still appears as `violated` in `results`. An incomplete standing carries a `null` band and a `null` response. When the result is not `incomplete`, it is `meets` when the band is no more severe than the profile's `required_standing.minimum_acceptable_band` and `does_not_meet` when the band is more severe. A profile that declares no minimum acceptable band is met only in its least severe band. A verifier MUST NOT read `incomplete` as `meets` or as `does_not_meet`, and a relying party applies its own policy to an incomplete result. Standing does not depend on coverage.

**Evaluator Output** The evaluator output is the object the TRP reference evaluator returns, with its `evaluation` member removed. The `evaluation` member describes the run itself, and its values change from one run to the next and from one implementation to another. A conforming evaluator MUST produce every other member exactly as the reference evaluators do for the same profile and evidence.

| Member | Meaning |
|---|---|
| `trp_id`, `trp_version` | The identifier and version of the profile |
| `hard_rules_triggered` | Each triggered hard rule as `{rule, action, field, condition}` |
| `hard_rules_inconclusive` | Each inconclusive hard rule as `{rule, field, condition, reason}` |
| `signal_results` | Each scored signal present in the evidence as `{signal, value, unit, severity, penalty, in_warning, in_critical}` |
| `missing_signals` | Each scored signal missing from the evidence as `{signal, on_missing}` |
| `standing` | The band the evaluator assigned |
| `hard_override` | Whether a triggered hard rule set the band |
| `response` | The response for that band, or `unknown` when the profile gives none |

The evaluator runs with no drift history, so the output carries no `drift` member. `tools/README.md` shows an example.

**Result Digest** `result_digest` is the digest of the evaluator output. A verifier that has the profile and the evidence runs either reference evaluator again and compares one digest, so a receipt cannot be detached from the evaluation it describes. A verifier without the evidence cannot recompute `result_digest`, and the issuer's signature binds it to the other claims. `result_digest` is a different value from the evaluator's own `result_hash`, which uses another serialization and is not part of the receipt.

## Canonical Form And Digests

Every digest in this specification is computed over the RFC 8785 JSON Canonicalization Scheme form of a JSON value, encoded as UTF-8, hashed with SHA-256 and encoded as base64url without padding (RFC 4648 section 5). A digest is therefore 43 characters long.

The profile digest in `trp_ref` is computed over the profile document exactly as published. A relying party that has the profile recomputes the digest and compares it with `trp_ref.digest`.

## Envelope

A single receipt is a JSON Web Signature (RFC 7515) in compact serialization.

- The protected header MUST be the canonical form of `{"alg", "kid", "typ"}` and MUST carry no other member.
- `typ` MUST be `vtr+jwt`.
- `alg` MUST be `ES256` (ECDSA with P-256 and SHA-256, RFC 7518 section 3.4) by default. `EdDSA` with Ed25519 (RFC 8037) MAY be used. A verifier MUST refuse an `EdDSA` receipt unless its operator has allowed EdDSA.
- `kid` MUST be the RFC 7638 thumbprint of the signing key's public JSON Web Key.
- The payload MUST be the canonical form of the claims.
- An ES256 signature is the 64 bytes of R followed by S, each 32 bytes, as RFC 7518 section 3.4 requires.

A receipt in any other serialization, or with a header or payload that is not in canonical form, is invalid. Selective Disclosure JSON Web Tokens are reserved for a later credential profile. CBOR Object Signing and Encryption (COSE) envelopes are planned for a later version.

## Key Discovery

The issuer MUST publish its public keys as a JSON Web Key Set (RFC 7517) at `/.well-known/jwks.json` under the origin of `iss` when `iss` is an `https` URI. Each key MUST carry its RFC 7638 thumbprint as `kid`. An issuer that is not an `https` URI MUST make its key set available to relying parties by other means, and receipts from it are verifiable only by parties that hold that key set. A verifier MUST select the key by `kid` and MUST confirm that `kid` equals the thumbprint of the key it selected.

## Batches

An issuer MAY sign many receipts with one signature by signing the root of a Merkle tree over their digests.

- The leaves are the digests of each receipt's claims, in the order the issuer chooses.
- A leaf hash is SHA-256 of the byte 0x00 followed by the 32 bytes of the receipt digest. A node hash is SHA-256 of the byte 0x01 followed by its left child hash and its right child hash. A tree of n leaves splits at the largest power of two smaller than n. This is the Merkle tree hash of RFC 9162 section 2.1.1.
- The batch statement is a compact JWS with `typ` `vtr-batch+jwt` over the canonical form of `{vtr_version, iss, iat, tree_size, root}`, with `root` encoded as base64url without padding. It follows the same header and algorithm rules as a single receipt.
- Each batched receipt is the JSON object `{claims, proof}`, where `proof` is `{leaf_index, tree_size, path, batch}`, `path` is the inclusion proof of RFC 9162 section 2.1.3 as an array of base64url hashes, and `batch` is the batch statement.

A verifier recomputes the root from the claims and the proof with the algorithm of RFC 9162 section 2.1.3.2 and compares it with the signed root. The prefixes 0x00 and 0x01 keep an interior node from verifying as a leaf. The batch statement's `iss` MUST equal the receipt's `iss`, and the proof's `tree_size` MUST equal the signed `tree_size`.

## Verification

A verifier MUST perform these checks and report the receipt invalid at the first one that fails.

1. Parse the compact JWS, or for a batched receipt the batch statement, and confirm the header carries exactly `alg`, `kid` and `typ` with the required values.
2. Select the key by `kid`, confirm `kid` is its RFC 7638 thumbprint, confirm the key type matches `alg`, and verify the signature.
3. Confirm the header and payload are in canonical form.
4. For a batched receipt, recompute the Merkle root from the claims and the inclusion proof and compare it with the signed root.
5. Check the claims against the Claims section, including the absence of unknown members and the order of `results`, and check `standing` against the rules in Determination.
6. When the verifier has the profile, recompute `trp_ref` from it.
7. When the verifier has the evidence, recompute `evidence_digest` from it.
8. When the verifier has both, run the evaluation again and confirm that `result_digest`, `standing`, `results` and `coverage` each equal the values the new run produces.

Drift results are not part of the determination in version 0.5 and are not re-derived. A verifier SHOULD treat a receipt with `mode` other than `enforced` as a record of a decision that did not control the action.

## Agent Actions

A receipt for an AI agent's tool call carries `tool`, `outcome` and `input_digest`, and SHOULD carry `agent`, `model` and `trp_clauses`. The TRP gate in `adapters/gate` issues such a receipt for every tool call and every tool result it judges, chains each one to the previous receipt for the same subject with `prev`, and keeps the evidence it measured in its decision log, so a relying party can run each decision again.

| Gate Action | `outcome` |
|---|---|
| A call allowed, or a result passed to the model | `allow` |
| A call refused by a halt, by a suspended standing or by a restricted standing | `stop` |
| A call held for a person, or a result withheld for review | `escalate` |

## Security Considerations

A receipt proves that the holder of the issuer's key signed a determination. It does not prove the evidence was measured honestly. A relying party that needs that assurance SHOULD require receipts from an evaluator independent of the entity, and MAY require `build` and `evaluators` to identify the code that ran.

The receipt binds the profile by digest, so an issuer cannot later claim a different version of a profile with the same identifier and version. A relying party SHOULD fetch the profile from a source it trusts and compare digests.

`prev` lets a relying party detect a removed or reordered receipt in one issuer's sequence for one subject. Detecting a whole sequence withheld needs a transparency log, which this version does not define.

Keys used only to sign the test vectors in `vtr/vectors/keys` are public and MUST NOT sign real receipts.

## Privacy Considerations

A receipt carries digests of the evidence and of the inputs, never their content. Evidence with low entropy, such as a small set of possible values, can be guessed from its digest. An issuer SHOULD keep such evidence private and SHOULD consider adding a random member to it before hashing. `sub`, `principal` and `on_behalf_of` identify parties. An issuer SHOULD use pairwise identifiers where a relying party does not need a stable one.

## Relationship To Other Work

| Work | Relationship |
|---|---|
| IETF SCITT, RFC 9943, and COSE Receipts, RFC 9942 | A VTR can be registered with a SCITT transparency service as the payload of a signed statement. A COSE envelope and a SCITT profile are planned |
| RFC 9334 and Entity Attestation Token results | VTR takes its roles from RFC 9334 and is an attestation result whose appraisal policy is a TRP profile |
| Individual drafts for AI agent action receipts, 2026 | Those drafts record agent actions with hash chains and signatures. A VTR also binds each decision to a content-addressed, versioned requirement profile with a result for every requirement, its coverage and its mode |
| in-toto and SLSA provenance | Those record how an artifact was built. A VTR records how a running system was judged |

## Conformance

An issuer conforms when every receipt it produces passes the checks in Verification for a verifier that has the profile and evidence. A verifier conforms when it returns the expected result for every vector in `vtr/vectors`. The valid vectors include a receipt for each standing result, and each invalid vector names the reason a verifier must report. `tests/vtr_check.py` runs the Python and Node.js reference verifiers over all vectors and confirms they agree.
