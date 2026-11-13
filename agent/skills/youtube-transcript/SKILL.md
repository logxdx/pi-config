---
name: youtube-transcript
description: Fetch the transcript and title of a YouTube video as JSON. Use when the user provides a YouTube URL and you need the spoken content (captions) for analysis, summarization, quoting, or search.
---

# YouTube Transcript

Fetches a YouTube video's title and full transcript by pulling captions via `yt-dlp`. Prefers manual English subtitles, falls back to auto-generated English.

## Requirements

- `yt-dlp` on PATH. Recommended install: `uv tool install yt-dlp --with curl_cffi` (browser impersonation, fewer 429s)
- `deno` (or node/bun) for YouTube's JS challenges. The script passes `--remote-components ejs:github`.
- Python 3

## Usage

```bash
python3 ~/.pi/agent/skills/youtube-transcript/fetch_transcript.py "<youtube_url>" [--timestamps]
```

`--timestamps` inserts a `[m:ss]` marker at every second where speech occurs (one line per second), which is useful for pulling video frames at matching times.

## Output

Prints a JSON object to stdout:

```json
{
  "title": "Video title",
  "transcript": "full transcript text as a single string"
}
```

Progress/info logs go to stderr. On failure (no English captions, network error, bad URL), the script exits non-zero with a message on stderr.

## Notes

- Only English captions are attempted (`en`, `en-US`, `en-GB`, then any `en*`). Manual captions are preferred over auto-generated.
- Auto captions use the original-language track (`en-orig`) first. The translated `en` track is what usually triggers HTTP 429.
- On HTTP 429 the script retries up to 3 times with backoff (15s, 30s, 60s).
- Plain text by default. Use `--timestamps` for per-second time markers. Caption tracks without per-word offsets get one marker per caption line.
- For non-English videos or videos with captions disabled, the script will fail; consider `video_extract` with a Gemini prompt as a fallback.
