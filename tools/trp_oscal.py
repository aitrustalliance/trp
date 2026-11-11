#!/usr/bin/env python3
"""TRP to OSCAL and back.

OSCAL is the Open Security Controls Assessment Language of the National Institute of Standards and Technology (NIST).
This tool writes OSCAL version 1.2.3.

    python tools/trp_oscal.py export profile.json --out-dir out/ [--catalog NAME=PATH ...] [--last-modified TIME]
    python tools/trp_oscal.py import out/<trp_id>.oscal-profile.json > profile.json
    python tools/trp_oscal.py import catalog.json --authority example.com [--controls ac-2,si-4] > skeleton.json
    python tools/trp_oscal.py validate out/*.json

export writes three documents for one TRP (Trust Requirements Profile) profile.

- A TRP-native OSCAL catalog with one control per scored signal and one per hard rule, so a tool that reads only
  catalogs still sees every requirement.
- An OSCAL profile that imports every control of that catalog and the controls of each outside catalog the TRP
  profile maps to, such as NIST SP 800-53 Rev. 5.
- An OSCAL mapping collection, under the Control Mapping model of OSCAL 1.2, when the TRP profile declares mappings in
  its x_oscal extension.

TRP data with no home in OSCAL travels in props under the namespace TRP_NS, one prop per TRP member, and the two
thresholds of each scored signal travel as OSCAL parameters, so an OSCAL profile can tailor them with set-parameters.
docs/oscal.md documents the encoding.

import reads a document export wrote back into the TRP profile it came from. It reads any other OSCAL catalog or
profile into a TRP skeleton with one placeholder scored signal per selected control. A placeholder carries the
control's name and nothing a person has to decide, so the skeleton fails the TRP schema until a person completes
every placeholder. The tool never writes a threshold it was not given.
"""

from __future__ import annotations

import argparse
import fnmatch
import functools
import hashlib
import json
import re
import sys
import unicodedata
import uuid
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TRP_SCHEMA = ROOT / "schema" / "trp.schema.json"
OSCAL_SCHEMAS = ROOT / "fixtures" / "oscal" / "schemas"

OSCAL_VERSION = "1.2.3"
OSCAL_NS = "http://csrc.nist.gov/ns/oscal"
TRP_NS = "https://aitrustalliance.com/ns/trp"
UUID_NS = uuid.uuid5(uuid.NAMESPACE_URL, TRP_NS)  # every UUID this tool writes is a version 5 UUID under this namespace
TRP_SCHEMA_URI = "https://aitrustalliance.com/schema/trp/0.6/trp.schema.json"
TRP_SPEC_VERSION = "0.6"
CATALOG_MEDIA_TYPE = "application/oscal.catalog+json"

SIGNALS_GROUP, RULES_GROUP = "signals", "rules"
SIGNAL_CLASS, RULE_CLASS = "trp-scored-signal", "trp-hard-rule"
THRESHOLDS = ("warning_threshold", "critical_threshold")
JSON_CLASS = "json"
EXTENSION_PROP = "extension"
RENAMED = {"$schema": "json_schema", "$id": "json_id"}
RESTORED = {v: k for k, v in RENAMED.items()}

# Member order of the TRP schema. An imported profile lists its members in this order, then extensions in the order
# their props appear.
TOP_ORDER = (
    "$schema",
    "$id",
    "trp_id",
    "spec_version",
    "version",
    "name",
    "description",
    "authority",
    "author",
    "created_at",
    "valid_from",
    "valid_to",
    "license",
    "taxonomy",
    "scope",
    "scored_signals",
    "hard_rules",
    "drift",
    "standing_bands",
    "required_standing",
    "assurance_mapping",
    "notes",
    "extends",
)
SIGNAL_ORDER = ("signal", "weight", "direction", *THRESHOLDS, "unit", "reason", "on_missing")
RULE_ORDER = ("rule", "field", "condition", "value", "action")

# OSCAL 1.2.3 allowed values for the Control Mapping model, from src/metaschema/oscal_mapping-common_metaschema.xml.
# The JSON schema does not carry these, so the tool checks them.
RELATIONSHIPS = ("equivalent-to", "equal-to", "subset-of", "superset-of", "intersects-with", "no-relationship")
METHODS = ("human", "automation", "hybrid")
RATIONALES = ("syntactic", "semantic", "functional")
STATUSES = ("complete", "not-complete", "draft", "deprecated", "superseded")
X_OSCAL = "x_oscal"

# DateTimeWithTimezoneDatatype of the OSCAL 1.2.3 JSON schemas, copied from the published schema.
OSCAL_DATE_TIME = re.compile(
    r"^(((2000|2400|2800|(19|2[0-9](0[48]|[2468][048]|[13579][26])))-02-29)|(((19|2[0-9])[0-9]{2})-02-(0[1-9]|1[0-9]"
    r"|2[0-8]))|(((19|2[0-9])[0-9]{2})-(0[13578]|10|12)-(0[1-9]|[12][0-9]|3[01]))|(((19|2[0-9])[0-9]{2})-(0[469]|11)"
    r"-(0[1-9]|[12][0-9]|30)))T(2[0-3]|[01][0-9]):([0-5][0-9]):([0-5][0-9])(\.[0-9]+)?(Z|(-((0[0-9]|1[0-2]):00|0[39]:30)"
    r"|\+((0[0-9]|1[0-4]):00|(0[34569]|10):30|(0[58]|12):45)))$"
)
# Whitespace under ECMAScript, the regular expression dialect JSON Schema names, and line terminators. A prop value
# carried as it is avoids all of them at its ends and avoids line terminators anywhere, so it matches StringDatatype
# in Python and in an ECMAScript engine alike.
ECMA_SPACE = frozenset("\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff") | frozenset(
    chr(c) for c in range(0x2000, 0x200B)
)
LINE_BREAKS = frozenset("\n\r\u2028\u2029")


class OscalError(ValueError):
    """A document this tool cannot read or write as asked. The message says why."""


# ---------------------------------------------------------------- OSCAL datatypes


def is_token(text: object) -> bool:
    """TokenDatatype, ^(\\p{L}|_)(\\p{L}|\\p{N}|[.\\-_])*$, from the Unicode general categories."""
    if not isinstance(text, str) or not text:
        return False
    if not (unicodedata.category(text[0]).startswith("L") or text[0] == "_"):
        return False
    return all(unicodedata.category(c)[0] in "LN" or c in ".-_" for c in text[1:])


