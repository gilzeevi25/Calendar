"""
Validate backup CSVs against live Supabase database.

Replicates the same queries and transformations as backup-to-csv.js
then compares against the CSV files row-by-row.
"""

import csv
import json
import io
import os
import requests
import pytest

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BACKUP_DIR = os.environ.get("BACKUP_DIR", os.path.join(os.path.dirname(__file__), "db-backup-22472800037"))

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def supabase_get(table, select="*", params=None, order=None):
    """Query Supabase REST API with pagination (matching backup script's fetchAll)."""
    all_params = {"select": select}
    if order:
        all_params["order"] = order
    if params:
        all_params.update(params)

    PAGE_SIZE = 1000
    all_rows = []
    offset = 0
    while True:
        p = dict(all_params)
        p["offset"] = str(offset)
        p["limit"] = str(PAGE_SIZE)
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers={**HEADERS, "Prefer": "return=representation"},
            params=p,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data:
            break
        all_rows.extend(data)
        if len(data) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return all_rows


def read_backup_csv(filename):
    """Read a backup CSV file and return list of dicts."""
    filepath = os.path.join(BACKUP_DIR, filename)
    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return list(reader)


def normalize(val):
    """Normalize a value for comparison: strip whitespace, treat None/empty as ''."""
    if val is None:
        return ""
    return str(val).strip()


def sort_rows(rows, keys):
    """Sort rows by given keys for stable comparison."""
    return sorted(rows, key=lambda r: tuple(normalize(r.get(k, "")) for k in keys))


# ---------------------------------------------------------------------------
# Test: People
# ---------------------------------------------------------------------------
class TestPeople:
    @pytest.fixture(autouse=True)
    def setup(self):
        self.db_data = supabase_get("people", "name,association", order="name.asc")
        self.csv_data = read_backup_csv("people.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        db_rows = sort_rows(
            [{"name": r["name"], "association": normalize(r.get("association"))} for r in self.db_data],
            ["name"],
        )
        csv_rows = sort_rows(
            [{"name": normalize(r["name"]), "association": normalize(r.get("association"))} for r in self.csv_data],
            ["name"],
        )
        mismatches = []
        # Check all DB rows present in CSV
        db_names = {r["name"] for r in db_rows}
        csv_names = {r["name"] for r in csv_rows}
        only_db = db_names - csv_names
        only_csv = csv_names - db_names
        if only_db:
            mismatches.append(f"In DB but not CSV: {only_db}")
        if only_csv:
            mismatches.append(f"In CSV but not DB: {only_csv}")
        # Compare matching rows
        db_map = {r["name"]: r for r in db_rows}
        csv_map = {r["name"]: r for r in csv_rows}
        for name in db_names & csv_names:
            if db_map[name] != csv_map[name]:
                mismatches.append(f"Diff for '{name}': DB={db_map[name]}, CSV={csv_map[name]}")
        assert not mismatches, "People mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Calendar Entries
