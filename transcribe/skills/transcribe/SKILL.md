---
name: transcribe
description: Transcribe a local audio/video file OR a URL (YouTube/Vimeo/Drive/etc.) to a text transcript, processed on this machine with faster-whisper — no API key, and the audio is not sent to any speech service. Use when the user says "get the transcript of <file/URL>", "transcribe this", "/transcribe", or points at a media file/link and wants its words as text. Works in any project.
---

# Transcribe

Run local speech-to-text on an audio or video file, or a URL, with the bundled `transcribe.py` (faster-whisper; GPU when available, CPU otherwise). No API key is needed and the audio is processed on this machine.

## How to run

```
python "${CLAUDE_PLUGIN_ROOT}/skills/transcribe/transcribe.py" "<file-or-url>" [output] [--plain|--srt] [--model NAME] [--language CODE] [--force]
```

Use `python3` where `python` is not on the path. Use the same interpreter for the check, any install, and the run.

- **Local file**: writes `<name>.txt` next to it.
- **URL**: fetches the audio with yt-dlp and writes `<title>-<id>.txt` in the current folder. One video per run: a playlist link gives its single video, and a live stream is refused.
- **Custom output**: a second path. The script takes one source per run; it refuses a second argument that looks like a media file.
- **An existing output file is not replaced** unless `--force` is given. Ask before using it.

Formats: timestamped `[MM:SS] text` lines by default; `--plain` for one paragraph; `--srt` for subtitles.

Models, with `--model` or the `WHISPER_MODEL` variable:

| Model | Use |
|---|---|
| `distil-large-v3` (default) | Fast. **English only.** |
| `large-v3` | Most accurate, and any other language |
| `medium`, `small` | A modest or weak machine |

If the recording is not in English, or the user says so, use `--model large-v3`.

## First use on a machine

If you do not know that it has run here before, check first:

```
python "${CLAUDE_PLUGIN_ROOT}/skills/transcribe/transcribe.py" --check
```

It loads no speech model and downloads nothing. It prints the Python it is running under, whether `faster-whisper` and `yt-dlp` are installed, what it can tell about a GPU, and whether the model is already downloaded. Exit code 0 means a local file can be transcribed; 1 means something required is missing.

When something is missing it prints the exact install command, which names that same Python. Then:

1. Tell the user what will be installed and into which Python, and wait for them to agree. Never install without asking.
2. Run the printed command with the interpreter path it names. Do not substitute a bare `pip`, which may belong to a different Python. In PowerShell a command that starts with a quoted path needs `&` in front.
3. If pip refuses because the environment is managed by the system, do not force it. Offer to create a virtual environment and use its Python for the check and every run.
4. Install the optional GPU libraries only if the check lists them. They exist for NVIDIA GPUs on Windows and Linux only.

If the model is not downloaded yet, tell the user the first run fetches it once (the check gives the size) and needs a connection.

## What to do

1. Take the file path or URL from the user. Default to the timestamped format; use `--srt` when they want subtitles and `--plain` when they want prose.
2. **Give it time.** A recording of more than a few minutes takes longer than a shell command's default time limit, much longer on a CPU. Run it as a background command, or with the longest timeout available, and wait for it to finish. It prints its position every minute of audio, and it writes the transcript as it goes to `<output>.part`, so an interrupted run still leaves what was done.
3. When it finishes it prints the output path and the detected language. Tell the user where the transcript is.
4. Show the transcript, or summarise it, only if the user wants that. Reading the file brings its text into this conversation.

## When a URL fails

yt-dlp could not fetch it: the video may be private, removed, region-locked or need a sign-in, or the site changed and yt-dlp needs updating (`python -m pip install -U yt-dlp`, with the user's agreement). Say which it looks like from the message; do not retry in a loop.

## Whose content

Transcribe only material the user owns or has the right to use. If a request is plainly to copy someone else's paid or private content, say so before running it.

## What leaves the machine

Be accurate about this if asked:

- The audio is processed locally. No speech service receives it.
- A URL is downloaded from its site by yt-dlp.
- The model is downloaded from Hugging Face on first use, and the library may contact Hugging Face again to check it.
- The transcript is a file on disk. If you read or summarise it, its text is part of the conversation like any other file you read.