def is_plain(text: object) -> bool:
    """A string an OSCAL prop value carries as it is, under StringDatatype ^\\S(.*\\S)?$."""
    if not isinstance(text, str) or not text:
        return False
    ends = (text[0], text[-1])
    if any(c in ECMA_SPACE or c.isspace() for c in ends):
        return False
    return not any(c in LINE_BREAKS for c in text)


def is_line(text: object) -> bool:
    """MarkupLineDatatype, ^[^\\n]+$, for titles and labels, with no other line terminator either."""
    return isinstance(text, str) and bool(text) and not any(c in LINE_BREAKS for c in text)


def json_text(value: Any) -> str:
    """One line of JSON, ASCII only, members in their given order."""
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def canonical(value: Any) -> str:
    """RFC 8785 canonical JSON, through the reference evaluator's own implementation."""
    sys.path.insert(0, str(ROOT / "tools"))
    import evaluate

    text: str = evaluate.canonical_json(value)
    return text


def profile_sha256(profile: Mapping[str, Any]) -> str:
    """SHA-256 of the RFC 8785 canonical profile in hexadecimal, the hash VTR trp_ref.digest gives in base64url."""
    return hashlib.sha256(canonical(profile).encode("utf-8")).hexdigest()


def doc_uuid(*parts: str) -> str:
    return str(uuid.uuid5(UUID_NS, "|".join(parts)))


# ---------------------------------------------------------------- props


def prop_name(member: str) -> str:
    if member in RENAMED:
        return RENAMED[member]
    return member if is_token(member) else EXTENSION_PROP


def to_prop(member: str, value: Any) -> dict[str, Any]:
    """One TRP member as one prop. A member name that is not an OSCAL token, such as a URI extension key, becomes a
    prop named extension whose value is a one-member JSON object."""
    name = prop_name(member)
    if name == EXTENSION_PROP:
        return {"name": name, "ns": TRP_NS, "value": json_text({member: value}), "class": JSON_CLASS}
    if isinstance(value, str) and is_plain(value):
        return {"name": name, "ns": TRP_NS, "value": value}
    return {"name": name, "ns": TRP_NS, "value": json_text(value), "class": JSON_CLASS}


def from_props(props: Sequence[Any], where: str) -> dict[str, Any]:
    """The TRP members the TRP props of one OSCAL object carry, in prop order. Props in other namespaces are skipped."""
    out: dict[str, Any] = {}
    for p in props:
        if not isinstance(p, dict) or p.get("ns") != TRP_NS:
            continue
        name, raw = p.get("name"), p.get("value")
        if not isinstance(name, str) or not isinstance(raw, str):
            raise OscalError(f"{where}: a TRP prop has no name or no value")
        if p.get("class") == JSON_CLASS:
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                raise OscalError(f"{where}: TRP prop {name} has class json and a value that is not JSON") from None
        elif "class" in p:
            raise OscalError(f"{where}: TRP prop {name} has class {p['class']!r}, and only json is defined")
        else:
            value = raw
        if name == EXTENSION_PROP:
            if not isinstance(value, dict) or len(value) != 1 or "class" not in p:
                raise OscalError(f"{where}: an extension prop must carry a JSON object with one member")
            member, value = next(iter(value.items()))
        else:
            member = RESTORED.get(name, name)
        if member in out:
            raise OscalError(f"{where}: TRP member {member} appears in two props")
        out[member] = value
    return out


def ordered(members: Mapping[str, Any], placed: Sequence[str], order: Sequence[str]) -> dict[str, Any]:
    """members in their prop order, with each member named in placed, which has no prop of its own, put back before
    the first member that follows it in the schema order. A profile written in schema order comes back in its own
    order."""
    rank = {k: i for i, k in enumerate(order)}
    pending = [k for k in order if k in placed and k in members]
    out: dict[str, Any] = {}
    for k, v in members.items():
        if k in placed:
            continue
        while pending and k in rank and rank[pending[0]] < rank[k]:
            first = pending.pop(0)
            out[first] = members[first]
        out[k] = v
    for k in pending:
        out[k] = members[k]
    return out


# ---------------------------------------------------------------- controls


def control_id(kind: str, name: str) -> str:
    """signal.<name> or rule.<name>, or a digest of the name when the name cannot form an OSCAL token."""
    cid = f"{kind}.{name}"
    return cid if is_token(cid) else f"{kind}.sha256-{hashlib.sha256(name.encode('utf-8')).hexdigest()[:16]}"


def param_id(cid: str, member: str) -> str:
    return f"{cid}_{member}"


def insert(pid: str) -> str:
    return "{{ insert: param, " + pid + " }}"


def number_text(value: Any) -> str:
    return json.dumps(value)


def signal_statement(s: Mapping[str, Any], cid: str) -> str:
    """Prose for a person reading the catalog. It follows the reference evaluators, where a lower_is_unsafe signal is
    a warning below its warning threshold and critical at or below its critical threshold."""
    unit = s.get("unit")
    text = f"Measure `{s['signal']}`" + (f" in {unit}." if isinstance(unit, str) and unit else ".")
    w, c = insert(param_id(cid, THRESHOLDS[0])), insert(param_id(cid, THRESHOLDS[1]))
    if s["direction"] == "lower_is_unsafe":
        text += f" Lower values are unsafe. A value below {w} is a warning, and a value at or below {c} is critical."
    else:
        text += f" Higher values are unsafe. A value above {w} is a warning, and a value at or above {c} is critical."
    if s["weight"] == 0:
        text += " Weight 0 makes the signal informational, so it is reported and never moves the band."
    else:
        text += f" Weight {number_text(s['weight'])}."
    missing = {
        "critical": "A missing value counts as critical.",
        "ignore": "A missing value is left out of the assessment.",
    }.get(s.get("on_missing", "incomplete"), "A missing value makes the assessment incomplete.")
    return f"{text} {missing}"


CONDITIONS = {
    "is_true": "is true",
    "is_false": "is false",
    "equals": "equals",
    "not_equals": "does not equal",
    "less_than": "is less than",
    "greater_than": "is greater than",
}


