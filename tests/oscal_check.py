#!/usr/bin/env python3
"""Checks the OSCAL export and import of TRP profiles in tools/trp_oscal.py.

OSCAL is the Open Security Controls Assessment Language of the National Institute of Standards and Technology (NIST).
Every document the export writes must validate against the official OSCAL 1.2.3 JSON schemas in
fixtures/oscal/schemas. Every TRP profile in the repository must come back whole from its OSCAL profile and from its
OSCAL catalog. NIST's own SP 800-53 Rev. 5 and AI RMF catalogs and the SP 800-53 LOW baseline profile, vendored from
oscal-content 1.6.0, must import as skeletons whose placeholders carry no threshold. No check uses the network.

    pip install jsonschema && python tests/oscal_check.py
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import evaluate as trp  # noqa: E402  the Python reference evaluator, tools/evaluate.py
import trp_oscal as oscal  # noqa: E402

FIX = ROOT / "fixtures" / "oscal"
CONTENT = FIX / "content"
SP800_53 = CONTENT / "NIST_SP-800-53_rev5_catalog-min.json"
AI_RMF = CONTENT / "NIST_AI-RMF_v1_catalog-min.json"
LOW = CONTENT / "NIST_SP-800-53_rev5_LOW-baseline_profile-min.json"
MAPPED = FIX / "profiles" / "oscal-mapping-test.trp.json"
GOLDEN = FIX / "golden"
LOCAL = {"sp800-53r5": SP800_53, "ai-rmf-1.0": AI_RMF}
WHEN = "2026-11-04T00:00:00Z"
TOOL = [sys.executable, str(ROOT / "tools" / "trp_oscal.py")]

passed = 0
failed: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failed.append(name)
        print(f"FAIL  {name}  {str(detail)[:600]}")


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def git_blob(path: Path) -> str:
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def fails(fn: Callable[..., Any], *args: Any, needle: str = "", **kwargs: Any) -> bool:
    """True when fn raises OscalError, and its message contains needle."""
    try:
        fn(*args, **kwargs)
    except oscal.OscalError as err:
        return needle in str(err)
    return False


def profiles() -> list[Path]:
    """Every valid TRP profile in the repository."""
    return sorted(
        [
            *ROOT.glob("examples/*/trp.json"),
            *ROOT.glob("tests/profiles/valid/*.json"),
            *ROOT.glob("adapters/*/profiles/*.json"),
            *FIX.glob("profiles/*.json"),
        ]
    )


def catalogs() -> dict[str, Any]:
    return {name: load(path) for name, path in LOCAL.items()}


def write_all(docs: dict[str, Any], out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name, doc in docs.items():
        (out / name).write_text(oscal.write_json(doc), encoding="utf-8")


# ---------------------------------------------------------------- fixtures


def fixture_checks() -> None:
    sources = load(FIX / "sources.json")
    for group in ("oscal", "oscal_content"):
        for name, entry in sources[group]["files"].items():
            path = FIX / name
            check(
                f"{name} has the SHA-256 sources.json records",
                hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"],
            )
            check(f"{name} has the size sources.json records", path.stat().st_size == entry["bytes"])
            if "git_blob" in entry:
                check(
                    f"{name} is the upstream Git object {entry['git_blob'][:12]}", git_blob(path) == entry["git_blob"]
                )
    check(
        "the tool writes OSCAL 1.2.3, the release sources.json records",
        oscal.OSCAL_VERSION == "1.2.3" and sources["oscal"]["release"] == "v1.2.3",
    )
    for kind, name in oscal.SCHEMA_FILES.items():
        schema = load(oscal.OSCAL_SCHEMAS / name)
        check(f"the {kind} schema is the 1.2.3 release", "/1.2.3/" in schema["$id"], schema["$id"])
        check(
            f"the {kind} schema is JSON Schema draft 07", schema["$schema"] == "http://json-schema.org/draft-07/schema#"
        )
        date_time = schema["definitions"]["DateTimeWithTimezoneDatatype"]["pattern"]
        check(f"the tool's date and time pattern is the {kind} schema's", oscal.OSCAL_DATE_TIME.pattern == date_time)
    for name in ("profiles/oscal-mapping-test.trp.json",):
        digest = hashlib.sha256((FIX / name).read_bytes()).hexdigest()
        check(f"{name} has the SHA-256 sources.json records", digest == sources["built"][name]["sha256"], digest)
    counts = sources["oscal_content"]["files"]
    for path in (SP800_53, AI_RMF):
        entry = counts[f"content/{path.name}"]
        index = oscal.catalog_index(load(path), path.name)
        check(f"{path.name} has {entry['controls']} controls", len(index) == entry["controls"], len(index))
        withdrawn = sum(oscal.is_withdrawn(c) for c in index.values())
        check(f"{path.name} has {entry['withdrawn']} withdrawn controls", withdrawn == entry["withdrawn"], withdrawn)


# ---------------------------------------------------------------- OSCAL datatypes and schema validation


def datatype_checks() -> None:
    letters = "".join(chr(c) for c in (0x00E9, 0x4E2D, 0x0416))  # letters from three scripts
    digits = "".join(chr(c) for c in (0x0663, 0x0967))  # Arabic-Indic and Devanagari digits
    tokens = ["ac-2", "MEASURE_2.4", "_x", "signal.a-b_c.d", letters, f"a{digits}"]
    not_tokens = ["", "2ac", "-a", ".a", "a b", "a:b", "a/b", f"{digits}a", "a" + chr(0x2028)]
    pattern = load(oscal.OSCAL_SCHEMAS / "oscal_catalog_schema.json")["definitions"]["TokenDatatype"]["pattern"]
    regex = re.compile(oscal.python_pattern(pattern))
    for t in tokens:
        check(f"{t!r} is a token", oscal.is_token(t) and regex.search(t) is not None)
    for t in not_tokens:
        check(f"{t!r} is not a token", not oscal.is_token(t) and regex.search(t) is None)
    check(
        "a translated pattern keeps a Unicode class inside brackets", oscal.python_pattern("[\\p{N}x]").startswith("[")
    )
    for s, ok in (
        ("ratio", True),
        ("two words", True),
        (" lead", False),
        ("trail ", False),
        ("a\nb", False),
        ("a\rb", False),
        ("a" + chr(0x2028) + "b", False),
        ("x" + chr(0x00A0), False),
        ("", False),
    ):
        check(f"{s!r} is {'' if ok else 'not '}a prop value that travels as it is", oscal.is_plain(s) is ok)
    for value in (30, 0.7, -1, 1e-07, True, None, ["a", 1], {"k": "v"}, "a\nb", " padded ", "30"):
        back = oscal.from_props([oscal.to_prop("x_member", value)], "test")["x_member"]
        check(f"the prop for {value!r} reads back with its type", back == value and type(back) is type(value), back)
    uri = "https://example.org/trp/ext/k"
    check(
        "a URI extension key travels in an extension prop",
        oscal.to_prop(uri, 1)["name"] == "extension" and oscal.from_props([oscal.to_prop(uri, 1)], "t") == {uri: 1},
    )
    check("$schema travels as json_schema", oscal.to_prop("$schema", "https://x.example/s")["name"] == "json_schema")
    bad = [{"name": "weight", "ns": oscal.TRP_NS, "value": "{", "class": "json"}]
    check("a json prop whose value is not JSON is refused", fails(oscal.from_props, bad, "t", needle="not JSON"))
    twice = [oscal.to_prop("trp_id", "a"), oscal.to_prop("trp_id", "b")]
    check("a member in two props is refused", fails(oscal.from_props, twice, "t", needle="two props"))
    odd = [{"name": "x", "ns": oscal.TRP_NS, "value": "1", "class": "number"}]
    check("a TRP prop with an undefined class is refused", fails(oscal.from_props, odd, "t", needle="only json"))
    other = [{"name": "keywords", "value": "x"}, {"name": "x", "ns": "https://other.example", "value": "y"}]
    check("props outside the TRP namespace are skipped", oscal.from_props(other, "t") == {})
    check(
        "a long signal name becomes a digest identifier", oscal.control_id("signal", "a b").startswith("signal.sha256-")
    )

    for path in (SP800_53, AI_RMF):
        errors = oscal.oscal_errors(load(path))
        check(f"NIST {path.name} validates against the OSCAL 1.2.3 catalog schema", not errors, errors[:3])
    errors = oscal.oscal_errors(load(LOW))
    check("NIST's SP 800-53 LOW baseline validates against the OSCAL 1.2.3 profile schema", not errors, errors[:3])
    broken = copy.deepcopy(load(GOLDEN / "oscal-mapping-test.oscal-catalog.json"))
    broken["catalog"]["groups"][0]["controls"][0]["id"] = "1bad"
    broken["catalog"]["uuid"] = "not-a-uuid"
    errors = oscal.oscal_errors(broken)
    check("the validator reports a control id that is not a token and a bad UUID", len(errors) == 2, errors)
    check("the validator refuses a document that is no OSCAL model", oscal.oscal_errors({"x": {}}) != [])


# ---------------------------------------------------------------- export


def export_checks(tmp: Path) -> None:
    profile = load(MAPPED)
    docs = oscal.export(profile, local_catalogs=catalogs())
    names = oscal.file_names(profile["trp_id"])
    check("the export writes the three OSCAL documents", sorted(docs) == sorted(names.values()))
    for name, doc in docs.items():
        golden = (GOLDEN / name).read_text(encoding="utf-8")
        check(f"{name} matches its golden file byte for byte", oscal.write_json(doc) == golden)
        errors = oscal.oscal_errors(doc)
        check(f"{name} validates against the official OSCAL 1.2.3 schema", not errors, errors[:3])
    again = oscal.export(copy.deepcopy(profile), local_catalogs=catalogs())
    check("the export is deterministic", json.dumps(again) == json.dumps(docs))

    catalog = docs[names["catalog"]]["catalog"]
    prof = docs[names["profile"]]["profile"]
    mapping = docs[names["mapping"]]["mapping-collection"]
    controls = {c["id"]: c for c in oscal.walk_controls(catalog)}
    check(
        "the TRP catalog has one control per scored signal and hard rule",
        len(controls) == len(profile["scored_signals"]) + len(profile["hard_rules"]),
    )
    check(
        "every scored signal carries its thresholds as OSCAL parameters",
        all(
            [p["values"] for p in controls[f"signal.{s['signal']}"]["params"]]
            == [[json.dumps(s["warning_threshold"])], [json.dumps(s["critical_threshold"])]]
            for s in profile["scored_signals"]
        ),
    )
    statement = controls["signal.decision_log_completeness"]["parts"][0]["prose"]
    check(
        "the statement inserts the threshold parameters",
        "{{ insert: param, signal.decision_log_completeness_warning_threshold }}" in statement,
    )
    check(
        "every OSCAL UUID is a version 5 UUID",
        all(u[14] == "5" for u in (catalog["uuid"], prof["uuid"], mapping["uuid"])),
    )
    trp_resource = prof["back-matter"]["resources"][0]
    check(
        "the profile imports every control of the TRP catalog first",
        prof["imports"][0] == {"href": "#" + trp_resource["uuid"], "include-all": {}}
        and trp_resource["rlinks"][0]["href"] == names["catalog"],
    )
    mapped: dict[str, set[str]] = {}
    for m in profile["x_oscal"]["mappings"]:
        mapped.setdefault(m["catalog"], set()).add(m["control"])
    for imp, res in zip(prof["imports"][1:], prof["back-matter"]["resources"][1:], strict=True):
        name = res["props"][0]["value"]
        check(
            f"the profile imports exactly the mapped controls of {name}",
            imp["href"] == "#" + res["uuid"]
            and imp["include-controls"] == [{"with-ids": sorted(mapped[name])}]
            and res["rlinks"][0]["href"] == profile["x_oscal"]["catalogs"][name]["href"],
        )
    index = {name: oscal.catalog_index(doc, name) for name, doc in catalogs().items()}
    by_href = {e["href"]: n for n, e in profile["x_oscal"]["catalogs"].items()}
    maps = [(mp, m) for mp in mapping["mappings"] for m in mp["maps"]]
    check("the mapping collection has one map per declared mapping", len(maps) == len(profile["x_oscal"]["mappings"]))
    for mp, m in maps:
        target = m["targets"][0]["id-ref"]
        name = by_href[mp["target-resource"]["href"]]
        check(
            f"map to {target} names a live control of {name} and a control of the TRP catalog",
            target in index[name]
            and not oscal.is_withdrawn(index[name][target])
            and m["sources"][0]["id-ref"] in controls
            and mp["source-resource"]["href"] == names["catalog"],
        )
        check(f"map to {target} uses an OSCAL relationship", m["relationship"] in oscal.RELATIONSHIPS)
    p = mapping["provenance"]
    check(
        "the provenance uses OSCAL's allowed values",
        p["method"] in oscal.METHODS and p["matching-rationale"] in oscal.RATIONALES and p["status"] in oscal.STATUSES,
    )
    for docs_name in (names["catalog"], names["profile"]):
        meta = docs[docs_name][next(iter(docs[docs_name]))]["metadata"]
        check(
            f"{docs_name} carries every TRP prop under the TRP namespace",
            all(pr["ns"] == oscal.TRP_NS for pr in meta["props"]) and meta["oscal-version"] == "1.2.3",
        )

    def edited(**changes: Any) -> dict[str, Any]:
        out: dict[str, Any] = copy.deepcopy(profile)
        for path, value in changes.items():
            target: Any = out
            keys = path.split("__")
            for k in keys[:-1]:
                target = target[int(k)] if k.isdigit() else target[k]
            if value is ...:
                del target[keys[-1]]
            else:
                target[int(keys[-1]) if keys[-1].isdigit() else keys[-1]] = value
        return out

    cats = catalogs()
    for name, bad, needle in (
        ("an invalid TRP profile", edited(trp_id="Bad ID"), "not valid"),
        ("a mapping with no relationship", edited(x_oscal__mappings__0__relationship=...), "no relationship"),
        ("a relationship OSCAL does not define", edited(x_oscal__mappings__0__relationship="maps-to"), "relationship"),
        ("a mapping for a clause the profile lacks", edited(x_oscal__mappings__0__clause="rule:nope"), "clause"),
        ("a mapping to an undeclared catalog", edited(x_oscal__mappings__0__catalog="iso"), "x_oscal.catalogs"),
        ("a control the catalog lacks", edited(x_oscal__mappings__0__control="zz-99"), "has no control zz-99"),
        ("a withdrawn control", edited(x_oscal__mappings__0__control="ac-13"), "withdrawn"),
        ("mappings without provenance", edited(x_oscal__provenance=...), "provenance is required"),
        ("a provenance status OSCAL does not define", edited(x_oscal__provenance__status="final"), "status"),
        ("an x_oscal member this version does not define", edited(x_oscal__weights={}), "does not define"),
        ("a repeated mapping", edited(x_oscal__mappings__1=profile["x_oscal"]["mappings"][0]), "repeats"),
        ("a created_at outside OSCAL's date range", edited(created_at="1850-01-01T00:00:00Z"), "time zone"),
        ("a profile with no created_at", edited(created_at=...), "--last-modified"),
    ):
        check(f"the export refuses {name}", fails(oscal.export, bad, None, cats, needle=needle))
    check(
        "the export refuses a catalog with no local copy",
        fails(oscal.export, profile, None, {"sp800-53r5": cats["sp800-53r5"]}, needle="--allow-unchecked"),
    )
    unchecked = oscal.export(profile, None, {}, allow_unchecked=True)
    check("--allow-unchecked writes the same documents", json.dumps(unchecked) == json.dumps(docs))
    check(
        "the export refuses a local copy of a catalog the profile does not declare",
        fails(oscal.export, profile, None, {**cats, "iso": cats["sp800-53r5"]}, needle="does not declare"),
    )
    check("the export refuses a profile that is not an object", fails(oscal.export, [], needle="not a JSON object"))
    bare = load(ROOT / "tests/profiles/valid/minimal.json")
    check("--last-modified stands in for a missing created_at", bool(oscal.export(bare, WHEN)))
    check(
        "the export refuses a local catalog for a profile with no x_oscal",
        fails(oscal.export, bare, WHEN, cats, needle="no x_oscal"),
    )
    long_name = edited(scored_signals__0__signal="tool calls / denied ratio", x_oscal__mappings__3__clause=...)
    del long_name["x_oscal"]["mappings"][3]
    out = oscal.export(long_name, local_catalogs=cats)
    errors = [e for d in out.values() for e in oscal.oscal_errors(d)]
    check("a signal name that is no token still exports valid OSCAL", not errors, errors[:3])
    back = oscal.profile_from_catalog(out[names["catalog"]]["catalog"])
    check("and comes back under its own name", back == long_name)


# ---------------------------------------------------------------- round trip of every profile


def round_trip_checks(tmp: Path) -> None:
    count = 0
    for path in profiles():
        rel = path.relative_to(ROOT)
        profile = load(path)
        out = tmp / "rt" / path.stem / path.parent.name
        docs = oscal.export(profile, WHEN, allow_unchecked=True)
        write_all(docs, out)
        names = oscal.file_names(profile["trp_id"])
        errors = [e for d in docs.values() for e in oscal.oscal_errors(d)]
        check(f"{rel}: every export validates against the OSCAL 1.2.3 schemas", not errors, errors[:3])
        from_profile = oscal.import_document(load(out / names["profile"]), out)
        from_catalog = oscal.import_document(load(out / names["catalog"]), out)
        check(f"{rel}: the OSCAL profile brings back the same TRP profile", from_profile == profile)
        check(f"{rel}: the OSCAL catalog alone brings back the same TRP profile", from_catalog == profile)
        check(
            f"{rel}: the profile digest survives the round trip",
            trp.canonical_json(from_profile) == trp.canonical_json(profile),
        )
        check(
            f"{rel}: identity and every requirement survive",
            all(
                from_profile.get(k) == profile.get(k)
                for k in ("trp_id", "version", "authority", "scored_signals", "hard_rules")
            ),
        )
        count += 1
    check("the round trip covers every profile in the repository", count == len(profiles()) and count >= 14, count)


# ---------------------------------------------------------------- tailoring through an OSCAL profile


def tailoring_checks(tmp: Path) -> None:
    profile = load(MAPPED)
    out = tmp / "tailor"
    docs = oscal.export(profile, local_catalogs=catalogs())
    write_all(docs, out)
    names = oscal.file_names(profile["trp_id"])
    base = docs[names["profile"]]
    pid = "signal.tool_calls_denied_ratio_critical_threshold"

    def variant(change: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
        doc = copy.deepcopy(base)
        change(doc["profile"])
        return doc

    tailored = variant(lambda p: p.update({"modify": {"set-parameters": [{"param-id": pid, "values": ["0.3"]}]}}))
    check("a tailored OSCAL profile still validates", not oscal.oscal_errors(tailored))
    result = oscal.import_document(tailored, out)
    check(
        "set-parameters on a TRP threshold sets that threshold",
        result["scored_signals"][0]["critical_threshold"] == 0.3
        and {k: v for k, v in result.items() if k != "scored_signals"}
        == {k: v for k, v in profile.items() if k != "scored_signals"},
    )

    def exclude(p: dict[str, Any]) -> None:
        p["imports"][0] = {
            "href": p["imports"][0]["href"],
            "include-all": {},
            "exclude-controls": [{"with-ids": ["signal.open_review_items"]}],
        }

    result = oscal.import_document(variant(exclude), out)
    check(
        "exclude-controls drops an unmapped requirement",
        [s["signal"] for s in result["scored_signals"]] == ["tool_calls_denied_ratio", "decision_log_completeness"],
    )
    for name, change, needle in (
        (
            "an unknown parameter",
            lambda p: p.update(
                {"modify": {"set-parameters": [{"param-id": "signal.nope_warning_threshold", "values": ["1"]}]}}
            ),
            "no imported control",
        ),
        (
            "a parameter value that is no number",
            lambda p: p.update({"modify": {"set-parameters": [{"param-id": pid, "values": ["high"]}]}}),
            "not a JSON number",
        ),
        (
            "two values for one parameter",
            lambda p: p.update({"modify": {"set-parameters": [{"param-id": pid, "values": ["1", "2"]}]}}),
            "one value",
        ),
        ("alters", lambda p: p.update({"modify": {"alters": [{"control-id": "rule.checkpoint_bypassed"}]}}), "alters"),
        (
            "excluding a mapped requirement",
            lambda p: p["imports"][0].update({"exclude-controls": [{"with-ids": ["rule.unapproved_tool_called"]}]}),
            "clause",
        ),
        (
            "an import of outside controls x_oscal does not map",
            lambda p: p["imports"][1]["include-controls"][0]["with-ids"].append("ac-2"),
            "x_oscal",
        ),
        (
            "an unknown control in a selection",
            lambda p: p["imports"][0].update({"exclude-controls": [{"with-ids": ["signal.nope"]}]}),
            "no control signal.nope",
        ),
        (
            "a missing TRP catalog",
            lambda p: p["back-matter"]["resources"][0]["rlinks"][0].update({"href": "gone.json"}),
            "imports no TRP catalog",
        ),
    ):
        check(f"the import refuses {name}", fails(oscal.import_document, variant(change), out, needle=needle))
    catalog = copy.deepcopy(docs[names["catalog"]])
    catalog["catalog"]["groups"][0]["controls"][0]["params"].append({"id": "x", "values": ["1"]})
    check(
        "the import refuses a parameter that is no TRP threshold",
        fails(oscal.import_document, catalog, out, needle="no TRP threshold"),
    )
    catalog = copy.deepcopy(docs[names["catalog"]])
    catalog["catalog"]["groups"][1]["controls"][0]["props"][0]["value"] = "renamed"
    check(
        "the import refuses a control whose props name another rule",
        fails(oscal.import_document, catalog, out, needle="does not match"),
    )
    catalog = copy.deepcopy(docs[names["catalog"]])
    catalog["catalog"]["metadata"]["props"][2]["value"] = "other-id"
    (out / names["catalog"]).write_text(oscal.write_json(catalog), encoding="utf-8")
    check(
        "the import refuses a TRP catalog whose props differ from its profile's",
        fails(oscal.import_document, base, out, needle="differ"),
    )


# ---------------------------------------------------------------- NIST catalogs and profile as import sources


def skeleton_errors(doc: dict[str, Any]) -> list[tuple[str, str]]:
    import jsonschema  # type: ignore[import-untyped]

    schema = load(ROOT / "schema" / "trp.schema.json")
    return sorted(
        ("/".join(map(str, e.absolute_path)), e.message)
        for e in jsonschema.Draft202012Validator(schema).iter_errors(doc)
    )


def placeholders_only(doc: dict[str, Any]) -> bool:
    return all(set(s) == {"signal", "reason"} for s in doc["scored_signals"])


def nist_checks(tmp: Path) -> None:
    for path, total, live in ((AI_RMF, 91, 91), (SP800_53, 1196, 1014)):
        doc = load(path)
        skel = oscal.import_document(doc, path.parent, authority="example.org", href=f"https://example.org/{path.name}")
        index = oscal.catalog_index(doc, path.name)
        expected = [cid for cid, c in index.items() if not oscal.is_withdrawn(c)]
        check(
            f"{path.name}: one placeholder per control that is not withdrawn ({live} of {total})",
            [s["signal"] for s in skel["scored_signals"]] == expected and len(expected) == live,
        )
        check(f"{path.name}: placeholders carry a name and a reason and no threshold", placeholders_only(skel))
        errors = skeleton_errors(skel)
        missing = {(p, m) for p, m in errors}
        want = {("", "'scope' is a required property"), ("", "'standing_bands' is a required property")} | {
            (f"scored_signals/{i}", f"'{m}' is a required property")
            for i in range(live)
            for m in ("weight", "direction", "warning_threshold", "critical_threshold")
        }
        check(
            f"{path.name}: the skeleton fails the TRP schema only where a person must decide",
            missing == want,
            sorted(missing ^ want)[:5],
        )
        maps = skel["x_oscal"]["mappings"]
        check(
            f"{path.name}: x_oscal links each placeholder to its control with no relationship",
            len(maps) == live and all(set(m) == {"clause", "catalog", "control"} for m in maps),
        )
        check(
            f"{path.name}: the skeleton cannot be exported until a person completes it",
            fails(oscal.export, skel, WHEN, needle="not valid"),
        )

    rmf = load(AI_RMF)
    picked = oscal.import_document(
        rmf,
        AI_RMF.parent,
        authority="example.org",
        trp_id="agent-oversight",
        controls=["MANAGE_2.4", "MEASURE_2.4"],
        catalog_name="ai-rmf-1.0",
        href="https://example.org/ai-rmf.json",
    )
    check(
        "--controls takes exactly the named controls in catalog order",
        [s["signal"] for s in picked["scored_signals"]] == ["MANAGE_2.4", "MEASURE_2.4"],
    )
    check(
        "a placeholder's reason quotes the control's title and overview",
        picked["scored_signals"][1]["reason"].startswith(
            "Control MEASURE_2.4 of Artificial Intelligence Risk "
            "Management Framework (AI RMF 1.0), MEASURE 2.4. The "
            "functionality and behavior"
        ),
    )
    sp = load(SP800_53)
    for name, ids, needle in (
        ("an unknown control", ["zz-1"], "has no control zz-1"),
        ("a withdrawn control", ["ac-13"], "withdrawn"),
    ):
        check(
            f"--controls refuses {name}",
            fails(oscal.import_document, sp, SP800_53.parent, authority="example.org", controls=ids, needle=needle),
        )
    check("a skeleton needs --authority", fails(oscal.import_document, sp, SP800_53.parent, needle="--authority"))

    # A person completes the skeleton. Every value below is written by the check, standing in for that person.
    done = copy.deepcopy(picked)
    done["scope"] = {"intended_use": "Oversight of an AI agent, completed by the check."}
    done["standing_bands"] = [{"band": "good", "severity": 0}, {"band": "failing", "severity": 1}]
    for s, (w, c) in zip(done["scored_signals"], ((30, 60), (0.05, 0.2)), strict=True):
        s.update({"weight": 50, "direction": "higher_is_unsafe", "warning_threshold": w, "critical_threshold": c})
    for m in done["x_oscal"]["mappings"]:
        m["relationship"] = "intersects-with"
    done["x_oscal"]["provenance"] = {"method": "human", "matching_rationale": "semantic", "status": "draft"}
    check("a completed skeleton validates", not skeleton_errors(done), skeleton_errors(done)[:3])
    out = oscal.export(done, WHEN, {"ai-rmf-1.0": rmf})
    export_errors = [e for d in out.values() for e in oscal.oscal_errors(d)]
    imports = out["agent-oversight.oscal-profile.json"]["profile"]["imports"]
    check(
        "a completed skeleton exports to valid OSCAL that imports the AI RMF controls",
        not export_errors
        and any(i.get("include-controls") == [{"with-ids": ["MANAGE_2.4", "MEASURE_2.4"]}] for i in imports),
        export_errors[:3],
    )
    result = trp.evaluate(trp.profile_from_dict(done), {"MANAGE_2.4": 10, "MEASURE_2.4": 0.01})
    check("the completed profile evaluates", result["standing"] == "good", result["standing"])

    low = load(LOW)
    href = low["profile"]["imports"][0]["href"]
    check("the LOW baseline names its catalog through a back-matter resource", href.startswith("#"))
    check(
        "the LOW baseline's catalog cannot be found without --resolve",
        fails(oscal.import_document, low, LOW.parent, authority="example.org", needle="--resolve"),
    )
    skel = oscal.import_document(low, LOW.parent, {href: SP800_53}, authority="example.org", trp_id="sp800-53-low")
    with_ids = low["profile"]["imports"][0]["include-controls"][0]["with-ids"]
    index = oscal.catalog_index(sp, "sp")
    check(
        "the LOW baseline imports as one placeholder per selected control in catalog order",
        [s["signal"] for s in skel["scored_signals"]] == [c for c in index if c in set(with_ids)]
        and len(with_ids) == 149,
    )
    check("the LOW baseline skeleton carries no threshold", placeholders_only(skel))
    check(
        "the skeleton records the catalog link NIST's profile gives",
        skel["x_oscal"]["catalogs"][next(iter(skel["x_oscal"]["catalogs"]))]["href"]
        == "../../../../nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json",
    )
    nested = copy.deepcopy(low)
    nested["profile"]["imports"][0]["include-controls"] = [
        {"matching": [{"pattern": "ac-2*"}], "with-child-controls": "yes"}
    ]
    nested["profile"]["imports"][0]["exclude-controls"] = [{"with-ids": ["ac-2.10"]}]
    skel = oscal.import_document(nested, LOW.parent, {href: SP800_53}, authority="example.org")
    expect = [c for c, x in index.items() if (c.startswith("ac-2") and c != "ac-2.10") and not oscal.is_withdrawn(x)]
    check(
        "a pattern with child controls and an exclusion selects the same controls the catalog has",
        [s["signal"] for s in skel["scored_signals"]] == expect,
        [s["signal"] for s in skel["scored_signals"]][:8],
    )


def import_failure_checks(tmp: Path) -> None:
    for name, doc, needle in (
        ("a mapping collection", load(GOLDEN / "oscal-mapping-test.oscal-mapping.json"), "not one OSCAL"),
        ("a JSON array", [], "not one OSCAL"),
        ("an object with two models", {"catalog": {}, "profile": {}}, "not one OSCAL"),
        (
            "a catalog with two controls of one id",
            {
                "catalog": {
                    "uuid": "x",
                    "metadata": {},
                    "controls": [{"id": "a", "title": "A"}, {"id": "a", "title": "B"}],
                }
            },
            "two controls",
        ),
    ):
        check(f"the import refuses {name}", fails(oscal.import_document, doc, tmp, authority="e", needle=needle))
    prof = load(GOLDEN / "oscal-mapping-test.oscal-profile.json")
    prof["profile"]["imports"][0]["href"] = "#00000000-0000-4000-8000-000000000000"
    check(
        "the import refuses an href that names no resource",
        fails(oscal.import_document, prof, GOLDEN, needle="no TRP catalog"),
    )
    foreign = {
        "profile": {
            "uuid": "x",
            "metadata": {"title": "t"},
            "imports": [{"href": "https://example.org/catalog.json", "include-all": {}}],
        }
    }
    check(
        "the import never fetches an absolute URI",
        fails(oscal.import_document, foreign, tmp, authority="e", needle="--resolve"),
    )


# ---------------------------------------------------------------- command line


def cli_checks(tmp: Path) -> None:
    out = tmp / "cli"
    args = ["export", str(MAPPED), "--out-dir", str(out)]
    for name, path in LOCAL.items():
        args += ["--catalog", f"{name}={path}"]
    p = subprocess.run([*TOOL, *args], capture_output=True, text=True)
    check("the command line exports", p.returncode == 0, p.stderr)
    for f in sorted(GOLDEN.iterdir()):
        check(f"the command line writes {f.name} as the golden file", (out / f.name).read_bytes() == f.read_bytes())
    p = subprocess.run([*TOOL, "validate", *map(str, sorted(out.iterdir()))], capture_output=True, text=True)
    check("validate passes the exports", p.returncode == 0 and p.stdout.count(": valid") == 3, p.stdout)
    p = subprocess.run(
        [*TOOL, "import", str(out / "oscal-mapping-test.oscal-profile.json")], capture_output=True, text=True
    )
    check(
        "the command line imports the profile back",
        p.returncode == 0 and json.loads(p.stdout) == load(MAPPED),
        p.stderr,
    )
    p = subprocess.run(
        [*TOOL, "import", str(AI_RMF), "--authority", "example.org", "--controls", "GOVERN_1.1"],
        capture_output=True,
        text=True,
    )
    check(
        "a skeleton import exits 0 and says it does not validate yet",
        p.returncode == 0
        and "does not validate yet" in p.stderr
        and json.loads(p.stdout)["scored_signals"]
        == [
            {
                "signal": "GOVERN_1.1",
                "reason": oscal.placeholder(
                    oscal.catalog_index(load(AI_RMF), "x")["GOVERN_1.1"],
                    "Artificial Intelligence Risk Management Framework (AI RMF 1.0)",
                )["reason"],
            }
        ],
    )
    (tmp / "bad.json").write_text('{"catalog": ', encoding="utf-8")
    broken = copy.deepcopy(load(GOLDEN / "oscal-mapping-test.oscal-catalog.json"))
    broken["catalog"]["uuid"] = "nope"
    (tmp / "invalid.json").write_text(json.dumps(broken), encoding="utf-8")
    p = subprocess.run([*TOOL, "validate", str(tmp / "invalid.json")], capture_output=True, text=True)
    check("validate exits 1 on an invalid document", p.returncode == 1 and "1 errors" in p.stdout, p.stdout)
    for name, argv in (
        ("a file that is not JSON", ["import", str(tmp / "bad.json")]),
        ("a skeleton with no authority", ["import", str(AI_RMF)]),
        ("a --catalog with no path", ["export", str(MAPPED), "--out-dir", str(out), "--catalog", "sp800-53r5"]),
        ("a missing profile", ["export", str(tmp / "none.json"), "--out-dir", str(out)]),
    ):
        p = subprocess.run([*TOOL, *argv], capture_output=True, text=True)
        check(f"the command line exits 2 on {name}", p.returncode == 2 and p.stderr.startswith("trp_oscal:"), p.stderr)


def main() -> int:
    fixture_checks()
    datatype_checks()
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        export_checks(tmp)
        round_trip_checks(tmp)
        tailoring_checks(tmp)
        nist_checks(tmp)
        import_failure_checks(tmp)
        cli_checks(tmp)
    print(f"OSCAL export and import: {passed} checks passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
