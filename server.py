from __future__ import annotations

import calendar
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT_DIR = Path(__file__).resolve().parent
# Overridable with environment variables DATA_DIR, BIND_ADDRESS and PORT, e.g. PORT=9000 python3 server.py
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT_DIR / "data")).resolve()
DINNERS_FILE = DATA_DIR / "dinners.json"
PLANS_FILE = DATA_DIR / "plans.json"
LEGACY_LATEST_PLAN_FILE = DATA_DIR / "latest_plan.json"
HOST = os.environ.get("BIND_ADDRESS", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))

MAX_BODY_BYTES = 256 * 1024
MAX_DINNERS = 500
MAX_DINNER_LENGTH = 80
MAX_SOUP_SPACING = 6

# Only these files are served; everything else in the app directory stays private.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/script.js": ("script.js", "text/javascript; charset=utf-8"),
}

PLAN_PATH_PATTERN = re.compile(r"^/api/plans/(\d{4})-(\d{2})$")

# Serializes every read-modify-write of the data files across request threads.
STORAGE_LOCK = threading.Lock()


class RequestError(Exception):
    def __init__(self, status: HTTPStatus, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


class DinnerPlannerHandler(BaseHTTPRequestHandler):
    server_version = "DinnerShuffle/2.0"

    def do_GET(self) -> None:
        self._dispatch(self._handle_get)

    def do_HEAD(self) -> None:
        self._dispatch(self._handle_head)

    def do_PUT(self) -> None:
        self._dispatch(self._handle_put)

    def do_DELETE(self) -> None:
        self._dispatch(self._handle_delete)

    def _dispatch(self, handler) -> None:
        path = urlsplit(self.path).path
        try:
            handler(path)
        except RequestError as error:
            self._send_json({"error": error.message, **error.extra}, status=error.status)

    def _handle_get(self, path: str) -> None:
        if path == "/api/dinners":
            with STORAGE_LOCK:
                self._send_json(load_dinners())
            return

        if path == "/api/plans":
            with STORAGE_LOCK:
                plans = load_plans()
            summaries = [
                {"month": key, "version": plan["version"], "updatedAt": plan["updatedAt"]}
                for key, plan in sorted(plans.items())
            ]
            self._send_json({"plans": summaries})
            return

        month_key = parse_plan_path(path)
        if month_key:
            with STORAGE_LOCK:
                plan = load_plans().get(month_key)
            if plan is None:
                raise RequestError(HTTPStatus.NOT_FOUND, "Brak planu dla tego miesiąca.")
            self._send_json(plan)
            return

        self._send_static(path, include_body=True)

    def _handle_head(self, path: str) -> None:
        self._send_static(path, include_body=False)

    def _handle_put(self, path: str) -> None:
        if path == "/api/dinners":
            payload = self._read_json_body()
            dinners = sanitize_dinners(payload.get("dinners"))
            with STORAGE_LOCK:
                current = load_dinners()
                ensure_version(payload, current["version"], current)
                updated = {"version": current["version"] + 1, "dinners": dinners}
                write_json_atomic(DINNERS_FILE, updated)
            self._send_json(updated)
            return

        month_key = parse_plan_path(path)
        if month_key:
            payload = self._read_json_body()
            with STORAGE_LOCK:
                plans = load_plans()
                existing = plans.get(month_key)
                current_version = existing["version"] if existing else 0
                ensure_version(payload, current_version, existing or {"version": 0})
                plan = sanitize_plan(month_key, payload)
                plan["version"] = current_version + 1
                plan["updatedAt"] = now_iso()
                plans[month_key] = plan
                save_plans(plans)
            self._send_json(plan)
            return

        raise RequestError(HTTPStatus.NOT_FOUND, "Nie znaleziono.")

    def _handle_delete(self, path: str) -> None:
        month_key = parse_plan_path(path)
        if not month_key:
            raise RequestError(HTTPStatus.NOT_FOUND, "Nie znaleziono.")

        payload = self._read_json_body()
        with STORAGE_LOCK:
            plans = load_plans()
            existing = plans.get(month_key)
            if existing is None:
                raise RequestError(HTTPStatus.NOT_FOUND, "Brak planu dla tego miesiąca.")
            ensure_version(payload, existing["version"], existing)
            del plans[month_key]
            save_plans(plans)
        self._send_json({"deleted": month_key})

    def _read_json_body(self) -> dict:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Nieprawidłowy nagłówek Content-Length.")

        if content_length < 0 or content_length > MAX_BODY_BYTES:
            raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Za duże żądanie.")

        raw_body = self.rfile.read(content_length)
        try:
            payload = json.loads(raw_body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Nieprawidłowy JSON.")

        if not isinstance(payload, dict):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Treść żądania musi być obiektem JSON.")

        return payload

    def _send_static(self, path: str, include_body: bool) -> None:
        entry = STATIC_FILES.get(path)
        if entry is None:
            raise RequestError(HTTPStatus.NOT_FOUND, "Nie znaleziono.")

        filename, content_type = entry
        body = (ROOT_DIR / filename).read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Make browsers revalidate so a redeploy is picked up on the next reload.
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        # Kubernetes health checks hit "/" every few seconds; keep them out of the logs.
        if self.headers and self.headers.get("User-Agent", "").startswith("kube-probe/"):
            return
        super().log_message(format, *args)


def parse_plan_path(path: str) -> str | None:
    match = PLAN_PATH_PATTERN.match(path)
    if not match:
        return None

    year, month = int(match.group(1)), int(match.group(2))
    if not 2000 <= year <= 2100 or not 1 <= month <= 12:
        raise RequestError(HTTPStatus.BAD_REQUEST, "Nieprawidłowy miesiąc.")

    return f"{year:04d}-{month:02d}"


def ensure_version(payload: dict, current_version: int, current_state: dict) -> None:
    """Reject writes based on stale data so one browser can't silently overwrite another."""
    version = payload.get("version")
    if not isinstance(version, int) or isinstance(version, bool):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Brak numeru wersji.")

    if version != current_version:
        raise RequestError(
            HTTPStatus.CONFLICT,
            "Dane zostały w międzyczasie zmienione przez kogoś innego.",
            {"current": current_state},
        )


def normalize_meal_name(value: str) -> str:
    return " ".join(value.split()).strip().strip('"').strip()


def is_zupa(meal_name: str) -> bool:
    return meal_name.strip().casefold().startswith("zupa")


def sanitize_dinners(value) -> list[str]:
    if not isinstance(value, list):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Lista obiadów musi być tablicą.")

    normalized: list[str] = []
    seen: set[str] = set()

    for item in value:
        if not isinstance(item, str):
            continue

        cleaned = normalize_meal_name(item)[:MAX_DINNER_LENGTH]
        if not cleaned or cleaned.casefold() in seen:
            continue

        seen.add(cleaned.casefold())
        normalized.append(cleaned)

    if len(normalized) > MAX_DINNERS:
        raise RequestError(HTTPStatus.BAD_REQUEST, f"Maksymalnie {MAX_DINNERS} obiadów.")

    return normalized


def slot_count_for_month(month_key: str) -> int:
    year, month = (int(part) for part in month_key.split("-"))
    days_in_month = calendar.monthrange(year, month)[1]
    return (days_in_month + 1) // 2


def normalize_soup_spacing(value) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        return 1
    return min(value, MAX_SOUP_SPACING)


def sanitize_plan(month_key: str, payload: dict) -> dict:
    slots = payload.get("slots")
    expected_slots = slot_count_for_month(month_key)

    if not isinstance(slots, list) or len(slots) != expected_slots:
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            f"Plan na ten miesiąc musi mieć dokładnie {expected_slots} slotów.",
        )

    normalized_slots = []
    for slot in slots:
        if not isinstance(slot, dict) or not isinstance(slot.get("dinner"), str):
            raise RequestError(HTTPStatus.BAD_REQUEST, "Każdy slot musi mieć obiad.")

        dinner = normalize_meal_name(slot["dinner"])[:MAX_DINNER_LENGTH]
        if not dinner:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Nazwa obiadu nie może być pusta.")

        normalized_slots.append({"dinner": dinner, "locked": slot.get("locked") is True})

    return {
        "month": month_key,
        "soupSpacing": normalize_soup_spacing(payload.get("soupSpacing")),
        "slots": normalized_slots,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def write_json_atomic(path: Path, payload) -> None:
    """Write to a temp file and rename it over the target so readers never see a partial file."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def load_dinners() -> dict:
    payload = read_json(DINNERS_FILE)

    # Version 1 of the app stored a bare list.
    if isinstance(payload, list):
        return {"version": 1, "dinners": sanitize_dinners(payload)}

    if isinstance(payload, dict):
        version = payload.get("version")
        return {
            "version": version if isinstance(version, int) and version >= 0 else 0,
            "dinners": sanitize_dinners(payload.get("dinners", [])),
        }

    return {"version": 0, "dinners": []}


def load_plans() -> dict[str, dict]:
    payload = read_json(PLANS_FILE)
    if not isinstance(payload, dict) or not isinstance(payload.get("plans"), dict):
        return {}
    return payload["plans"]


def save_plans(plans: dict[str, dict]) -> None:
    write_json_atomic(PLANS_FILE, {"plans": dict(sorted(plans.items()))})


def migrate_legacy_plan() -> None:
    """Import the single latest_plan.json from version 1 of the app into the plan history."""
    if PLANS_FILE.exists():
        return

    legacy = read_json(LEGACY_LATEST_PLAN_FILE)
    plans: dict[str, dict] = {}

    if isinstance(legacy, dict) and isinstance(legacy.get("year"), int) and isinstance(legacy.get("month"), int):
        month_key = f"{legacy['year']:04d}-{legacy['month'] + 1:02d}"
        slot_dinners: dict[str, str] = {}
        for entry in legacy.get("plan") or []:
            if isinstance(entry, dict) and isinstance(entry.get("blockLabel"), str):
                slot_dinners.setdefault(entry["blockLabel"], entry.get("dinner", ""))

        ordered = [dinner for _, dinner in sorted(slot_dinners.items(), key=lambda item: int(item[0].split("-")[0]))]
        try:
            plan = sanitize_plan(
                month_key,
                {"soupSpacing": legacy.get("soupSpacing"), "slots": [{"dinner": dinner} for dinner in ordered]},
            )
            plan["version"] = 1
            plan["updatedAt"] = now_iso()
            plans[month_key] = plan
            print(f"Migrated legacy plan for {month_key} into {PLANS_FILE.name}")
        except RequestError as error:
            print(f"Skipped migrating legacy plan: {error.message}")

    save_plans(plans)


def run() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with STORAGE_LOCK:
        if not DINNERS_FILE.exists():
            write_json_atomic(DINNERS_FILE, {"version": 0, "dinners": []})
        migrate_legacy_plan()

    server = ThreadingHTTPServer((HOST, PORT), DinnerPlannerHandler)
    print(f"Serving Dinner Shuffle on http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
