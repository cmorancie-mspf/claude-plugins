"""
Self-contained local transcription with faster-whisper (GPU, CPU fallback).

    python transcribe.py <file-or-url> [output] [--plain | --srt] [--model NAME] [--language CODE] [--force]
    python transcribe.py --check [--model NAME]     what is installed, what is missing

<file-or-url>  a local audio/video file, OR a URL (YouTube/Vimeo/Drive/...),
               fetched audio-only via yt-dlp. One video per run: a playlist URL
               gives its single video, and a live stream is refused.
output         optional output path. Default: next to a local file as
               <stem>.txt (or .srt), or <title>-<id>.txt in the current dir for
               a URL. An existing file is not overwritten unless --force.

Formats:
  (default)    timestamped lines:  [MM:SS] text
  --plain      one flowing paragraph, no timestamps
  --srt        SubRip subtitles (HH:MM:SS,mmm), for actual captioning

Model (--model or WHISPER_MODEL env):
  distil-large-v3 (default, fast, English only) | large-v3 (max accuracy, any
  language) | medium | small

The audio is processed on this machine. No API key. The first use of a model
downloads it once from Hugging Face. The transcript is written as it is
produced, to <output>.part, and renamed when the run completes.
"""

from __future__ import annotations

import argparse
import glob
import importlib.util
import os
import re
import site
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_MODEL = "distil-large-v3"
MODEL_SIZES = {"distil-large-v3": "about 1.5 GB", "large-v3": "about 3 GB",
               "medium": "about 1.5 GB", "small": "about 0.5 GB"}
MEDIA_SUFFIXES = {".mp3", ".mp4", ".m4a", ".wav", ".mov", ".mkv", ".webm", ".flac", ".ogg",
                  ".opus", ".aac", ".avi", ".wma", ".m4v", ".mpg", ".mpeg", ".aiff", ".3gp"}


def has(mod: str) -> bool:
    """True when a module can be imported. A missing parent package counts as absent."""
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def pip_line(packages: list[str]) -> str:
    """The install command for the interpreter that is running this script."""
    return f'"{sys.executable}" -m pip install ' + " ".join(packages)


def _register_cuda_dlls() -> None:
    """Make pip-installed NVIDIA cuBLAS/cuDNN DLLs loadable on Windows."""
    if not hasattr(os, "add_dll_directory"):
        return
    try:
        bases = site.getsitepackages() + [site.getusersitepackages()]
    except Exception:
        return
    for base in bases:
        for bin_dir in glob.glob(str(Path(base) / "nvidia" / "*" / "bin")):
            try:
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
            except OSError:
                pass


def known_models() -> dict:
    """Short model names faster-whisper knows, mapped to their Hugging Face repositories."""
    try:
        from faster_whisper import utils
        return dict(getattr(utils, "_MODELS", {}))
    except Exception:
        return {}


def resolve_model(name: str) -> tuple[str, str]:
    """Return (kind, value): ('local', path), ('repo', 'org/name') or ('unknown', name)."""
    if Path(name).is_dir():
        return "local", name
    models = known_models()
    if name in models:
        return "repo", models[name]
    if re.fullmatch(r"[A-Za-z0-9][\w.-]*/[\w.-]+", name):
        return "repo", name
    return "unknown", name


