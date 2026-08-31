# Changelog

All notable changes to the TRP specification and tooling are documented here.
This project follows [Semantic Versioning](https://semver.org/) for the
specification and [Keep a Changelog](https://keepachangelog.com/) format.

## [0.5.1] - 2026-08-28

### Added
- Conformance test suite with 17 tests across schema validation, rejection,
  example verification, and evaluator determinism (`tests/`).
- GitHub Actions CI workflow running on Python 3.10 and 3.12 on every push
  and pull request (`.github/workflows/ci.yml`).
- `SECURITY.md` vulnerability reporting policy.
- `CHANGELOG.md` (this file).
- `requirements.txt` for reproducible dependency installation.
- Test profiles exercising minimal, full-featured, and inheritance scenarios.
- Evidence samples covering healthy, warning, critical, hard-rule, and
  missing-signal evaluation paths.

### Changed
- Updated `ROADMAP.md` to reflect completed conformance test suite.

## [0.5.0] - 2026-08-19

### Added
- TRP specification v0.5 public working draft (`spec/trp-spec.md`).
- JSON Schema for profile validation, Draft 2020-12
  (`schema/trp.schema.json`).
- Reference evaluator with scored signals, hard rules, drift detection, and
  standing band assignment (`tools/evaluate.py`).
- Manufacturing robot cell safety reference profile.
- Healthcare data governance reference profile.
- Contribution guidelines (`CONTRIBUTING.md`).
- Governance model and stewardship documentation (`GOVERNANCE.md`).
- Project roadmap (`ROADMAP.md`).
- Apache 2.0 license.
- Zenodo DOI registration (10.5281/zenodo.22099404).
