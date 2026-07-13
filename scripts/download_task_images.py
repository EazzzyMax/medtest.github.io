#!/usr/bin/env python3
"""Download every image referenced by the bundled MedikTest clinical cases."""

from __future__ import annotations

import argparse
import http.client
import json
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


IMAGE_PATTERN = re.compile(r"<<<image:([^>]+)>>>")
BASE_URL = "https://storage.yandexcloud.net/mediktest/tasks-images"


def image_ids(source: Path) -> list[str]:
    text = source.read_text(encoding="utf-8")
    return sorted(set(IMAGE_PATTERN.findall(text)))


def extensions(image_id: str) -> tuple[str, ...]:
    return ("png", "jpg", "webp", "jpeg") if image_id.startswith("table_") else (
        "jpg",
        "png",
        "webp",
        "jpeg",
    )


def actual_extension(payload: bytes, fallback: str) -> str:
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if payload.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if payload.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        return "webp"
    return fallback


def download_one(image_id: str, destination: Path) -> dict[str, object]:
    for existing_extension in ("png", "jpg", "gif", "webp", "jpeg"):
        existing = destination / f"{image_id}.{existing_extension}"
        if not existing.exists() or not existing.stat().st_size:
            continue
        payload = existing.read_bytes()
        detected_extension = actual_extension(payload, existing_extension)
        normalized = destination / f"{image_id}.{detected_extension}"
        if normalized != existing:
            existing.replace(normalized)
        return {"id": image_id, "file": normalized.name, "bytes": normalized.stat().st_size}

    for extension in extensions(image_id):
        target = destination / f"{image_id}.{extension}"
        url = f"{BASE_URL}/{image_id}.{extension}"
        request = urllib.request.Request(url, headers={"User-Agent": "MedikTest-static-export/1.0"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    content_type = response.headers.get("Content-Type", "")
                    if not content_type.startswith("image/"):
                        break
                    payload = response.read()
                if not payload:
                    break
                detected_extension = actual_extension(payload, extension)
                target = destination / f"{image_id}.{detected_extension}"
                temporary = target.with_suffix(target.suffix + ".part")
                temporary.write_bytes(payload)
                temporary.replace(target)
                return {"id": image_id, "file": target.name, "bytes": len(payload)}
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    break
                if attempt == 2:
                    break
            except (OSError, TimeoutError, http.client.IncompleteRead):
                if attempt == 2:
                    break
            time.sleep(0.4 * (attempt + 1))

    return {"id": image_id, "file": None, "bytes": 0}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("tasks-data.js"))
    parser.add_argument("--destination", type=Path, default=Path("task-images"))
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    ids = image_ids(args.source)
    args.destination.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, object]] = []

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(download_one, image_id, args.destination): image_id for image_id in ids}
        for completed, future in enumerate(as_completed(futures), 1):
            results.append(future.result())
            if completed % 100 == 0 or completed == len(ids):
                print(f"{completed}/{len(ids)}")

    results.sort(key=lambda entry: str(entry["id"]))
    manifest = {
        "base": "task-images",
        "count": sum(bool(entry["file"]) for entry in results),
        "missing": [entry["id"] for entry in results if not entry["file"]],
        "files": {entry["id"]: entry["file"] for entry in results if entry["file"]},
    }
    (args.destination / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (args.destination / "manifest.js").write_text(
        "window.MEDIKTEST_TASK_IMAGES="
        + json.dumps(manifest["files"], ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    print(
        f"downloaded={manifest['count']} missing={len(manifest['missing'])} "
        f"bytes={sum(int(entry['bytes']) for entry in results)}"
    )


if __name__ == "__main__":
    main()
