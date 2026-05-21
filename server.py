from __future__ import annotations

import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
DINNERS_FILE = DATA_DIR / "dinners.json"
LATEST_PLAN_FILE = DATA_DIR / "latest_plan.json"
HOST = "0.0.0.0"
PORT = 8000


class DinnerPlannerHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/dinners":
            self._send_json({"dinners": self._load_dinners()})
            return

        if self.path == "/api/latest-plan":
            self._send_json(self._load_latest_plan())
            return

        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/dinners":
            self._handle_save_dinners()
            return

        if self.path == "/api/latest-plan":
            self._handle_save_latest_plan()
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")

    def _handle_save_dinners(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        dinners = self._sanitize_dinners(payload.get("dinners", []))
        DATA_DIR.mkdir(exist_ok=True)
        DINNERS_FILE.write_text(json.dumps(dinners, indent=2), encoding="utf-8")
        self._send_json({"dinners": dinners})

    def _handle_save_latest_plan(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        normalized_plan = self._sanitize_latest_plan(payload)
        DATA_DIR.mkdir(exist_ok=True)
        LATEST_PLAN_FILE.write_text(json.dumps(normalized_plan, indent=2), encoding="utf-8")
        self._send_json(normalized_plan)

    def _read_json_body(self) -> dict | None:
        content_length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(content_length)

        try:
            payload = json.loads(raw_body or b"{}")
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)
            return None

        if not isinstance(payload, dict):
            self._send_json({"error": "JSON body must be an object"}, status=HTTPStatus.BAD_REQUEST)
            self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")
            return

        return payload

    def log_message(self, format: str, *args) -> None:
        super().log_message(format, *args)

    def _load_dinners(self) -> list[str]:
        if not DINNERS_FILE.exists():
            DATA_DIR.mkdir(exist_ok=True)
            DINNERS_FILE.write_text("[]\n", encoding="utf-8")
            return []

        try:
            payload = json.loads(DINNERS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []

        return self._sanitize_dinners(payload)

    def _load_latest_plan(self) -> dict:
        if not LATEST_PLAN_FILE.exists():
            DATA_DIR.mkdir(exist_ok=True)
            empty_plan = self._empty_latest_plan()
            LATEST_PLAN_FILE.write_text(json.dumps(empty_plan, indent=2), encoding="utf-8")
            return empty_plan

        try:
            payload = json.loads(LATEST_PLAN_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return self._empty_latest_plan()

        return self._sanitize_latest_plan(payload)

    def _sanitize_dinners(self, value) -> list[str]:
        if not isinstance(value, list):
            return []

        normalized: list[str] = []
        seen: set[str] = set()

        for item in value:
            if not isinstance(item, str):
                continue

            cleaned = self._normalize_meal_name(item)
            if not cleaned:
                continue

            lowered = cleaned.casefold()
            if lowered in seen:
                continue

            seen.add(lowered)
            normalized.append(cleaned)

        return normalized

    def _sanitize_latest_plan(self, value) -> dict:
        empty_plan = self._empty_latest_plan()
        if not isinstance(value, dict):
            return empty_plan

        year = value.get("year")
        month = value.get("month")
        soup_spacing = value.get("soupSpacing")
        dinners = value.get("dinners")
        plan_entries = value.get("plan")

        if not isinstance(year, int) or not isinstance(month, int):
            return empty_plan

        if month < 0 or month > 11:
            return empty_plan

        if not isinstance(soup_spacing, int) or soup_spacing < 1:
            soup_spacing = 1

        soup_spacing = min(soup_spacing, 6)

        normalized_dinners = self._sanitize_dinners(dinners)
        normalized_plan: list[dict] = []

        if isinstance(plan_entries, list):
            for entry in plan_entries:
                if not isinstance(entry, dict):
                    continue

                day = entry.get("day")
                weekday = entry.get("weekday")
                dinner = entry.get("dinner")
                block_label = entry.get("blockLabel")

                if not isinstance(day, int) or day < 1:
                    continue

                if not isinstance(weekday, str) or not weekday.strip():
                    continue

                if not isinstance(dinner, str) or not self._normalize_meal_name(dinner):
                    continue

                if not isinstance(block_label, str) or not block_label.strip():
                    continue

                normalized_plan.append(
                    {
                        "day": day,
                        "weekday": weekday.strip(),
                        "dinner": self._normalize_meal_name(dinner),
                        "blockLabel": block_label.strip(),
                    }
                )

        return {
            "year": year,
            "month": month,
            "soupSpacing": soup_spacing,
            "dinners": normalized_dinners,
            "plan": normalized_plan,
        }

    def _empty_latest_plan(self) -> dict:
        return {
            "year": None,
            "month": None,
            "soupSpacing": 1,
            "dinners": [],
            "plan": [],
        }

    def _normalize_meal_name(self, value: str) -> str:
        return " ".join(value.split()).strip().strip('"').strip()

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    if not DINNERS_FILE.exists():
        DINNERS_FILE.write_text("[]\n", encoding="utf-8")
    if not LATEST_PLAN_FILE.exists():
        LATEST_PLAN_FILE.write_text(
            json.dumps(
                {
                    "year": None,
                    "month": None,
                    "soupSpacing": 1,
                    "dinners": [],
                    "plan": [],
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    server = ThreadingHTTPServer((HOST, PORT), DinnerPlannerHandler)
    print(f"Serving Dinner Shuffle on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    run()