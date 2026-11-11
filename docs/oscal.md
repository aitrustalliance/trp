# OSCAL Export And Import

`tools/trp_oscal.py` writes a TRP (Trust Requirements Profile) profile in the Open Security Controls Assessment Language (OSCAL) of the National Institute of Standards and Technology (NIST) and reads OSCAL back into TRP. It writes OSCAL 1.2.3, the latest release in the `usnistgov/OSCAL` repository on 2026-11-04, and checks every document it writes against the official 1.2.3 JSON schemas.

```bash
python tools/trp_oscal.py export profile.json --out-dir out/ --catalog sp800-53r5=NIST_SP-800-53_rev5_catalog.json
python tools/trp_oscal.py validate out/*.json
python tools/trp_oscal.py import out/my-profile.oscal-profile.json > profile.json
python tools/trp_oscal.py import NIST_AI-RMF_v1_catalog.json --authority example.com --controls MEASURE_2.4 > skeleton.json
```

## Documents

| File | OSCAL Model | Written When | Contents |
|---|---|---|---|
| `<trp_id>.oscal-catalog.json` | Catalog | Always | One control per scored signal and one per hard rule, with every other member of the profile in metadata props |
| `<trp_id>.oscal-profile.json` | Profile | Always | Imports of every control of the TRP catalog and of the mapped controls of each outside catalog, with the same metadata props |
| `<trp_id>.oscal-mapping.json` | Mapping collection under the Control Mapping model | The profile declares mappings in `x_oscal` | One map per declared mapping |

A tool that reads only catalogs still sees every requirement in the TRP catalog. The OSCAL profile names each catalog it imports through a back-matter resource whose link has the media type `application/oscal.catalog+json`, the form NIST's own baseline profiles use. Every UUID is a version 5 UUID under `https://aitrustalliance.com/ns/trp`, built from the profile's digest and the object's place in it, so the same profile always gives the same bytes and a changed profile gives new document UUIDs.

`metadata.last-modified` is the profile's `created_at` unless `--last-modified` gives another time. OSCAL requires a time zone and a year from 1900 to 2999, and the export refuses a value outside that form.

## Namespace

TRP data that OSCAL has no field for travels in OSCAL props whose `ns` is `https://aitrustalliance.com/ns/trp`. The URI is a naming system identifier in the sense OSCAL gives `ns` and does not need to resolve. Each prop in that namespace carries one TRP member.

- The prop's `name` is the member's name. `$schema` travels as `json_schema` and `$id` as `json_id`. A URI extension key is no OSCAL token, so it travels in a prop named `extension` whose value is a JSON object with that one member.
- A string with no leading or trailing whitespace and no line break travels as it is. Any other value travels as one line of ASCII JSON, and the prop's `class` is `json`.
- An OSCAL tool sees ordinary props in a namespace it does not know. The import reads only props in this namespace and refuses a prop in it whose `class` is anything other than `json`.

| TRP Member | OSCAL Location | Read Back From |
|---|---|---|
| Every top-level member except `scored_signals` and `hard_rules` | One prop each in the metadata of the catalog and of the profile | The props, which must agree in both documents |
| `name` and `description` | Also `metadata.title` and `metadata.remarks`, for a person reading the document | The props |
| `version` and `created_at` | Also `metadata.version` and `metadata.last-modified` | The props |
| A scored signal | Control `signal.<signal>` in group `signals`, with one prop per member and a statement part that describes the thresholds | The props and the two parameters |
| `warning_threshold` and `critical_threshold` | Parameters `<control id>_warning_threshold` and `<control id>_critical_threshold`, each with one value, which the statement inserts with `{{ insert: param, <id> }}` | The parameters, after any `set-parameters` of the OSCAL profile |
| `reason` | A prop and a guidance part | The prop |
| A hard rule | Control `rule.<rule>` in group `rules`, with one prop per member and a statement part | The props |

A signal name that cannot follow `signal.` in an OSCAL token gets the identifier `signal.sha256-` and the first 16 hexadecimal digits of the SHA-256 of the name, and its `signal` prop keeps the name. The import reads the members of a signal and a rule in prop order and puts the thresholds back where the schema order places them, and it puts `scored_signals` and `hard_rules` back the same way, so a profile written in schema order comes back in its own order.

## Mappings

`assurance_mapping` names a framework and a reference token for the whole profile and stays informative. A profile that relates single requirements to single controls declares `x_oscal`, a top-level extension listed in `extensions/registry.json`.

```json
"x_oscal": {
  "catalogs": {
    "sp800-53r5": {
      "title": "NIST SP 800-53 Rev. 5.2.0",
      "href": "https://raw.githubusercontent.com/usnistgov/oscal-content/v1.6.0/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json"
    }
  },
  "provenance": { "method": "human", "matching_rationale": "semantic", "status": "draft" },
  "mappings": [
    { "clause": "rule:credential_in_arguments", "catalog": "sp800-53r5", "control": "ac-4", "relationship": "intersects-with" }
  ]
}
```

