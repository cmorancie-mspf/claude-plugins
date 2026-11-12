"""Pulling transcripts: what to pull, the job records, and the worker that does it.

A pull runs as its own process so it outlives the tool call that started it:

    python pull.py run  <job_id>     the worker (started by the server, not by hand)
    python pull.py wait <job_id>     blocks until the job ends; exit 0 done, 1 failed or
                                     stopped, 2 blocked, 3 the worker went quiet

Listing uses yt-dlp; transcripts come from youtube-transcript-api. Both are imported only
when a pull actually runs, so search over an existing corpus works without them.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import store as store_mod  # noqa: E402

HEARTBEAT_S = 10
STALE_AFTER_S = 90
BLOCK_STREAK = 5          # videos in a row, on one route, that got no answer before the job gives up
COOLDOWN_S = 1800         # after a job ends blocked, no new pull over the same routes for this long
TABS = ("videos", "shorts", "streams")
KIND_OF_TAB = {"videos": "video", "shorts": "short", "streams": "stream"}
PERMANENT = {"NoTranscriptFound", "TranscriptsDisabled", "VideoUnavailable", "AgeRestricted",
             "VideoUnplayable", "InvalidVideoId", "EmptyTranscript"}
BLOCKED = {"RequestBlocked", "IpBlocked"}
YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}

_VIDEO_ID = r"[A-Za-z0-9_-]{11}"
_PLAYLIST_ID = r"(?:PL|UU|UL|FL|OL|LL|RD|EL)[A-Za-z0-9_-]{8,62}"
_HANDLE = r"@(?=[^A-Za-z0-9]*[A-Za-z0-9])[A-Za-z0-9_.\-\u00b7]{3,60}"
_CHANNEL_ID = r"UC[A-Za-z0-9_-]{22}"
_NAME = r"[A-Za-z0-9][A-Za-z0-9_\-]*(?:\.[A-Za-z0-9_\-]+)*"


class PullError(Exception):
    """A refusal with a message meant for the person."""


# ---------- what to pull -------------------------------------------------------
# Only YouTube addresses built here are ever handed to yt-dlp. Its generic extractor will
# fetch any URL it is given, so a caller's text is parsed into an id and never passed through.


def _yt_url(text: str):
    t = text.strip()
    if not re.match(r"^https?://", t, flags=re.I):
        if re.match(r"^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/", t, flags=re.I):
            t = "https://" + t
        else:
            return None
    try:
        parts = urlsplit(t)
    except ValueError:
        raise PullError("that address could not be read") from None
    if (parts.hostname or "").lower() not in YT_HOSTS:
        raise PullError("only youtube.com and youtu.be addresses are accepted")
    return parts


def parse_video(text: str) -> str:
    t = str(text).strip()
    if re.fullmatch(_VIDEO_ID, t):
        return t
    parts = _yt_url(t)
    if parts is not None:
        if parts.hostname.lower() == "youtu.be":
            cand = parts.path.strip("/").split("/")[0]
        else:
            m = re.match(r"^/(?:shorts|live|embed|v)/([^/?#]+)", parts.path)
            cand = m.group(1) if m else (parse_qs(parts.query).get("v") or [""])[0]
        if re.fullmatch(_VIDEO_ID, cand):
            return cand
    raise PullError("not a YouTube video: give a watch address or an 11-character video id")


def parse_playlist(text: str) -> str:
    t = str(text).strip()
    if re.fullmatch(_PLAYLIST_ID, t):
        return t
    parts = _yt_url(t)
    if parts is not None:
        cand = (parse_qs(parts.query).get("list") or [""])[0]
        if re.fullmatch(_PLAYLIST_ID, cand):
            return cand
    raise PullError("not a YouTube playlist: give a playlist address or its id (PL...)")


def parse_channel(text: str) -> str:
    """Returns the channel's path on youtube.com: '@handle', 'channel/UC...', 'c/Name' or 'user/Name'."""
    t = str(text).strip()
    parts = _yt_url(t)
    if parts is not None:
        if parts.hostname.lower() == "youtu.be":
            raise PullError("that is a video address, not a channel")
        t = parts.path.strip("/")
        t = re.sub(r"/(videos|shorts|streams|featured|playlists|about|community|live)$", "", t)
    t = t.strip("/")
    if re.fullmatch(_HANDLE, t):
        return t
    if re.fullmatch(_CHANNEL_ID, t):
        return f"channel/{t}"
    m = re.fullmatch(rf"(channel)/({_CHANNEL_ID})|(c|user)/({_NAME})", t)
    if m:
        return t
    raise PullError("not a YouTube channel: give @handle, a channel address, or a UC... channel id")