def rule_statement(r: Mapping[str, Any]) -> str:
    phrase = CONDITIONS[r["condition"]]
    if r["condition"] not in ("is_true", "is_false"):
        phrase += f" `{json.dumps(r.get('value'))}`"
    return (
        f"When `{r['field']}` {phrase}, the action is {r['action']}. A missing field or a value of the wrong type "
        "leaves the rule inconclusive, which makes the assessment incomplete."
    )


def signal_control(s: Mapping[str, Any]) -> dict[str, Any]:
    cid = control_id("signal", s["signal"])
    parts: list[dict[str, Any]] = [{"id": f"{cid}_smt", "name": "statement", "prose": signal_statement(s, cid)}]
    if isinstance(s.get("reason"), str) and s["reason"]:
        parts.append({"id": f"{cid}_gdn", "name": "guidance", "prose": s["reason"]})
    return {
        "id": cid,
        "class": SIGNAL_CLASS,
        "title": s["signal"] if is_line(s["signal"]) else cid,
        "params": [
            {"id": param_id(cid, t), "label": t.replace("_", " "), "values": [number_text(s[t])]} for t in THRESHOLDS
        ],
        "props": [to_prop(k, v) for k, v in s.items() if k not in THRESHOLDS],
        "parts": parts,
    }


def rule_control(r: Mapping[str, Any]) -> dict[str, Any]:
    cid = control_id("rule", r["rule"])
    return {
        "id": cid,
        "class": RULE_CLASS,
        "title": r["rule"],
        "props": [to_prop(k, v) for k, v in r.items()],
        "parts": [{"id": f"{cid}_smt", "name": "statement", "prose": rule_statement(r)}],
    }


def clause_controls(profile: Mapping[str, Any]) -> dict[str, str]:
    """VTR clause name to control identifier, for every scored signal and hard rule. Raises on a collision."""
    out: dict[str, str] = {}
    seen: dict[str, str] = {}
    for kind, key, member in (("signal", "signal", "scored_signals"), ("rule", "rule", "hard_rules")):
        for item in profile.get(member, []):
            clause = f"{kind}:{item[key]}"
            cid = control_id(kind, item[key])
            if clause in out:
                raise OscalError(f"{clause} is declared twice")
            if cid in seen:
                raise OscalError(f"{clause} and {seen[cid]} would share the control identifier {cid}")
            out[clause], seen[cid] = cid, clause
    return out


# ---------------------------------------------------------------- outside catalogs


def walk_controls(container: Mapping[str, Any]) -> Iterator[dict[str, Any]]:
    """Every control of a catalog or group, depth first in document order, child controls after their parent."""

    def controls(items: Sequence[Any]) -> Iterator[dict[str, Any]]:
        for c in items:
            if isinstance(c, dict):
                yield c
                yield from controls(c.get("controls", []))

    yield from controls(container.get("controls", []))
    for g in container.get("groups", []):
        if isinstance(g, dict):
            yield from walk_controls(g)


def is_withdrawn(control: Mapping[str, Any]) -> bool:
    return any(
        isinstance(p, dict)
        and p.get("name") == "status"
        and p.get("value") == "withdrawn"
        and p.get("ns", OSCAL_NS) == OSCAL_NS
        for p in control.get("props", [])
    )


def catalog_index(doc: Mapping[str, Any], where: str) -> dict[str, dict[str, Any]]:
    """Control identifier to control for an OSCAL catalog document. Raises when the document is not a catalog or two
    controls share an identifier."""
    catalog = doc.get("catalog") if isinstance(doc, Mapping) else None
    if not isinstance(catalog, dict):
        raise OscalError(f"{where} is not an OSCAL catalog")
    index: dict[str, dict[str, Any]] = {}
    for c in walk_controls(catalog):
        cid = c.get("id")
        if not isinstance(cid, str):
            raise OscalError(f"{where}: a control has no id")
        if cid in index:
            raise OscalError(f"{where}: two controls have the id {cid}")
        index[cid] = c
    return index


# ---------------------------------------------------------------- the x_oscal extension


def read_x_oscal(profile: Mapping[str, Any], clauses: Mapping[str, str]) -> dict[str, Any] | None:
    """The x_oscal member, checked for export. None when the profile has none."""
    x = profile.get(X_OSCAL)
    if x is None:
        return None
    if not isinstance(x, dict):
        raise OscalError("x_oscal is not an object")
    unknown = set(x) - {"catalogs", "provenance", "mappings"}
    if unknown:
        raise OscalError(f"x_oscal has members this version does not define: {', '.join(sorted(unknown))}")
    catalogs = x.get("catalogs", {})
    if not isinstance(catalogs, dict):
        raise OscalError("x_oscal.catalogs is not an object")
    for name, entry in catalogs.items():
        if not isinstance(entry, dict) or set(entry) - {"title", "href"} or not is_plain(entry.get("href")):
            raise OscalError(f"x_oscal.catalogs.{name} needs an href and may carry a title, and nothing else")
        if "title" in entry and not is_line(entry["title"]):
            raise OscalError(f"x_oscal.catalogs.{name}.title is not one line of text")
    mappings = x.get("mappings", [])
    if not isinstance(mappings, list):
        raise OscalError("x_oscal.mappings is not an array")
    seen = set()
    for i, m in enumerate(mappings):
        where = f"x_oscal.mappings[{i}]"
        if not isinstance(m, dict) or set(m) - {"clause", "catalog", "control", "relationship", "remarks"}:
            raise OscalError(f"{where} carries members this version does not define")
        if m.get("clause") not in clauses:
            raise OscalError(f"{where}.clause names no scored signal or hard rule of the profile")
        if m.get("catalog") not in catalogs:
            raise OscalError(f"{where}.catalog names no entry of x_oscal.catalogs")
        if not is_plain(m.get("control")):
            raise OscalError(f"{where}.control is not a control identifier")
        if "relationship" not in m:
            raise OscalError(f"{where} declares no relationship, so a person has to choose one before export")
        if m["relationship"] not in RELATIONSHIPS:
            raise OscalError(f"{where}.relationship is not one of {', '.join(RELATIONSHIPS)}")
        if "remarks" in m and not isinstance(m["remarks"], str):
            raise OscalError(f"{where}.remarks is not a string")
        triple = (m["clause"], m["catalog"], m["control"])
        if triple in seen:
            raise OscalError(f"{where} repeats a mapping")
        seen.add(triple)
    provenance = x.get("provenance")
    if mappings and provenance is None:
        raise OscalError("x_oscal.provenance is required when x_oscal declares mappings")
    if provenance is not None:
        if not isinstance(provenance, dict) or set(provenance) != {"method", "matching_rationale", "status"}:
            raise OscalError("x_oscal.provenance carries exactly method, matching_rationale and status")
        for key, allowed in (("method", METHODS), ("matching_rationale", RATIONALES), ("status", STATUSES)):
            if provenance[key] not in allowed:
                raise OscalError(f"x_oscal.provenance.{key} is not one of {', '.join(allowed)}")
    return {"catalogs": catalogs, "provenance": provenance, "mappings": mappings}