# ---------------------------------------------------------------------------
class TestCalendarEntries:
    @pytest.fixture(autouse=True)
    def setup(self):
        # Replicate the backup script's join: calendar_entries with people(name, association)
        raw = supabase_get(
            "calendar_entries",
            "date,status,note,people(name,association)",
            order="date.asc",
        )
        self.db_data = []
        for e in raw:
            p = e.get("people") or {}
            self.db_data.append({
                "name": normalize(p.get("name")),
                "date": normalize(e.get("date")),
                "status": normalize(e.get("status")),
                "note": normalize(e.get("note")),
                "association": normalize(p.get("association")),
            })
        self.csv_data = read_backup_csv("calendar_entries.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        sort_keys = ["name", "date"]
        db_rows = sort_rows(self.db_data, sort_keys)
        csv_rows = sort_rows(
            [{k: normalize(v) for k, v in r.items()} for r in self.csv_data],
            sort_keys,
        )
        mismatches = []
        max_report = 20  # cap output
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
                if len(mismatches) >= max_report:
                    mismatches.append(f"... (showing first {max_report} of potentially more)")
                    break
        # Check for extra rows
        if len(db_rows) > len(csv_rows):
            for r in db_rows[len(csv_rows):len(csv_rows)+5]:
                mismatches.append(f"Extra DB row: {r}")
        elif len(csv_rows) > len(db_rows):
            for r in csv_rows[len(db_rows):len(db_rows)+5]:
                mismatches.append(f"Extra CSV row: {r}")
        assert not mismatches, "Calendar entries mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Shifts
# ---------------------------------------------------------------------------
class TestShifts:
    @pytest.fixture(autouse=True)
    def setup(self):
        raw = supabase_get(
            "shifts",
            "date,start_time,end_time,note,mission_types(name)",
            order="date.asc",
        )
        self.db_data = []
        for s in raw:
            mt = s.get("mission_types") or {}
            self.db_data.append({
                "date": normalize(s.get("date")),
                "mission_type": normalize(mt.get("name")),
                "start_time": normalize(s.get("start_time")),
                "end_time": normalize(s.get("end_time")),
                "note": normalize(s.get("note")),
            })
        self.csv_data = read_backup_csv("shifts.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        sort_keys = ["date", "mission_type", "start_time"]
        db_rows = sort_rows(self.db_data, sort_keys)
        csv_rows = sort_rows(
            [{k: normalize(v) for k, v in r.items()} for r in self.csv_data],
            sort_keys,
        )
        mismatches = []
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
        assert not mismatches, "Shifts mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Shift Assignments
# ---------------------------------------------------------------------------
class TestShiftAssignments:
    @pytest.fixture(autouse=True)
    def setup(self):
        raw = supabase_get(
            "shift_assignments",
            "role,is_auto,shifts(date,mission_types(name)),people(name)",
            order="created_at.asc",
        )
        self.db_data = []
        for a in raw:
            shift = a.get("shifts") or {}
            mt = shift.get("mission_types") or {}
            p = a.get("people") or {}
            self.db_data.append({
                "shift_date": normalize(shift.get("date")),
                "mission_type": normalize(mt.get("name")),
                "person_name": normalize(p.get("name")),
                "role": normalize(a.get("role")),
                "is_manual": "FALSE" if a.get("is_auto") else "TRUE",
            })
        self.csv_data = read_backup_csv("shift_assignments.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        sort_keys = ["shift_date", "mission_type", "person_name"]
        db_rows = sort_rows(self.db_data, sort_keys)
        csv_rows = sort_rows(
            [{k: normalize(v) for k, v in r.items()} for r in self.csv_data],
            sort_keys,
        )
        mismatches = []
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
        assert not mismatches, "Shift assignments mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Roster Config
# ---------------------------------------------------------------------------
class TestRosterConfig:
    @pytest.fixture(autouse=True)
    def setup(self):
        raw = supabase_get("roster_config", "key,value")
        self.db_data = []
        for r in raw:
            val = r.get("value")
            if isinstance(val, str):
                self.db_data.append({"key": r["key"], "value": val})
            else:
                self.db_data.append({"key": r["key"], "value": json.dumps(val)})
        self.csv_data = read_backup_csv("roster_config.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        db_map = {r["key"]: r["value"] for r in self.db_data}
        csv_map = {r["key"]: r["value"] for r in self.csv_data}
        mismatches = []
        all_keys = set(db_map.keys()) | set(csv_map.keys())
        for key in sorted(all_keys):
            db_val = db_map.get(key)
            csv_val = csv_map.get(key)
            if db_val is None:
                mismatches.append(f"Key '{key}': in CSV but not in DB")
                continue
            if csv_val is None:
                mismatches.append(f"Key '{key}': in DB but not in CSV")
                continue
            # Parse both as JSON for structural comparison (handles key ordering)
            try:
                db_parsed = json.loads(db_val)
                csv_parsed = json.loads(csv_val)
                if db_parsed != csv_parsed:
                    mismatches.append(
                        f"Key '{key}': structural diff\n  DB:  {json.dumps(db_parsed, ensure_ascii=False)[:200]}\n  CSV: {json.dumps(csv_parsed, ensure_ascii=False)[:200]}"
                    )
            except (json.JSONDecodeError, TypeError):
                if normalize(db_val) != normalize(csv_val):
                    mismatches.append(
                        f"Key '{key}': DB='{db_val[:100]}' != CSV='{csv_val[:100]}'"
                    )
        assert not mismatches, "Roster config mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Organizations
# ---------------------------------------------------------------------------
class TestOrganizations:
    @pytest.fixture(autouse=True)
    def setup(self):
        self.db_data = supabase_get("organizations", "name,created_at")
        self.csv_data = read_backup_csv("organizations.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        db_rows = sort_rows(
            [{"name": normalize(r["name"]), "created_at": normalize(r["created_at"])} for r in self.db_data],
            ["name"],
        )
        csv_rows = sort_rows(
            [{"name": normalize(r["name"]), "created_at": normalize(r["created_at"])} for r in self.csv_data],
            ["name"],
        )
        mismatches = []
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
        assert not mismatches, "Organizations mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Mission Types
# ---------------------------------------------------------------------------
class TestMissionTypes:
    @pytest.fixture(autouse=True)
    def setup(self):
        raw = supabase_get(
            "mission_types",
            "name,display_name,color,default_hours,min_people,required_roles,sort_order",
            order="sort_order.asc",
        )
        self.db_data = []
        for mt in raw:
            rr = mt.get("required_roles")
            self.db_data.append({
                "name": normalize(mt.get("name")),
                "display_name": normalize(mt.get("display_name")),
                "color": normalize(mt.get("color")),
                "default_hours": normalize(mt.get("default_hours")),
                "min_people": normalize(mt.get("min_people")),
                "required_roles": json.dumps(rr) if isinstance(rr, list) else normalize(rr),
                "sort_order": normalize(mt.get("sort_order")),
            })
        self.csv_data = read_backup_csv("mission_types.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        sort_keys = ["name"]
        db_rows = sort_rows(self.db_data, sort_keys)
        csv_rows = sort_rows(
            [{k: normalize(v) for k, v in r.items()} for r in self.csv_data],
            sort_keys,
        )
        mismatches = []
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
        assert not mismatches, "Mission types mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Calendar Config
# ---------------------------------------------------------------------------
class TestCalendarConfig:
    @pytest.fixture(autouse=True)
    def setup(self):
        raw = supabase_get("calendar_config", "key,value")
        self.db_data = []
        for r in raw:
            val = r.get("value")
            if isinstance(val, str):
                self.db_data.append({"key": r["key"], "value": val})
            else:
                self.db_data.append({"key": r["key"], "value": json.dumps(val)})
        self.csv_data = read_backup_csv("calendar_config.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        db_map = {r["key"]: r["value"] for r in self.db_data}
        csv_map = {r["key"]: r["value"] for r in self.csv_data}
        mismatches = []
        for key in set(db_map) | set(csv_map):
            db_val = db_map.get(key)
            csv_val = csv_map.get(key)
            if db_val is None:
                mismatches.append(f"Key '{key}': in CSV but not in DB")
            elif csv_val is None:
                mismatches.append(f"Key '{key}': in DB but not in CSV")
            elif normalize(db_val) != normalize(csv_val):
                mismatches.append(f"Key '{key}': DB='{db_val}' != CSV='{csv_val}'")
        assert not mismatches, "Calendar config mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Organization Members
# ---------------------------------------------------------------------------
class TestOrganizationMembers:
    @pytest.fixture(autouse=True)
    def setup(self):
        # The backup script queries organization_members + profiles separately
        members = supabase_get("organization_members", "user_id,role")
        if not members:
            self.db_data = []
        else:
            user_ids = [m["user_id"] for m in members]
            # Query profiles for these user_ids
            profiles = supabase_get(
                "profiles",
                "id,email,full_name",
                params={"id": f"in.({','.join(user_ids)})"},
            )
            profile_map = {p["id"]: p for p in profiles}
            self.db_data = []
            for m in members:
                prof = profile_map.get(m["user_id"], {})
                self.db_data.append({
                    "email": normalize(prof.get("email")),
                    "full_name": normalize(prof.get("full_name")),
                    "role": normalize(m.get("role")),
                })
        self.csv_data = read_backup_csv("organization_members.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        sort_keys = ["email"]
        db_rows = sort_rows(self.db_data, sort_keys)
        csv_rows = sort_rows(
            [{k: normalize(v) for k, v in r.items()} for r in self.csv_data],
            sort_keys,
        )
        mismatches = []
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
        assert not mismatches, "Organization members mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Profiles
# ---------------------------------------------------------------------------
class TestProfiles:
    @pytest.fixture(autouse=True)
    def setup(self):
        self.db_data = supabase_get(
            "profiles",
            "id,email,full_name,avatar_url,created_at,updated_at",
            order="created_at.asc",
        )
        self.csv_data = read_backup_csv("profiles.csv")

    def test_row_count(self):
        db_count = len(self.db_data)
        csv_count = len(self.csv_data)
        assert db_count == csv_count, (
            f"Row count mismatch: DB={db_count}, CSV={csv_count}"
        )

    def test_content_match(self):
        cols = ["id", "email", "full_name", "avatar_url", "created_at", "updated_at"]
        db_rows = sort_rows(
            [{k: normalize(r.get(k)) for k in cols} for r in self.db_data],
            ["email"],
        )
        csv_rows = sort_rows(
            [{k: normalize(r.get(k)) for k in cols} for r in self.csv_data],
            ["email"],
        )
        mismatches = []
        for i, (db_r, csv_r) in enumerate(zip(db_rows, csv_rows)):
            if db_r != csv_r:
                mismatches.append(f"Row {i}: DB={db_r} != CSV={csv_r}")
        assert not mismatches, "Profiles mismatches:\n" + "\n".join(mismatches)


# ---------------------------------------------------------------------------
# Test: Table completeness — all DB tables are backed up
# ---------------------------------------------------------------------------
class TestTableCompleteness:
    def test_all_tables_backed_up(self):
        """Verify backup covers every table in the database."""
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/",
            headers={**HEADERS, "Accept": "application/openapi+json"},
        )
        resp.raise_for_status()
        spec = resp.json()
        db_tables = {
            p.lstrip("/")
            for p in spec.get("paths", {})
            if p != "/" and not p.startswith("/rpc/")
        }
        backup_files = {
            f.replace(".csv", "")
            for f in os.listdir(BACKUP_DIR)
            if f.endswith(".csv")
        }
        missing = db_tables - backup_files
        assert not missing, f"Tables in DB but not backed up: {missing}"