# ---------- job records ---------------------------------------------------------


def jobs_dir() -> Path:
    d = config.home_dir() / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _job_path(job_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", str(job_id)):
        raise PullError("not a job id")
    return jobs_dir() / f"{job_id}.json"


def write_job(job: dict) -> None:
    path = _job_path(job["id"])
    tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(job, indent=1), encoding="utf-8")
    for attempt in range(6):          # a reader on Windows can hold the file for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def read_job(job_id: str) -> dict:
    path = _job_path(job_id)
    for attempt in range(4):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise PullError(f"no job with id {job_id}") from None
        except (ValueError, PermissionError):
            time.sleep(0.05 * (attempt + 1))
    raise PullError(f"the record of job {job_id} could not be read")


def effective_state(job: dict) -> str:
    """The recorded state, or 'died' when a job that says it is running stopped reporting."""
    if job.get("state") in ("starting", "running"):
        if time.time() - float(job.get("heartbeat") or job.get("created") or 0) > STALE_AFTER_S:
            return "died"
    return job.get("state", "unknown")


def list_jobs(limit: int = 20) -> list:
    out = []
    for p in sorted(jobs_dir().glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:limit]:
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            continue
    return out


def active_job() -> Optional[dict]:
    for job in list_jobs(50):
        if effective_state(job) in ("starting", "running"):
            return job
    return None


PULL_LOCK = "active.lock"     # pulls
EMBED_LOCK = "embed.lock"     # embedding runs (embed.py): they do not touch the site, so they have their own slot


def _acquire_slot(job_id: str, lock_name: str = PULL_LOCK) -> None:
    """One pull at a time per data folder. Two pulls from one address double the rate it sees.
    An embedding run takes a slot of its own in the same way, under another name."""
    what, stop = ("a pull", "pull_stop") if lock_name == PULL_LOCK else ("an embedding run", "embed_stop")
    lock = jobs_dir() / lock_name
    mine = jobs_dir() / f"{job_id}.slot"
    mine.write_text(job_id, encoding="utf-8")
    busy = PullError(f"{what} is already running. One runs at a time: wait for it, or stop it with {stop}.")
    try:
        try:
            os.link(mine, lock)            # appears complete or not at all: the lock is never empty
            return
        except FileExistsError:
            pass
        except OSError:                    # no hard links here: create it exclusively instead
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w") as f:
                    f.write(job_id)
                return
            except FileExistsError:
                pass
        try:
            holder = lock.read_text(encoding="utf-8").strip()
        except OSError:
            raise busy from None
        if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", holder):
            raise busy                     # being written, or not ours to judge: treat as held
        try:
            held = effective_state(read_job(holder)) in ("starting", "running")
        except PullError:
            held = False
        if held:
            raise PullError(f"{what} is already running (job {holder}). One runs at a time: "
                            f"wait for it, or stop it with {stop}.")
        try:
            os.replace(mine, lock)         # the holder ended or died: take the slot over in one step
        except OSError:
            raise busy from None           # someone else is taking it over at this moment
        time.sleep(0.05)
        if slot_holder(lock_name) != job_id:   # someone else took it over at the same moment
            raise busy
    finally:
        try:
            mine.unlink()
        except OSError:
            pass


def slot_holder(lock_name: str = PULL_LOCK) -> str:
    try:
        return (jobs_dir() / lock_name).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _release_slot(job_id: str, lock_name: str = PULL_LOCK) -> None:
    lock = jobs_dir() / lock_name
    try:
        if lock.read_text().strip() == job_id:
            lock.unlink()
    except OSError:
        pass


