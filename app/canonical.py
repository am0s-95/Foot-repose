"""Canonical logical fields and request fingerprint (§3).

The fingerprint is computed over *logical* fields, never over the raw body.
Two requests that mean the same thing must replay against each other even if
their JSON differs in key order, whitespace, unicode composition or numeric
spelling. Two requests that mean different things must not.

What we persist alongside the hash is the normalised field dict itself
(``fingerprint_fields``), so a mismatch can be explained without keeping the
client's bytes around.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from datetime import date
from typing import Any

from app.errors import InvalidRequest

#: Logical fields of POST /v1/shift-entries, in no particular order - the
#: canonical form sorts them.
SHIFT_ENTRY_FIELDS = (
    "branch_code",
    "staff_ref",
    "minutes",
    "expected_business_date",
    "note",
)


def _norm_text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise InvalidRequest(f"{field} must be a string", field=field)
    # NFC so that visually identical text with different unicode composition
    # produces one fingerprint, and surrounding whitespace never splits a key.
    return unicodedata.normalize("NFC", value).strip()


def _norm_int(value: Any, field: str) -> int:
    # bool is an int subclass in Python; True must not silently become 1.
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidRequest(f"{field} must be an integer", field=field)
    return value


def _norm_date(value: Any, field: str) -> str:
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str):
        raise InvalidRequest(f"{field} must be an ISO-8601 date", field=field)
    try:
        return date.fromisoformat(value.strip()).isoformat()
    except ValueError as exc:
        raise InvalidRequest(f"{field} must be an ISO-8601 date", field=field) from exc


def canonical_shift_entry_fields(payload: dict) -> dict:
    """Normalise a shift-entry body into its logical fields.

    Unknown keys are rejected rather than ignored: silently dropping a field a
    client believed was meaningful would let two different requests share one
    fingerprint.
    """
    if not isinstance(payload, dict):
        raise InvalidRequest("body must be a JSON object")

    unknown = sorted(set(payload) - set(SHIFT_ENTRY_FIELDS))
    if unknown:
        raise InvalidRequest("unknown fields in body", fields=unknown)

    missing = [f for f in SHIFT_ENTRY_FIELDS if f != "note" and f not in payload]
    if missing:
        raise InvalidRequest("missing required fields", fields=missing)

    note = payload.get("note")
    fields = {
        "branch_code": _norm_text(payload["branch_code"], "branch_code"),
        "staff_ref": _norm_text(payload["staff_ref"], "staff_ref"),
        "minutes": _norm_int(payload["minutes"], "minutes"),
        # §3: the client's declared business date is a logical field, so a
        # client that recomputes it after the boundary produces a different
        # fingerprint for the same key - which is a reuse, not a replay.
        "expected_business_date": _norm_date(
            payload["expected_business_date"], "expected_business_date"
        ),
        "note": None if note is None else _norm_text(note, "note"),
    }

    if fields["minutes"] <= 0:
        raise InvalidRequest("minutes must be positive", field="minutes")
    if not fields["branch_code"]:
        raise InvalidRequest("branch_code must not be blank", field="branch_code")
    if not fields["staff_ref"]:
        raise InvalidRequest("staff_ref must not be blank", field="staff_ref")

    return fields


def fingerprint(fields: dict) -> str:
    """sha256 over the canonical serialisation of the logical fields.

    sort_keys makes JSON key order irrelevant; the compact separators make
    whitespace irrelevant; ensure_ascii=False keeps the encoding of non-ASCII
    text stable and independent of the client's escaping choices.
    """
    canonical = json.dumps(
        fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
