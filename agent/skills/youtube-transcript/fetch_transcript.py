#!/usr/bin/env python3
"""Fetch a YouTube video's title and transcript via yt-dlp.

Prefers manual English captions, falls back to auto-generated. Uses yt-dlp
itself to download the caption file so we don't have to deal with SSL/cert
issues from a bare urllib request.
"""
import sys
import os
import glob
import shutil
import subprocess
import tempfile
import json
import time

# Extra flags: solve YouTube JS challenges and impersonate a browser if curl_cffi is installed.
COMMON_FLAGS = ["--no-warnings", "--remote-components", "ejs:github"]
RETRIES = 4


def run_ytdlp(cmd):
    """Run yt-dlp, retrying with backoff on HTTP 429 (rate limiting)."""
    delay = 15
    for attempt in range(1, RETRIES + 1):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return result
        if "429" in result.stderr and attempt < RETRIES:
            print(f"Rate limited (429), retrying in {delay}s ({attempt}/{RETRIES - 1})...", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
            continue
        print(f"Error executing yt-dlp: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)


def get_metadata(url):
    cmd = [
        "yt-dlp",
        "--dump-json",
        "--skip-download",
        *COMMON_FLAGS,
        url,
    ]
    try:
        result = run_ytdlp(cmd)
        return json.loads(result.stdout)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


def pick_english_lang(info):
    """Return (lang_code, is_auto) for the best English caption track, or None."""
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}

    preferred = ["en", "en-US", "en-GB"]

    # 1. Manual, preferred order
    for lang in preferred:
        if lang in subs:
            return lang, False
    # 2. Any manual en*
    for lang in subs:
        if lang.startswith("en"):
            return lang, False
    # 3. Auto: the original-language track first (e.g. "en-orig"); it is the
    #    real ASR output and is less rate-limited than the translated "en" track.
    for lang in auto:
        if lang.startswith("en") and lang.endswith("-orig"):
            return lang, True
    for lang in preferred:
        if lang in auto:
            return lang, True
    # 4. Any auto en*
    for lang in auto:
        if lang.startswith("en"):
            return lang, True
    return None


def download_subtitle(url, lang, is_auto, outdir):
    """Use yt-dlp to download the json3 subtitle file. Returns the file path."""
    cmd = [
        "yt-dlp",
        "--skip-download",
        *COMMON_FLAGS,
        "--sub-format", "json3",
        "--sub-langs", lang,
        "--write-auto-subs" if is_auto else "--write-subs",
        "-o", os.path.join(outdir, "%(id)s.%(ext)s"),
        url,
    ]
    run_ytdlp(cmd)

    matches = glob.glob(os.path.join(outdir, "*.json3"))
    if not matches:
        print("yt-dlp did not produce a json3 subtitle file.", file=sys.stderr)
        sys.exit(1)
    return matches[0]


def extract_text_from_json3(path, timestamps=False):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if timestamps:
        # Auto captions carry per-word offsets (tOffsetMs); use them so a marker
        # appears whenever the second changes. Manual captions without offsets
        # fall back to one marker per caption line.
        lines = []
        last = None
        for event in data.get("events", []):
            base = event.get("tStartMs", 0)
            for seg in event.get("segs", []) or []:
                word = seg.get("utf8", "").replace("\n", " ")
                if not word.strip():
                    continue
                t = (base + seg.get("tOffsetMs", 0)) // 1000
                if t != last:
                    lines.append(f"\n[{t // 60}:{t % 60:02d}] ")
                    last = t
                lines.append(word.strip() + " ")
        return "".join(lines).strip()

    text_parts = []
    for event in data.get("events", []):
        for seg in event.get("segs", []) or []:
            text = seg.get("utf8", "")
            if text.strip() and text != "\n":
                text_parts.append(text.strip())
    return " ".join(text_parts)


def main():
    args = [a for a in sys.argv[1:] if a != "--timestamps"]
    timestamps = "--timestamps" in sys.argv[1:]
    if not args:
        print("Usage: python fetch_transcript.py <youtube_url> [--timestamps]", file=sys.stderr)
        sys.exit(1)

    url = args[0]

    print("Fetching video metadata...", file=sys.stderr)
    info = get_metadata(url)
    title = info.get("title", "Unknown_Title")

    pick = pick_english_lang(info)
    if pick is None:
        print(f"No English subtitles found for video: {title}", file=sys.stderr)
        sys.exit(1)
    lang, is_auto = pick

    tmpdir = tempfile.mkdtemp(prefix="yt-transcript-")
    try:
        print(
            f"Downloading {'auto ' if is_auto else ''}captions ({lang})...",
            file=sys.stderr,
        )
        sub_path = download_subtitle(url, lang, is_auto, tmpdir)
        transcript = extract_text_from_json3(sub_path, timestamps)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    output = {"title": title, "transcript": transcript}
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