def build_job(spec: dict) -> dict:
    """Validate a request and return its job record. Starts nothing."""
    settings = config.load_settings()
    config.storage_config(settings)                  # refuse now, not inside the worker
    routes = config.proxy_routes(settings)
    kind = spec["kind"]
    if kind == "channel":
        target = parse_channel(spec["target"])
        tabs = [t for t in (spec.get("include") or ["videos"]) if t in TABS]
        if not tabs:
            raise PullError("include must name at least one of: videos, shorts, streams")
    elif kind == "playlist":
        target, tabs = parse_playlist(spec["target"]), []
    elif kind == "video":
        target, tabs = parse_video(spec["target"]), []
    else:
        raise PullError("unknown kind of pull")
    languages = [str(x) for x in (spec.get("languages") or config.DEFAULT_LANGUAGES)][:8]
    if not all(re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*", x) for x in languages):
        raise PullError("languages must be codes such as en, en-GB, es")
    max_videos = int(spec.get("max_videos", config.DEFAULT_MAX_VIDEOS))
    if max_videos < 0 or max_videos > 100_000:
        raise PullError("max_videos must be 0 (no limit) to 100000")
    job = {
        "id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6],
        "kind": kind, "target": target, "include": tabs,
        "max_videos": max_videos, "min_views": max(0, int(spec.get("min_views") or 0)),
        "details": bool(spec.get("details", True)) or int(spec.get("min_views") or 0) > 0,
        "languages": languages,
        "workers": config.clamp_workers(int(spec.get("workers") or 1), len(routes)),
        "delay_ms": config.clamp_delay_ms(int(spec.get("delay_ms") or config.DEFAULT_DELAY_MS)),
        "refresh": bool(spec.get("refresh")), "retry_missing": bool(spec.get("retry_missing")),
        "resumed_from": spec.get("resumed_from") or "",
        "routes": [config.mask_proxy(r) for r in routes],
        "state": "starting", "created": time.time(), "heartbeat": time.time(),
        "counts": {"listed": 0, "selected": 0, "done": 0, "stored": 0, "skipped_existing": 0,
                   "skipped_known_missing": 0, "skipped_min_views": 0, "no_transcript": 0, "failed": 0},
        "failure_reasons": {}, "message": "", "pid": 0,
    }
    return job


def create_job(spec: dict) -> dict:
    """Validate a request, record it, and start its worker. Returns the job record."""
    job = build_job(spec)
    check_cooldown(job)
    return launch(job, Path(__file__).resolve(), PULL_LOCK)


def launch(job: dict, script: Path, lock_name: str) -> dict:
    """Record a job, take its slot and start `script run <id>` as a process of its own."""
    write_job(job)                # before the slot, so whoever reads the slot finds a record
    try:
        _acquire_slot(job["id"], lock_name)
    except Exception:
        _job_path(job["id"]).unlink(missing_ok=True)
        raise
    try:
        log_path = jobs_dir() / f"{job['id']}.log"
        with open(log_path, "ab") as log:
            kw: dict = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": log, "close_fds": True}
            cmd = [sys.executable, str(script), "run", job["id"]]
            if os.name == "nt":
                flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
                try:
                    proc = subprocess.Popen(cmd, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kw)
                except OSError:
                    proc = subprocess.Popen(cmd, creationflags=flags, **kw)
            else:
                proc = subprocess.Popen(cmd, start_new_session=True, **kw)
        job["pid"] = proc.pid
        return job
    except Exception:
        _release_slot(job["id"], lock_name)
        job.update(state="failed", message="the worker could not be started", ended=time.time())
        write_job(job)
        raise


def request_stop(job_id: str) -> dict:
    job = read_job(job_id)
    if effective_state(job) not in ("starting", "running"):
        return {"id": job_id, "state": effective_state(job), "note": "this job is not running"}
    (jobs_dir() / f"{job_id}.stop").write_text("stop", encoding="utf-8")
    return {"id": job_id, "state": "stopping",
            "note": "the worker stops after the request it is on; read its status in a few seconds"}


def shell_command(argv: list) -> str:
    """One line for the platform's usual shell, each word quoted by the platform's own rules."""
    if os.name == "nt":
        # Every word in double quotes: that one form runs in cmd, in Git Bash (which would eat a
        # bare backslash), and in PowerShell with & in front.
        if any('"' in a for a in argv):
            raise PullError("a path with a double quote in it cannot be put in a command")
        return " ".join(f'"{a}"' for a in argv)
    return " ".join(shlex.quote(a) for a in argv)


def wait_command(job_id: str, script: Optional[Path] = None) -> str:
    return shell_command([sys.executable, str(script or Path(__file__).resolve()), "wait", job_id])


def check_cooldown(job: dict) -> None:
    """Refuse a new pull over routes the site has just refused."""
    try:
        cd = json.loads((jobs_dir() / "cooldown.json").read_text(encoding="utf-8"))
        left = float(cd["until"]) - time.time()
        same = set(cd["routes"]) & set(job["routes"])
    except (OSError, ValueError, KeyError, TypeError):
        return
    if left > 0 and same:
        raise PullError(f"the site refused requests from {', '.join(sorted(same))} a short while ago. No pull "
                        f"over that route starts for another {int(left // 60) + 1} minutes. Waiting longer is "
                        "better; a different proxy route is not held back.")


# ---------- listing and fetching (the only code that contacts the site; embed.py is the only
# other code that opens a connection, and only to the embeddings endpoint in the settings) -------


class _Quiet:
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass


def _ydl(proxy: Optional[str], extra: dict):
    from yt_dlp import YoutubeDL
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "logger": _Quiet(),
            "ignoreerrors": True, "socket_timeout": 30}
    if proxy:
        opts["proxy"] = proxy
    opts.update(extra)
    return YoutubeDL(opts)