def model_is_cached(repo: str) -> bool:
    hub = Path(os.getenv("HF_HUB_CACHE") or
               Path(os.getenv("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub")
    snaps = hub / ("models--" + repo.replace("/", "--")) / "snapshots"
    return snaps.is_dir() and any((d / "model.bin").exists() for d in snaps.iterdir() if d.is_dir())


def check(model_name: str) -> int:
    """Report what is installed and what is missing. Loads no model and downloads nothing.

    Exit code 0: a local file can be transcribed. 1: something required is missing.
    """
    required, optional = [], []
    print(f"python           {sys.version.split()[0]}  ({sys.executable})")

    fw = has("faster_whisper")
    print(f"faster-whisper   {'installed' if fw else 'MISSING (required)'}")
    if not fw:
        required.append("faster-whisper")
    yt = has("yt_dlp")
    print(f"yt-dlp           {'installed' if yt else 'missing (needed for URLs only)'}")
    if not yt:
        optional.append("yt-dlp")

    if not has("ctranslate2"):
        print("gpu              not known until faster-whisper is installed")
    else:
        gpu = 0
        try:
            _register_cuda_dlls()
            import ctranslate2
            gpu = ctranslate2.get_cuda_device_count()
        except Exception:
            gpu = 0
        if not gpu:
            print("gpu              no NVIDIA GPU found; the CPU will be used (slower, same result)")
        elif has("nvidia.cublas") and has("nvidia.cudnn"):
            print(f"gpu              {gpu} NVIDIA device(s); GPU libraries installed")
        elif sys.platform in ("win32", "linux"):
            print(f"gpu              {gpu} NVIDIA device(s); the pip GPU libraries are not installed, "
                  "so the CPU is used unless CUDA is installed system-wide")
            optional += ["nvidia-cublas-cu12", "nvidia-cudnn-cu12"]
        else:
            print(f"gpu              {gpu} device(s) reported; the CPU will be used on this platform")

    size = MODEL_SIZES.get(model_name, "size not listed")
    kind, value = resolve_model(model_name)
    if kind == "local":
        print(f"model            {model_name}: a local folder; nothing to download")
    elif not fw and "/" not in model_name:
        print(f"model            {model_name}: not known until faster-whisper is installed ({size})")
    elif kind == "unknown":
        print(f"model            {model_name}: NOT A KNOWN MODEL. Known: {', '.join(sorted(known_models()))}")
        required.append("(a valid --model)")
    elif model_is_cached(value):
        print(f"model            {model_name}: already downloaded ({value})")
    else:
        print(f"model            {model_name}: not downloaded yet; the first run fetches it once "
              f"from Hugging Face ({value}, {size}) and needs a connection")

    pkgs = [p for p in required if not p.startswith("(")]
    if pkgs:
        print("\nrequired, to install:\n  " + pip_line(pkgs))
    if optional:
        print("\noptional, to install:\n  " + pip_line(optional))
    if pkgs or optional:
        print("\nThis installs into the Python shown on the first line. If pip refuses because the "
              "environment is managed by the system, create a virtual environment and run this "
              "script with its python instead.")
    if required:
        return 1
    print("\nready" + ("" if yt else " for local files"))
    return 0


def load_model(model_name: str, device: str):
    from faster_whisper import WhisperModel
    if device == "cuda":
        _register_cuda_dlls()
        m = WhisperModel(model_name, device="cuda", compute_type="float16")
    else:
        m = WhisperModel(model_name, device="cpu", compute_type="int8")
    print(f"  model: {model_name} on {'GPU' if device == 'cuda' else 'CPU'}", file=sys.stderr)
    return m


def fetch_audio(url: str, workdir: Path) -> tuple[Path, str, str]:
    """Download one video's audio. Returns (file, title, id)."""
    if not has("yt_dlp"):
        sys.exit("yt-dlp is needed for a URL. Install with:\n  " + pip_line(["yt-dlp"]))
    out = workdir / "audio.%(ext)s"
    title_file, id_file = workdir / "title.txt", workdir / "id.txt"
    cmd = [sys.executable, "-m", "yt_dlp",
           "--ignore-config",                 # never obey a yt-dlp.conf found in the current folder
           "--no-playlist", "--playlist-items", "1",
           "--match-filter", "!is_live",      # a live stream never ends
           "-f", "bestaudio/best", "-o", str(out),
           "--print-to-file", "%(title)s", str(title_file),
           "--print-to-file", "%(id)s", str(id_file),
           "--", url]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError:
        sys.exit(f"yt-dlp could not fetch: {url}\n"
                 "The video may be private, removed, region-locked or need a sign-in, or the site "
                 "may have changed: updating yt-dlp often fixes that.")
    files = [f for f in workdir.glob("audio.*")]
    if not files:
        sys.exit("Nothing was fetched. The URL may be a live stream (refused), or hold no media.")

    def first_line(p: Path) -> str:
        try:
            return p.read_text(encoding="utf-8", errors="replace").splitlines()[0].strip()
        except (OSError, IndexError):
            return ""
    return files[0], first_line(title_file), first_line(id_file)


def slugify(text: str, max_len: int = 60) -> str:
    """A file-name-safe slug. Keeps letters and digits of any script."""
    slug = re.sub(r"[^\w]+", "-", text.lower(), flags=re.UNICODE).replace("_", "-")
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:max_len].rstrip("-") or "transcript"


def fmt_ts(seconds: float, srt: bool = False) -> str:
    s = int(seconds)
    if srt:
        ms = int((seconds - s) * 1000)
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d},{ms:03d}"
    return f"{s // 60:02d}:{s % 60:02d}"


def choose_output(args, default_out: Path, source: Path | None) -> Path:
    out_path = Path(args.output) if args.output else default_out
    if source is not None and out_path.resolve() == source.resolve():
        sys.exit("The output path is the source file. Give a different output path.")
    if not args.force:
        if args.output and out_path.suffix.lower() in MEDIA_SUFFIXES:
            sys.exit(f"The second argument is the output path, and '{out_path.name}' looks like a media "
                     "file. Transcribe one source per run, or pass --force if that really is the output.")
        if out_path.exists():
            sys.exit(f"{out_path} already exists. Pass --force to replace it, or give another output path.")
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(part_of(out_path), "w", encoding="utf-8"):
            pass
    except OSError as e:
        sys.exit(f"Cannot write to {out_path.parent}: {e}")
    return out_path