| Member | Meaning |
|---|---|
| `catalogs` | Each outside catalog under a local name, with its `href` and an optional `title` |
| `provenance` | The provenance values OSCAL requires of a mapping collection, each one a value OSCAL 1.2.3 allows. Required when the profile declares mappings |
| `mappings` | One entry per relationship. `clause` names a requirement the way a Verifiable Trust Receipt (VTR) does, `signal:<signal>` or `rule:<rule>`. `catalog` names an entry of `catalogs` and `control` is the control's identifier in it. `relationship` is `equivalent-to`, `equal-to`, `subset-of`, `superset-of`, `intersects-with` or `no-relationship`. `remarks` is optional |

The export writes one OSCAL `mapping` per outside catalog, with the TRP catalog as its source and the outside catalog as its target, and one `map` per entry. A relationship states how the source requirement relates to the target control, as the OSCAL model defines the values. The export writes no confidence score or coverage value, since a TRP profile declares neither. It writes no qualifiers, since the published 1.2.3 mapping schema requires a qualifier's `description` and forbids it in the same definition, so no map with qualifiers can validate against it.

The export checks each mapped control against a local copy of its catalog, given with `--catalog NAME=PATH`, and refuses a control that is missing or withdrawn. It refuses a catalog with no local copy unless `--allow-unchecked` is given.

## Tailoring

An OSCAL profile can change a threshold with `modify.set-parameters` on a threshold parameter and can drop a requirement with `exclude-controls` on the TRP catalog import. The import applies both. The result is a different profile under the same `trp_id` and `version`, and the VTR profile digest tells the two apart, so whoever tailors a profile gives the result a new version. The import refuses `alters`, a set-parameter for any other parameter, an exclusion of a requirement that `x_oscal` maps and an outside import that `x_oscal` does not declare.

## Import

The import reads one OSCAL catalog or profile.

**Written by the export** The document comes back as the TRP profile it was written from, equal as JSON data, so its RFC 8785 canonical form and its VTR profile digest are the same. The catalog alone is enough, and the profile needs its TRP catalog beside it.

**Any other catalog or profile** The document becomes a skeleton with one placeholder scored signal per selected control that is not withdrawn. A placeholder carries only `signal`, which is the control identifier, and `reason`, which quotes the control's title and its overview or statement prose. The skeleton has no `scope` and no `standing_bands`, and its `x_oscal` links each placeholder to its control with no relationship. It fails the TRP schema at each member a person has to decide, so no conforming evaluator accepts it and the export refuses it until a person completes it. The tool never writes a threshold, a weight, a direction or a relationship it was not given.

A catalog import takes every control that is not withdrawn. With `--controls` it takes exactly the controls named there and refuses an unknown or withdrawn one. A profile import follows the profile's own control selection, including `matching` patterns and child controls, and its `exclude-controls`. It does not read the profile's `set-parameters`, since a placeholder has no parameter to set. An import that names a back-matter resource follows the resource's JSON link. The tool never fetches anything, so `--resolve HREF=PATH` gives a local copy for a location that is absolute or not next to the document.

A skeleton needs `--authority`, the party responsible for the new profile. `--trp-id` defaults to the OSCAL title in lowercase with hyphens, and `--version` defaults to `0.1.0`.

## Validation

`tools/trp_oscal.py validate` checks documents against the official OSCAL 1.2.3 JSON schemas in `fixtures/oscal/schemas`, downloaded from the release assets of `usnistgov/OSCAL` v1.2.3. The schemas are JSON Schema draft 07, and their `TokenDatatype` uses the Unicode property escapes `\p{L}` and `\p{N}`, which Python's `re` module lacks. The validator spells out both categories from the Unicode database of the running Python and runs every other pattern unchanged. Format keywords stay annotations, as the `jsonschema` package treats them by default, and the patterns the schemas give for times and UUIDs still apply.

OSCAL also defines allowed values and other constraints in its metaschema, outside the JSON schemas. The tool checks the allowed values of the Control Mapping model itself. The OSCAL command line tool that checks every metaschema constraint was not run, since its distribution channel was out of reach of the build environment.

## Checks

```bash
pip install jsonschema && python tests/oscal_check.py
```

The check compares the export of `fixtures/oscal/profiles/oscal-mapping-test.trp.json` with golden files byte for byte and validates every document against the official schemas. It exports every TRP profile in the repository and validates each export. Each one must come back equal to the original from the OSCAL profile and from the catalog alone. It imports NIST's SP 800-53 Rev. 5 and AI RMF 1.0 catalogs from `oscal-content` 1.6.0, along with NIST's SP 800-53 LOW baseline profile, and no placeholder may carry a threshold. It also tries tailoring and malformed documents, and each failure path must be refused with its own message. `fixtures/oscal/sources.json` records the source of each vendored file, and the check compares each file's SHA-256 and its Git object identifier with the upstream values.

## Files

| File | Purpose |
|---|---|
| `tools/trp_oscal.py` | The tool, written for the Python standard library plus `jsonschema` |
| `fixtures/oscal/schemas/` | The official OSCAL 1.2.3 JSON schemas of every model the tool writes |
| `fixtures/oscal/content/` | Two NIST catalogs and one NIST profile from `oscal-content` 1.6.0, unchanged |
| `fixtures/oscal/profiles/oscal-mapping-test.trp.json` | A test profile with illustrative `x_oscal` mappings to both NIST catalogs |
| `fixtures/oscal/golden/` | The export of that profile |
| `fixtures/oscal/sources.json` | Provenance and license of every vendored file |