def check_mapped_controls(x: Mapping[str, Any], local: Mapping[str, Mapping[str, Any]], allow_unchecked: bool) -> None:
    """Every mapped control exists and is not withdrawn in the local copy of its catalog."""
    indexes = {name: catalog_index(doc, f"the local copy of {name}") for name, doc in local.items()}
    unknown = set(local) - set(x["catalogs"])
    if unknown:
        raise OscalError(f"--catalog names {', '.join(sorted(unknown))}, which x_oscal.catalogs does not declare")
    for m in x["mappings"]:
        index = indexes.get(m["catalog"])
        if index is None:
            if allow_unchecked:
                continue
            raise OscalError(
                f"no local copy of catalog {m['catalog']} to check control {m['control']} against. Pass --catalog "
                f"{m['catalog']}=PATH, or --allow-unchecked to export without the check"
            )
        control = index.get(m["control"])
        if control is None:
            raise OscalError(f"catalog {m['catalog']} has no control {m['control']}")
        if is_withdrawn(control):
            raise OscalError(f"control {m['control']} of catalog {m['catalog']} is withdrawn")


# ---------------------------------------------------------------- export


def validate_trp(profile: Mapping[str, Any]) -> list[str]:
    """Error messages from the TRP schema, empty when the profile is valid."""
    import jsonschema  # type: ignore[import-untyped]

    schema = json.loads(TRP_SCHEMA.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    return [f"{'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message}" for e in validator.iter_errors(profile)]


def file_names(trp_id: str) -> dict[str, str]:
    return {k: f"{trp_id}.oscal-{k}.json" for k in ("profile", "catalog", "mapping")}


def metadata(profile: Mapping[str, Any], title: str, last_modified: str, props: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "title": title,
        "last-modified": last_modified,
        "version": profile["version"],
        "oscal-version": OSCAL_VERSION,
        "props": props,
    }
    if isinstance(profile.get("description"), str) and profile["description"]:
        out["remarks"] = profile["description"]
    return out


def export(
    profile: Mapping[str, Any],
    last_modified: str | None = None,
    local_catalogs: Mapping[str, Mapping[str, Any]] | None = None,
    allow_unchecked: bool = False,
) -> dict[str, dict[str, Any]]:
    """The OSCAL documents for one TRP profile, keyed by file name. The profile must be valid."""
    if not isinstance(profile, Mapping):
        raise OscalError("the TRP profile is not a JSON object")
    errors = validate_trp(profile)
    if errors:
        raise OscalError("the TRP profile is not valid: " + "; ".join(errors[:5]))
    lm = last_modified if last_modified is not None else profile.get("created_at")
    if lm is None:
        raise OscalError("the profile has no created_at, so pass --last-modified")
    if not isinstance(lm, str) or not OSCAL_DATE_TIME.match(lm):
        raise OscalError(f"{lm!r} is not an OSCAL date and time with a time zone, so pass --last-modified")
    clauses = clause_controls(profile)
    x = read_x_oscal(profile, clauses)
    if x is not None:
        check_mapped_controls(x, local_catalogs or {}, allow_unchecked)
    elif local_catalogs:
        raise OscalError("--catalog was given, and the profile declares no x_oscal catalogs")

    trp_id = profile["trp_id"]
    digest = profile_sha256(profile)
    names = file_names(trp_id)
    title = profile["name"] if is_line(profile.get("name")) else trp_id
    props = [to_prop(k, v) for k, v in profile.items() if k not in ("scored_signals", "hard_rules")]

    groups: list[dict[str, Any]] = []
    for member, gid, gclass, gtitle, make in (
        ("scored_signals", SIGNALS_GROUP, "trp-scored-signals", "Scored Signals", signal_control),
        ("hard_rules", RULES_GROUP, "trp-hard-rules", "Hard Rules", rule_control),
    ):
        if member in profile:
            group: dict[str, Any] = {"id": gid, "class": gclass, "title": gtitle}
            controls = [make(item) for item in profile[member]]
            if controls:
                group["controls"] = controls
            groups.append(group)
    catalog: dict[str, Any] = {"uuid": doc_uuid("catalog", digest), "metadata": metadata(profile, title, lm, props)}
    if groups:
        catalog["groups"] = groups

    trp_resource = doc_uuid("resource", digest, "trp-catalog")
    imports: list[dict[str, Any]] = [{"href": f"#{trp_resource}", "include-all": {}}]
    resources: list[dict[str, Any]] = [
        {
            "uuid": trp_resource,
            "title": f"TRP catalog of {title}",
            "rlinks": [{"href": names["catalog"], "media-type": CATALOG_MEDIA_TYPE}],
        }
    ]
    imports_out, resources_out = outside_imports(x, digest) if x is not None else ([], [])
    profile_doc = {
        "uuid": doc_uuid("profile", digest),
        "metadata": metadata(profile, title, lm, props),
        "imports": imports + imports_out,
        "merge": {"as-is": True},
        "back-matter": {"resources": resources + resources_out},
    }
    out = {names["catalog"]: {"catalog": catalog}, names["profile"]: {"profile": profile_doc}}
    if x is not None and x["mappings"]:
        out[names["mapping"]] = {"mapping-collection": mapping_collection(profile, x, clauses, digest, lm, title)}
    return out


def mapped_catalogs(x: Mapping[str, Any]) -> dict[str, list[str]]:
    """Catalog name to its mapped control identifiers, catalogs in x_oscal.catalogs order, controls sorted."""
    out: dict[str, set[str]] = {}
    for m in x["mappings"]:
        out.setdefault(m["catalog"], set()).add(m["control"])
    return {name: sorted(out[name]) for name in x["catalogs"] if name in out}


def outside_imports(x: Mapping[str, Any], digest: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    imports, resources = [], []
    for name, ids in mapped_catalogs(x).items():
        entry = x["catalogs"][name]
        rid = doc_uuid("resource", digest, "catalog", name)
        resources.append(
            {
                "uuid": rid,
                "title": entry.get("title", name),
                "props": [to_prop("catalog", name)],
                "rlinks": [{"href": entry["href"], "media-type": CATALOG_MEDIA_TYPE}],
            }
        )
        imports.append({"href": f"#{rid}", "include-controls": [{"with-ids": ids}]})
    return imports, resources


def mapping_collection(
    profile: Mapping[str, Any],
    x: Mapping[str, Any],
    clauses: Mapping[str, str],
    digest: str,
    lm: str,
    title: str,
) -> dict[str, Any]:
    trp_id, version = profile["trp_id"], profile["version"]
    names = file_names(trp_id)
    prov = x["provenance"]
    catalogs = mapped_catalogs(x)
    titles = [x["catalogs"][n].get("title", n) for n in catalogs]
    mappings = []
    for name in catalogs:
        maps = []
        for m in x["mappings"]:
            if m["catalog"] != name:
                continue
            entry: dict[str, Any] = {
                "uuid": doc_uuid("map", digest, m["clause"], name, m["control"]),
                "relationship": m["relationship"],
                "sources": [{"type": "control", "id-ref": clauses[m["clause"]]}],
                "targets": [{"type": "control", "id-ref": m["control"]}],
            }
            if m.get("remarks"):
                entry["remarks"] = m["remarks"]
            maps.append(entry)
        mappings.append(
            {
                "uuid": doc_uuid("mapping", digest, name),
                "source-resource": {"type": "catalog", "href": names["catalog"]},
                "target-resource": {"type": "catalog", "href": x["catalogs"][name]["href"]},
                "maps": maps,
            }
        )
    description = (
        f"How the scored signals and hard rules of TRP profile {trp_id} version {version} relate to controls of "
        + " and ".join(titles)
        + ". The profile author declares each relationship in the x_oscal member of the TRP profile."
    )
    return {
        "uuid": doc_uuid("mapping-collection", digest),
        "metadata": metadata(
            {"version": version},
            f"Control mappings of {title}",
            lm,
            [to_prop(k, profile[k]) for k in ("trp_id", "version", "authority")],
        ),
        "provenance": {
            "method": prov["method"],
            "matching-rationale": prov["matching_rationale"],
            "status": prov["status"],
            "mapping-description": description,
        },
        "mappings": mappings,
    }


# ---------------------------------------------------------------- import of documents this tool wrote


def is_trp(meta: object) -> bool:
    return isinstance(meta, dict) and any(
        isinstance(p, dict) and p.get("ns") == TRP_NS and p.get("name") == "trp_id" for p in meta.get("props", [])
    )


def read_number(text: object, where: str) -> int | float:
    try:
        value = json.loads(text) if isinstance(text, str) else None
    except json.JSONDecodeError:
        value = None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OscalError(f"{where} is not a JSON number")
    return value


def control_members(
    control: Mapping[str, Any], kind: str, set_params: Mapping[str, int | float], used: set[str]
) -> dict[str, Any]:
    """The TRP signal or rule one control of a TRP catalog carries. set_params replaces thresholds by parameter id, and
    every parameter id it applies goes into used."""
    cid = control.get("id")
    where = f"control {cid}"
    members = from_props(control.get("props", []), where)
    key = "signal" if kind == SIGNALS_GROUP else "rule"
    if not isinstance(members.get(key), str):
        raise OscalError(f"{where} carries no TRP {key} prop")
    if control_id("signal" if kind == SIGNALS_GROUP else "rule", members[key]) != cid:
        raise OscalError(f"{where} does not match the {key} its props name")
    params = control.get("params", [])
    if kind == RULES_GROUP:
        if params:
            raise OscalError(f"{where} is a hard rule and carries parameters")
        return ordered(members, (), RULE_ORDER)
    found = {}
    for p in params:
        pid = p.get("id") if isinstance(p, dict) else None
        member = next((t for t in THRESHOLDS if pid == param_id(str(cid), t)), None)
        if member is None or not isinstance(pid, str):
            raise OscalError(f"{where} carries parameter {pid}, which is no TRP threshold")
        values = p.get("values")
        if not isinstance(values, list) or len(values) != 1:
            raise OscalError(f"parameter {pid} carries no single value")
        found[member] = read_number(values[0], f"parameter {pid}")
        if pid in set_params:
            found[member] = set_params[pid]
            used.add(pid)
    for t in THRESHOLDS:
        if t not in found:
            raise OscalError(f"{where} has no parameter for {t}")
        if t in members:
            raise OscalError(f"{where} carries {t} as a prop as well as a parameter")
    members.update(found)
    return ordered(members, THRESHOLDS, SIGNAL_ORDER)


def profile_from_catalog(
    catalog: Mapping[str, Any],
    keep: set[str] | None = None,
    set_params: Mapping[str, int | float] | None = None,
) -> dict[str, Any]:
    """The TRP profile a TRP-native catalog carries. keep limits the controls, and set_params replaces thresholds."""
    members = from_props(catalog["metadata"].get("props", []), "catalog metadata")
    for m in ("scored_signals", "hard_rules"):
        if m in members:
            raise OscalError(f"catalog metadata carries {m}, which belongs in controls")
    params = dict(set_params or {})
    used: set[str] = set()
    for g in catalog.get("groups", []):
        gid = g.get("id") if isinstance(g, dict) else None
        if gid not in (SIGNALS_GROUP, RULES_GROUP):
            raise OscalError(f"the TRP catalog has a group {gid!r}, and only signals and rules are defined")
        if g.get("groups"):
            raise OscalError(f"group {gid} carries nested groups")
        items = []
        for c in g.get("controls", []):
            if c.get("controls"):
                raise OscalError(f"control {c.get('id')} carries child controls")
            if keep is not None and c.get("id") not in keep:
                continue
            items.append(control_members(c, gid, params, used))
        members["scored_signals" if gid == SIGNALS_GROUP else "hard_rules"] = items
    if catalog.get("controls"):
        raise OscalError("the TRP catalog carries controls outside its two groups")
    unused = set(params) - used
    if unused:
        raise OscalError(f"set-parameters names {', '.join(sorted(unused))}, which no imported control carries")
    return ordered(members, ("scored_signals", "hard_rules"), TOP_ORDER)


def selected_ids(selection: Sequence[Any], index: Mapping[str, Mapping[str, Any]], where: str) -> set[str]:
    """Control identifiers a list of select-control-by-id entries picks out of a catalog."""
    out: set[str] = set()
    for s in selection:
        if not isinstance(s, dict):
            raise OscalError(f"{where}: a control selection is not an object")
        picked = set()
        for cid in s.get("with-ids", []):
            if cid not in index:
                raise OscalError(f"{where}: the catalog has no control {cid}")
            picked.add(cid)
        for m in s.get("matching", []):
            pattern = m.get("pattern") if isinstance(m, dict) else None
            if not isinstance(pattern, str):
                raise OscalError(f"{where}: a matching entry has no pattern")
            picked.update(cid for cid in index if fnmatch.fnmatchcase(cid, pattern))
        if s.get("with-child-controls") == "yes":
            for cid in list(picked):
                picked.update(c["id"] for c in walk_controls(index[cid]))
        out |= picked
    return out


def import_target(href: str, doc: Mapping[str, Any]) -> str:
    """The location an import href names. A bare fragment names a back-matter resource, and the resource's JSON rlink
    is the location."""
    if not href.startswith("#"):
        return href
    resources = (doc.get("back-matter") or {}).get("resources", [])
    resource = next((r for r in resources if isinstance(r, dict) and r.get("uuid") == href[1:]), None)
    if resource is None:
        raise OscalError(f"import {href} names no back-matter resource")
    links = [r for r in resource.get("rlinks", []) if isinstance(r, dict) and isinstance(r.get("href"), str)]
    link = next((r for r in links if r.get("media-type") == CATALOG_MEDIA_TYPE), None)
    link = link or next((r for r in links if r["href"].endswith(".json")), None)
    if link is None:
        raise OscalError(f"back-matter resource {href[1:]} has no JSON link")
    target: str = link["href"]
    return target


def resolve_href(href: str, doc: Mapping[str, Any], base: Path, resolve: Mapping[str, Path]) -> tuple[Path, str]:
    """A local path for an import href, and the location the href names. An entry in resolve, keyed by the href or by
    the location, comes first. A relative location is read next to the document. An absolute URI needs an entry in
    resolve, since the tool never fetches anything."""
    target = import_target(href, doc)
    for key in (href, target):
        if key in resolve:
            return resolve[key], target
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
        raise OscalError(f"import {href} points to {target}. Pass --resolve '{href}=PATH' with a local copy")
    path = (base / target).resolve()
    if not path.is_file():
        raise OscalError(f"import {href} points to {path}, which does not exist. Pass --resolve '{href}=PATH'")
    return path, target


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise OscalError(f"{path} is not JSON ({err.msg})") from None
    except OSError as err:
        raise OscalError(f"cannot read {path} ({err.strerror})") from None


def profile_from_oscal_profile(prof: Mapping[str, Any], base: Path, resolve: Mapping[str, Path]) -> dict[str, Any]:
    """The TRP profile a TRP-native OSCAL profile and its TRP catalog carry, with the profile's tailoring applied."""
    top = from_props(prof["metadata"].get("props", []), "profile metadata")
    modify = prof.get("modify") or {}
    if set(modify) - {"set-parameters"}:
        raise OscalError("the profile alters controls, and only set-parameters can change a TRP requirement")
    set_params: dict[str, int | float] = {}
    for sp in modify.get("set-parameters", []):
        pid, values = sp.get("param-id"), sp.get("values")
        if set(sp) - {"param-id", "values"} or not isinstance(values, list) or len(values) != 1:
            raise OscalError(f"set-parameters for {pid} must carry one value and nothing else")
        set_params[str(pid)] = read_number(values[0], f"set-parameters value for {pid}")
    trp_imports: list[tuple[dict[str, Any], dict[str, Any]]] = []
    outside: list[dict[str, Any]] = []
    reasons: list[str] = []
    for imp in prof.get("imports", []):
        if not isinstance(imp, dict) or not isinstance(imp.get("href"), str):
            raise OscalError("an import has no href")
        try:
            doc = read_json(resolve_href(imp["href"], prof, base, resolve)[0])
        except OscalError as err:
            reasons.append(str(err))
            outside.append(imp)
            continue
        if isinstance(doc, dict) and isinstance(doc.get("catalog"), dict) and is_trp(doc["catalog"].get("metadata")):
            trp_imports.append((imp, doc["catalog"]))
        else:
            outside.append(imp)
    if len(trp_imports) != 1:
        found = "no TRP catalog" if not trp_imports else "more than one TRP catalog"
        raise OscalError(f"the profile imports {found}" + (f" ({'; '.join(reasons)})" if reasons else ""))
    imp, catalog = trp_imports[0]
    if from_props(catalog["metadata"].get("props", []), "catalog metadata") != top:
        raise OscalError("the TRP props of the profile and of its TRP catalog differ")
    index = {c["id"]: {"id": c["id"]} for c in walk_controls(catalog)}
    where = "the TRP catalog import"
    keep = set(index) if "include-all" in imp else selected_ids(imp.get("include-controls", []), index, where)
    keep -= selected_ids(imp.get("exclude-controls", []), index, where)
    result = profile_from_catalog(catalog, keep, set_params)
    x = read_x_oscal(result, clause_controls(result)) if X_OSCAL in result else None
    expected = outside_imports(x, "")[0] if x is not None else []
    if [i.get("include-controls") for i in expected] != [i.get("include-controls") for i in outside] or any(
        set(i) - {"href", "include-controls"} for i in outside
    ):
        raise OscalError("the profile imports outside controls other than those its x_oscal member maps")
    return result


# ---------------------------------------------------------------- import of other catalogs and profiles


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower())
    return s.strip("-") or "imported"


def prose_of(control: Mapping[str, Any]) -> str | None:
    """The prose of a control's first overview or statement part, when that part carries prose itself."""
    for part in control.get("parts", []):
        if not isinstance(part, dict) or part.get("name") not in ("overview", "statement"):
            continue
        if isinstance(part.get("prose"), str):
            text: str = part["prose"]
            return text
    return None


def placeholder(control: Mapping[str, Any], catalog_title: str) -> dict[str, Any]:
    """A scored signal named after a control, with the control's title and prose as its reason and nothing else."""
    title = control.get("title")
    reason = f"Control {control['id']} of {catalog_title}" + (f", {title}." if isinstance(title, str) else ".")
    text = prose_of(control)
    return {"signal": control["id"], "reason": f"{reason} {text}" if text else reason}


def skeleton(
    title: str,
    sources: Sequence[tuple[str, Mapping[str, Any], str, list[dict[str, Any]]]],
    authority: str,
    trp_id: str | None,
    version: str,
) -> dict[str, Any]:
    """A TRP skeleton. sources gives (catalog name, catalog metadata, href, selected controls) for each catalog."""
    signals, mappings, catalogs = [], [], {}
    seen: set[str] = set()
    for name, meta, href, controls in sources:
        entry: dict[str, Any] = {"href": href}
        if is_line(meta.get("title")):
            entry["title"] = meta["title"]
        catalogs[name] = entry
        for c in controls:
            if c["id"] in seen:
                raise OscalError(f"two imported catalogs both have a control {c['id']}")
            seen.add(c["id"])
            signals.append(placeholder(c, str(entry.get("title", name))))
            mappings.append({"clause": f"signal:{c['id']}", "catalog": name, "control": c["id"]})
    origin = " and ".join(f"{meta.get('title') or name} version {meta.get('version')}" for name, meta, _, _ in sources)
    return {
        "$schema": TRP_SCHEMA_URI,
        "trp_id": trp_id or slug(title),
        "spec_version": TRP_SPEC_VERSION,
        "version": version,
        "name": title,
        "description": (
            f"Skeleton read from {origin}. Each scored signal is a placeholder for one control. A person sets the "
            "scope and the standing bands and completes every placeholder before the profile validates. Each mapping "
            "in x_oscal also needs a relationship before the profile exports."
        ),
        "authority": authority,
        "scored_signals": signals,
        X_OSCAL: {"catalogs": catalogs, "mappings": mappings},
    }


def selectable(index: Mapping[str, Mapping[str, Any]], ids: set[str] | None, where: str) -> list[dict[str, Any]]:
    """Controls in catalog order. Given ids, exactly those controls, where a withdrawn or unknown one is an error."""
    if ids is None:
        return [dict(c) for c in index.values() if not is_withdrawn(c)]
    for cid in sorted(ids):
        if cid not in index:
            raise OscalError(f"{where} has no control {cid}")
        if is_withdrawn(index[cid]):
            raise OscalError(f"control {cid} of {where} is withdrawn")
    return [dict(c) for cid, c in index.items() if cid in ids]


def import_document(
    doc: Mapping[str, Any],
    base: Path,
    resolve: Mapping[str, Path] | None = None,
    authority: str | None = None,
    trp_id: str | None = None,
    version: str = "0.1.0",
    controls: Sequence[str] | None = None,
    catalog_name: str | None = None,
    href: str | None = None,
) -> dict[str, Any]:
    """A TRP profile from an OSCAL catalog or profile. Documents this tool wrote come back whole, and any other
    document becomes a skeleton with placeholder signals."""
    resolve = resolve or {}
    if not isinstance(doc, Mapping) or len(doc) - ("$schema" in doc) != 1:
        raise OscalError("the document is not one OSCAL catalog or profile")
    if "catalog" in doc and isinstance(doc["catalog"], dict):
        catalog = doc["catalog"]
        if is_trp(catalog.get("metadata")):
            if controls:
                raise OscalError("--controls applies to a catalog this tool did not write")
            return profile_from_catalog(catalog)
        meta = catalog.get("metadata") or {}
        index = catalog_index(doc, "the catalog")
        name = catalog_name or slug(str(meta.get("title", "catalog")))
        chosen = selectable(index, set(controls) if controls else None, "the catalog")
        sources = [(name, meta, href or "catalog.json", chosen)]
        return skeleton(str(meta.get("title", name)), sources, need(authority), trp_id, version)
    if "profile" in doc and isinstance(doc["profile"], dict):
        prof = doc["profile"]
        if controls:
            raise OscalError("--controls applies to a catalog. An OSCAL profile selects its own controls")
        if is_trp(prof.get("metadata")):
            return profile_from_oscal_profile(prof, base, resolve)
        sources = []
        for i, imp in enumerate(prof.get("imports", [])):
            path, target = resolve_href(imp["href"], prof, base, resolve)
            cat_doc = read_json(path)
            where = f"import {imp['href']}"
            index = catalog_index(cat_doc, where)
            if "include-all" in imp:
                ids = {cid for cid, c in index.items() if not is_withdrawn(c)}
            else:
                ids = selected_ids(imp.get("include-controls", []), index, where)
            ids -= selected_ids(imp.get("exclude-controls", []), index, where)
            meta = cat_doc["catalog"].get("metadata") or {}
            name = slug(str(meta.get("title", f"catalog-{i + 1}")))
            if i == 0 and catalog_name:
                name = catalog_name
            sources.append((name, meta, target, selectable(index, ids, where)))
        title = str((prof.get("metadata") or {}).get("title", "profile"))
        return skeleton(title, sources, need(authority), trp_id, version)
    raise OscalError("the document is not one OSCAL catalog or profile. A mapping collection does not import")


def need(authority: str | None) -> str:
    if not authority:
        raise OscalError("a skeleton needs --authority, the party responsible for the new profile")
    return authority


# ---------------------------------------------------------------- validation against the official OSCAL schemas


@functools.cache
def category_class(prefix: str) -> str:
    """The code points of one Unicode general category, as the inside of a Python character class."""
    ranges, start = [], None
    for cp in range(sys.maxunicode + 2):
        inside = cp <= sys.maxunicode and unicodedata.category(chr(cp)).startswith(prefix)
        if inside and start is None:
            start = cp
        elif not inside and start is not None:
            ranges.append((start, cp - 1))
            start = None
    return "".join(re.escape(chr(a)) if a == b else f"{re.escape(chr(a))}-{re.escape(chr(b))}" for a, b in ranges)


def python_pattern(pattern: str) -> str:
    """A JSON Schema pattern with \\p{L} and \\p{N} spelled out, since Python's re has no Unicode property escapes."""
    out, i, in_class = [], 0, False
    while i < len(pattern):
        if pattern.startswith("\\p{", i):
            end = pattern.index("}", i)
            body = category_class(pattern[i + 3 : end])
            out.append(body if in_class else f"[{body}]")
            i = end + 1
            continue
        c = pattern[i]
        if c == "\\":
            out.append(pattern[i : i + 2])
            i += 2
            continue
        if c == "[" and not in_class:
            in_class = True
        elif c == "]" and in_class:
            in_class = False
        out.append(c)
        i += 1
    return "".join(out)


SCHEMA_FILES = {
    "catalog": "oscal_catalog_schema.json",
    "profile": "oscal_profile_schema.json",
    "mapping-collection": "oscal_mapping_schema.json",
}


@functools.cache
def oscal_validator(kind: str, schema_dir: str = str(OSCAL_SCHEMAS)) -> Any:
    """A Draft 7 validator for one OSCAL model whose pattern keyword runs Python's re on translated patterns."""
    import jsonschema
    from jsonschema import validators

    compiled: dict[str, re.Pattern[str]] = {}

    def pattern(validator: Any, patrn: str, instance: Any, schema: Any) -> Iterator[Any]:
        if not validator.is_type(instance, "string"):
            return
        regex = compiled.get(patrn)
        if regex is None:
            regex = compiled[patrn] = re.compile(python_pattern(patrn))
        if not regex.search(instance):
            yield jsonschema.ValidationError(f"{instance!r} does not match {patrn!r}")

    schema = json.loads((Path(schema_dir) / SCHEMA_FILES[kind]).read_text(encoding="utf-8"))
    cls = validators.extend(jsonschema.Draft7Validator, {"pattern": pattern})
    return cls(schema)


def oscal_errors(doc: Any, schema_dir: Path = OSCAL_SCHEMAS) -> list[str]:
    """Error messages from the official OSCAL schema for the model the document's root names."""
    kinds = [k for k in SCHEMA_FILES if isinstance(doc, dict) and k in doc]
    if len(kinds) != 1:
        return ["(root): the document's root names no OSCAL model this tool validates"]
    validator = oscal_validator(kinds[0], str(schema_dir))
    return [
        f"{'/'.join(str(p) for p in e.absolute_path) or '(root)'}: {e.message}"
        for e in sorted(validator.iter_errors(doc), key=lambda e: list(map(str, e.absolute_path)))
    ]


# ---------------------------------------------------------------- command line


def pairs(items: Sequence[str] | None, flag: str) -> dict[str, Path]:
    out = {}
    for item in items or []:
        key, sep, path = item.rpartition("=")
        if not sep or not key or not path:
            raise OscalError(f"{flag} takes KEY=PATH, and {item!r} is not")
        out[key] = Path(path)
    return out


def write_json(doc: Any) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export a TRP profile as OSCAL, or import OSCAL into a TRP profile.")
    sub = ap.add_subparsers(dest="command", required=True)
    ex = sub.add_parser("export", help="write the OSCAL documents for a TRP profile")
    ex.add_argument("profile")
    ex.add_argument("--out-dir", required=True)
    ex.add_argument("--last-modified", help="OSCAL last-modified time, default the profile's created_at")
    ex.add_argument("--catalog", action="append", help="NAME=PATH, a local copy of a catalog x_oscal declares")
    ex.add_argument("--allow-unchecked", action="store_true", help="export mappings to catalogs with no local copy")
    im = sub.add_parser("import", help="read an OSCAL catalog or profile into a TRP profile or skeleton")
    im.add_argument("document")
    im.add_argument("--resolve", action="append", help="HREF=PATH, a local copy of the document an import names")
    im.add_argument("--authority", help="the party responsible for a skeleton")
    im.add_argument("--trp-id", help="trp_id of a skeleton, default from the OSCAL title")
    im.add_argument("--version", default="0.1.0", help="version of a skeleton, default 0.1.0")
    im.add_argument("--controls", help="comma-separated control identifiers to take from a catalog, default all")
    im.add_argument("--catalog-name", help="name of the catalog in the skeleton's x_oscal, default from its title")
    im.add_argument("--href", help="where the catalog is published, for the skeleton's x_oscal")
    va = sub.add_parser("validate", help="check OSCAL documents against the official OSCAL 1.2.3 JSON schemas")
    va.add_argument("documents", nargs="+")
    va.add_argument("--schemas", default=str(OSCAL_SCHEMAS))
    args = ap.parse_args(argv)
    try:
        if args.command == "export":
            local = {k: read_json(p) for k, p in pairs(args.catalog, "--catalog").items()}
            docs = export(read_json(Path(args.profile)), args.last_modified, local, args.allow_unchecked)
            out = Path(args.out_dir)
            out.mkdir(parents=True, exist_ok=True)
            for name, doc in docs.items():
                (out / name).write_text(write_json(doc), encoding="utf-8")
                print(out / name)
            return 0
        if args.command == "import":
            path = Path(args.document)
            controls = [c for c in args.controls.split(",") if c] if args.controls else None
            result = import_document(
                read_json(path),
                path.parent,
                pairs(args.resolve, "--resolve"),
                args.authority,
                args.trp_id,
                args.version,
                controls,
                args.catalog_name,
                args.href,
            )
            sys.stdout.write(write_json(result))
            errors = validate_trp(result)
            if errors:
                print(f"trp_oscal: the result does not validate yet ({len(errors)} schema errors)", file=sys.stderr)
            return 0
        failed = 0
        for name in args.documents:
            errors = oscal_errors(read_json(Path(name)), Path(args.schemas))
            print(f"{name}: " + ("valid" if not errors else f"{len(errors)} errors"))
            for e in errors[:20]:
                print(f"  {e}")
            failed += bool(errors)
        return 1 if failed else 0
    except OscalError as err:
        print(f"trp_oscal: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