def _entry(e: dict, kind: str, parent: dict) -> dict:
    date = str(e.get("upload_date") or "")
    if not date and e.get("timestamp"):
        try:
            date = time.strftime("%Y%m%d", time.gmtime(float(e["timestamp"])))
        except (ValueError, OverflowError, OSError):
            date = ""
    return {
        "video_id": e["id"], "title": e.get("title") or "", "kind": kind,
        "duration_seconds": int(e.get("duration") or 0),
        "view_count": int(e.get("view_count") or 0),
        "upload_date": date,
        "channel": e.get("channel") or e.get("uploader") or parent.get("channel") or parent.get("uploader") or "",
        "channel_id": e.get("channel_id") or parent.get("channel_id") or "",
        "channel_handle": e.get("uploader_id") or parent.get("uploader_id") or "",
    }


def list_videos(job: dict, proxy: Optional[str]) -> list:
    """The videos a job covers, newest first as YouTube lists them. No transcripts yet."""
    cap = job["max_videos"]
    end = cap + 20 if cap else None          # a little past the cap, for entries that are not videos
    flat = {"extract_flat": "in_playlist"}
    if end:
        flat["playlistend"] = end
    out: list = []
    if job["kind"] == "video":
        with _ydl(proxy, {}) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={job['target']}", download=False)
        if not info or not info.get("id"):
            raise PullError("that video could not be read: it may be private, removed or region-locked")
        kind = "stream" if info.get("was_live") else "video"
        return [{**_entry(info, kind, {}), "has_details": True}]
    if job["kind"] == "playlist":
        urls = [("video", f"https://www.youtube.com/playlist?list={job['target']}")]
    else:
        urls = [(KIND_OF_TAB[t], f"https://www.youtube.com/{job['target']}/{t}") for t in job["include"]]
    errors = 0
    for kind, url in urls:
        try:
            with _ydl(proxy, flat) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception:  # noqa: BLE001 - a channel with no such tab raises
            info = None
        if not info or "entries" not in info:
            errors += 1
            continue
        for e in info["entries"] or []:
            if e and re.fullmatch(_VIDEO_ID, str(e.get("id") or "")):
                out.append(_entry(e, kind, info))
    if errors == len(urls):
        raise PullError("nothing could be listed: check the address, or the site refused the request")
    seen: dict = {}
    for v in out:
        seen.setdefault(v["video_id"], v)
    return list(seen.values())


