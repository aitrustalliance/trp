# Contributing to TRP

Thank you for your interest in contributing to the Trust Requirements Profile standard. Contributions from domain practitioners, researchers, and engineers are what make an open standard work.

## Ways to Contribute

### Author a Domain Profile

The most valuable contribution is a new profile for your domain. A profile translates real requirements into the TRP format. See `examples/manufacturing-safety/` and `examples/healthcare-data-governance/` for working references.

To contribute a profile:

1. Fork this repository.
2. Create a folder under `examples/` named for your domain and use case (e.g., `examples/financial-operations/`).
3. Write your profile as a `trp.json` file that validates against `schema/trp.schema.json`.
4. Include a brief README in your folder describing the use case, the source of the requirements, and any assumptions.
5. Open a pull request.

Your profile carries its own author, version, license, and taxonomy. Your work stays attributed and yours.

### Report an Issue or Ask a Question

Open a [GitHub Issue](../../issues) to report a problem with the spec, suggest a new feature, or ask a question. Tag your issue with the appropriate label if one exists.

### Propose a Spec Change

For changes to the specification itself (`spec/trp-spec.md`) or the schema (`schema/trp.schema.json`), open an issue first to discuss the change before submitting a pull request. Spec changes require review and approval by the steward under [GOVERNANCE.md](GOVERNANCE.md).

### Register An Extension Key

A module intended for wide use registers its top-level `x_` key by pull request to `extensions/registry.json`. Keys that use a URI namespace you control need no registration. See [extensions/README.md](extensions/README.md).

### Improve Documentation

Fixes to documentation, additional examples, and clarifications are always welcome. Submit a pull request directly.

## Validation

Before submitting a profile, validate it against the schema:

```bash
pip install jsonschema
python -c "import json,jsonschema; jsonschema.Draft202012Validator(json.load(open('schema/trp.schema.json'))).validate(json.load(open('your-profile.json')))"
```

No output means the profile is valid.

## Code of Conduct

Be constructive, specific, and respectful. This is a standards project; disagreement on technical choices is expected and welcome. Personal attacks are not.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0 unless your profile specifies a different license in its `license` field.
