# transcribe

Turn a local audio or video file, or a URL, into a text transcript, processed **on your own machine**. No API key, and the audio is not sent to any speech service.

It uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper), on an NVIDIA GPU when one is available and on the CPU otherwise.

## Use

In any Claude Code chat:

- "transcribe clips/talk.mp4"
- "get the transcript of https://youtu.be/XXXX"
- "make subtitles for interview.mov"
- `/transcribe`

| Output | How to ask | Looks like |
|---|---|---|
| Timestamped lines (default) | nothing extra | `[02:15] and that is where it broke` |
| Plain text | "plain", "no timestamps" | one flowing paragraph |
| Subtitles | "subtitles", "srt" | a SubRip `.srt` file |

A local file's transcript is written next to it. A URL's transcript is written in the current folder, named from the video's title and id.

- **One recording per run.** A playlist link gives its single video; a live stream is refused.
- **An existing file is never replaced** unless you say so.
- **A long recording takes a while,** much longer without a GPU. The transcript is written as it goes, to a `.part` file, so an interrupted run keeps what was done.

## Only transcribe what you have the right to

A URL is fetched with yt-dlp. Use this on material you own or are permitted to use.

## What leaves your machine

- **The audio does not.** It is processed locally.
- **A URL** is downloaded from its site.
- **The speech model** is downloaded from Hugging Face the first time it is used, and the library may contact Hugging Face again to check it.
- **The transcript** is a file on your disk. If you ask Claude to read or summarise it, its text goes to Claude like any other file it reads.

## What installing the plugin does, and does not do

Installing the plugin copies the skill and its script. It does **not** install the Python packages or fetch the speech model. On first use Claude runs a set-up check, tells you what is missing, and installs the packages only when you agree. The model then downloads itself the first time you transcribe.

| Needed | Size | How it arrives |
|---|---|---|
| Python 3.9 or later | | You install it |
| `faster-whisper` | small, plus its engine | `python -m pip install faster-whisper` |
| `yt-dlp` (for URLs only) | small | `python -m pip install yt-dlp` |
| GPU libraries (optional; NVIDIA on Windows or Linux only) | about 1 GB | `python -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` |
| The speech model | 0.5 to 3 GB, see below | Downloaded once, automatically, on first use |

To see where a machine stands without transcribing anything:

```
python skills/transcribe/transcribe.py --check
```

It prints which Python it is running under and the exact install command for that Python. If pip refuses because your Python is managed by the system, use a virtual environment.

On a Mac, including Apple Silicon, it runs on the CPU. That works; it is slower.

## Models

| Model | Download, roughly | Use |
|---|---|---|
| `distil-large-v3` (default) | 1.5 GB | Fast. **English only.** |
| `large-v3` | 3 GB | Most accurate; any other language |
| `medium` | 1.5 GB | A modest machine |
| `small` | 0.5 GB | A weak machine, or a quick rough pass |

Only the model you ask for is downloaded. Say "use large-v3" and so on, or set the `WHISPER_MODEL` environment variable. After a model's first download, local files transcribe without a connection in most cases.

## Without Claude

```
python skills/transcribe/transcribe.py <file-or-url> [output] [--plain | --srt] [--model NAME] [--language CODE] [--force]
python skills/transcribe/transcribe.py --check
```

## Status

In regular use by its author on Windows with an NVIDIA GPU. Not yet tried on macOS or Linux; reports are welcome.