def fetch_details(video_id: str, proxy: Optional[str]) -> Optional[dict]:
    """A video's upload date and view count, which a channel listing does not carry. One more
    request to the site per video. None when the page could not be read."""
    with _ydl(proxy, {}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    if not info or not info.get("id"):
        return None
    e = _entry(info, "stream" if info.get("was_live") else "", {})
    out = {k: e[k] for k in ("upload_date", "view_count", "duration_seconds", "channel", "channel_id",
                             "channel_handle") if e[k]}
    if e["kind"]:
        out["kind"] = e["kind"]
    return out


def fetch_transcript(video_id: str, languages: list, proxy: Optional[str]) -> dict:
    """{'segments': [[start, text], ...], 'language', 'is_generated'} or raises."""
    from youtube_transcript_api import YouTubeTranscriptApi
    if proxy:
        from youtube_transcript_api.proxies import GenericProxyConfig
        api = YouTubeTranscriptApi(proxy_config=GenericProxyConfig(http_url=proxy, https_url=proxy))
    else:
        api = YouTubeTranscriptApi()
    fetched = api.fetch(video_id, languages=languages)
    segments = []
    for snip in fetched:
        text = " ".join(str(getattr(snip, "text", "") or "").split())
        if text:
            segments.append([round(float(getattr(snip, "start", 0.0) or 0.0), 2), text])
    return {"segments": segments, "language": getattr(fetched, "language_code", "") or "",
            "is_generated": bool(getattr(fetched, "is_generated", False))}


# ---------- the worker ------------------------------------------------------------


def select_videos(job: dict, listed: list) -> list:
    """The first max_videos as the site lists them, which for a channel is newest first."""
    return list(listed[: job["max_videos"]] if job["max_videos"] else listed)


def run_job(job_id: str, *, lister: Callable = list_videos, fetcher: Callable = fetch_transcript,
            detailer: Callable = fetch_details, sleep: Callable = time.sleep, store=None) -> dict:
    """Do the pull. `lister`, `fetcher`, `detailer` and `sleep` are replaceable so tests touch no network."""
    job = read_job(job_id)
    settings = config.load_settings()
    lock = threading.Lock()
    stop_file = jobs_dir() / f"{job_id}.stop"
    done_evt = threading.Event()

    def save(**changes) -> None:
        with lock:
            job.update(changes)
            job["heartbeat"] = time.time()
            write_job(job)

    def beat() -> None:
        while not done_evt.wait(HEARTBEAT_S):
            save()

    def log(msg: str) -> None:
        print(time.strftime("%H:%M:%S ") + config.scrub(msg, settings), flush=True)

    own_store = store is None
    threading.Thread(target=beat, daemon=True).start()
    try:
        save(state="running", pid=os.getpid(), started=time.time())
        routes = config.proxy_routes(settings)
        if own_store:
            store = store_mod.open_store(config.storage_config(settings))
        source = f"{job['kind']}:{job['target']}"
        log(f"job {job_id}: {source}, routes {[config.mask_proxy(r) for r in routes]}")
        listed = lister(job, routes[0])
        selected = select_videos(job, listed)
        with lock:
            job["counts"]["listed"], job["counts"]["selected"] = len(listed), len(selected)
        save()
        log(f"listed {len(listed)}, selected {len(selected)}")

        queue = list(selected)
        halt = {"state": "", "message": ""}

        def bump(key: str, reason: str = "") -> None:
            with lock:
                job["counts"][key] += 1
                job["counts"]["done"] += 1
                if reason:
                    job["failure_reasons"][reason] = job["failure_reasons"].get(reason, 0) + 1

        def one(v: dict, proxy: Optional[str]) -> str:
            """Handle one video. Returns 'skipped' (nothing was sent), 'answered' (the site gave the
            transcript or a definite no) or 'refused' (it gave neither)."""
            vid = v["video_id"]
            if not job["refresh"] and store.has_video(vid):
                bump("skipped_existing")
                return "skipped"
            miss = None if (job["refresh"] or job["retry_missing"]) else store.get_miss(vid)
            if miss and miss.get("permanent"):
                bump("skipped_known_missing")
                return "skipped"
            if job["details"] and not v.get("has_details"):
                try:
                    extra = detailer(vid, proxy)
                except Exception:  # noqa: BLE001 - the date and views are a nicety; the transcript is the point
                    extra = None
                if extra:
                    v = {**v, **extra}
                if job["min_views"]:
                    if not extra:
                        store.record_miss(vid, "ViewCountUnavailable", False, source)
                        bump("failed", "ViewCountUnavailable")
                        return "refused"
                    if v["view_count"] < job["min_views"]:
                        bump("skipped_min_views")
                        return "answered"
            last = ""
            for attempt in range(3):
                try:
                    got = fetcher(vid, job["languages"], proxy)
                    if not got["segments"]:
                        last = "EmptyTranscript"
                        break
                    store.upsert_video({**v, **got, "source": source, "fetched_at": store_mod.now_iso()})
                    bump("stored")
                    return "answered"
                except Exception as e:  # noqa: BLE001 - classified by name below
                    last = type(e).__name__
                    if last in PERMANENT or last in BLOCKED:
                        break              # a definite no, or a refusal: asking again at once helps nobody
                    if attempt < 2:
                        sleep(2.0 * (2 ** attempt))
            permanent = last in PERMANENT
            store.record_miss(vid, last or "Unknown", permanent, source)
            bump("no_transcript" if permanent else "failed", last or "Unknown")
            return "answered" if permanent else "refused"

        def worker(proxy: Optional[str]) -> None:
            streak = 0                      # this route's own run of videos with no answer
            while True:
                if halt["state"]:
                    return
                if stop_file.exists():
                    with lock:
                        halt["state"] = halt["state"] or "stopped"
                        halt["message"] = halt["message"] or "stopped on request"
                    return
                if slot_holder() not in ("", job_id):
                    with lock:              # this worker was taken for dead and another pull has started
                        halt["state"] = halt["state"] or "stopped"
                        halt["message"] = halt["message"] or "another pull took over; this one stood down"
                    return
                with lock:
                    if not queue:
                        return
                    v = queue.pop(0)
                try:
                    outcome = one(v, proxy)
                except Exception as e:  # noqa: BLE001 - one video must not end the job
                    outcome = "refused"
                    bump("failed", type(e).__name__)
                    log(f"{v['video_id']}: {type(e).__name__}: {e}")
                save()
                if outcome == "answered":
                    streak = 0
                elif outcome == "refused":
                    streak += 1
                    if streak >= BLOCK_STREAK:
                        with lock:
                            if not halt["state"]:
                                halt["state"] = "blocked"
                                halt["message"] = (
                                    f"{BLOCK_STREAK} videos in a row got no answer from the site over "
                                    f"{config.mask_proxy(proxy)}. The pull stopped rather than keep asking. "
                                    "Wait some hours, or set a proxy, then resume: videos already stored are "
                                    "skipped.")
                        return
                if outcome != "skipped" and queue and not halt["state"]:
                    sleep(job["delay_ms"] / 1000.0)

        n = min(job["workers"], len(routes), max(1, len(queue)))
        threads = [threading.Thread(target=worker, args=(routes[i],), daemon=True) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        c = job["counts"]
        if halt["state"]:
            if halt["state"] == "blocked":
                (jobs_dir() / "cooldown.json").write_text(json.dumps(
                    {"until": time.time() + COOLDOWN_S, "routes": job["routes"]}), encoding="utf-8")
            save(state=halt["state"], message=halt["message"], ended=time.time())
        else:
            save(state="done", ended=time.time(),
                 message=f"stored {c['stored']}, already had {c['skipped_existing']}, "
                         f"no transcript {c['no_transcript'] + c['skipped_known_missing']}, failed {c['failed']}")
        log(f"{job['state']}: {job['message']}")
    except PullError as e:
        save(state="failed", message=config.scrub(str(e), settings), ended=time.time())
    except Exception as e:  # noqa: BLE001
        save(state="failed", message=config.scrub(f"{type(e).__name__}: {e}", settings), ended=time.time())
        log(f"failed: {type(e).__name__}: {e}")
    finally:
        done_evt.set()
        if own_store and store is not None:
            store.close()
        try:
            stop_file.unlink()
        except OSError:
            pass
        _release_slot(job_id)
    return job


def wait(job_id: str, poll_s: float = 3.0) -> int:
    while True:
        job = read_job(job_id)
        state = effective_state(job)
        if state not in ("starting", "running"):
            print(f"job {job_id}: {state}. {job.get('message', '')}")
            return {"done": 0, "blocked": 2, "died": 3}.get(state, 1)
        time.sleep(poll_s)


def main(argv: list) -> int:
    if len(argv) == 3 and argv[1] == "run":
        return 0 if run_job(argv[2]).get("state") == "done" else 1
    if len(argv) == 3 and argv[1] == "wait":
        try:
            return wait(argv[2])
        except PullError as e:
            print(str(e), file=sys.stderr)
            return 1
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