def part_of(out_path: Path) -> Path:
    return out_path.with_name(out_path.name + ".part")


def write_transcript(model, media: Path, part: Path, args) -> tuple[int, object]:
    """Write segments to `part` as they arrive. Returns (segment count, info)."""
    segments, info = model.transcribe(str(media), language=args.language, vad_filter=True)
    total = getattr(info, "duration", 0) or 0
    count, last_report = 0, -60.0
    with open(part, "w", encoding="utf-8") as fh:
        for seg in segments:
            text = seg.text.strip()
            if not text:
                continue
            count += 1
            if args.srt:
                fh.write(f"{count}\n{fmt_ts(seg.start, True)} --> {fmt_ts(seg.end, True)}\n{text}\n\n")
            elif args.plain:
                fh.write(("" if count == 1 else " ") + text)
            else:
                fh.write(f"[{fmt_ts(seg.start)}] {text}\n")
            fh.flush()
            if seg.end - last_report >= 60:
                last_report = seg.end
                of = f" of {fmt_ts(total)}" if total else ""
                print(f"  {fmt_ts(seg.end)}{of}", file=sys.stderr, flush=True)
    return count, info


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")   # a non-ASCII name must not crash the last print
        except Exception:
            pass
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("source", nargs="?", help="local audio/video file or a URL")
    p.add_argument("output", nargs="?", help="output path (optional)")
    p.add_argument("--check", action="store_true",
                   help="report what is installed and what is missing, then exit")
    fmt = p.add_mutually_exclusive_group()
    fmt.add_argument("--plain", action="store_true", help="no timestamps, one paragraph")
    fmt.add_argument("--srt", action="store_true", help="SubRip subtitle format")
    p.add_argument("--model", default=os.getenv("WHISPER_MODEL", DEFAULT_MODEL))
    p.add_argument("--language", default=None, help="force a language code (e.g. en); default auto")
    p.add_argument("--force", action="store_true", help="replace an existing output file")
    args = p.parse_args()
    if args.check:
        sys.exit(check(args.model))
    if not args.source:
        p.error("give a file or a URL, or --check")

    if not has("faster_whisper"):
        sys.exit("faster-whisper is not installed. Install with:\n  " + pip_line(["faster-whisper"]) +
                 "\nRun this script with --check to see everything that is missing.")
    kind, _ = resolve_model(args.model)
    if kind == "unknown":
        sys.exit(f"'{args.model}' is not a known model. Known: {', '.join(sorted(known_models()))}. "
                 "A Hugging Face repository id (org/name) or a local folder also works.")
    if args.language and args.language.lower() not in ("en", "english") and "distil" in args.model \
            and "/" not in args.model:
        sys.exit(f"{args.model} handles English only. For '{args.language}', add --model large-v3.")

    ext = ".srt" if args.srt else ".txt"
    local = Path(args.source)
    tmp = None
    try:
        if local.is_file():
            media, source = local, local
            default_out = local.with_suffix(ext)
            if default_out.resolve() == local.resolve():
                default_out = local.with_name(local.name + ext)
            out_path = choose_output(args, default_out, source)
        elif re.match(r"https?://", args.source):
            tmp = tempfile.TemporaryDirectory()
            media, title, vid = fetch_audio(args.source, Path(tmp.name))
            vid = slugify(vid, 40) if vid else "video"
            stem = f"{slugify(title)}-{vid}" if title else vid
            out_path = choose_output(args, Path.cwd() / f"{stem}{ext}", None)
        else:
            sys.exit(f"Not an existing file or a URL: {args.source}")

        part = part_of(out_path)
        device = "cuda"
        try:
            model = load_model(args.model, "cuda")
        except Exception as e:
            print(f"  GPU not used ({type(e).__name__}); using the CPU", file=sys.stderr)
            device, model = "cpu", load_model(args.model, "cpu")
        try:
            count, info = write_transcript(model, media, part, args)
        except Exception as e:
            if device != "cuda":
                raise
            # A GPU library can load and still fail at the first inference; start again on the CPU.
            print(f"  GPU failed during transcription ({type(e).__name__}); starting again on the CPU",
                  file=sys.stderr)
            model = load_model(args.model, "cpu")
            count, info = write_transcript(model, media, part, args)

        if not count:
            part.unlink(missing_ok=True)
            sys.exit("Empty transcript (no speech detected).")
        os.replace(part, out_path)
        lang = f" [{info.language}]" if getattr(info, "language", None) else ""
        print(f"Transcript{lang} -> {out_path}")
    finally:
        if tmp:
            tmp.cleanup()


if __name__ == "__main__":
    main()
