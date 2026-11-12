"""Pulling transcripts: what to pull, the job records, and the worker that does it.

A pull runs as its own process so it outlives the tool call that started it:

    python pull.py run  <job_id>     the worker (started by the server, not by hand)
    python pull.py wait <job_id>     blocks until the job ends; exit 0 done, 1 failed or
                                     stopped, 2 blocked, 3 the worker went quiet, 4 partial

A job ends in one of these states: done; partial (the listing came back short of the count
the site gives, even when listed again over another route. Short means: more than 5 entries
and more than 5% of the count short, or short at all while ending on a whole number of pages
(of 100 for a playlist, 30 for a channel tab). What was listed was pulled, and pull_resume
lists again. A listing that holds max_videos videos is never short); blocked (every route
was taken out); stopped; failed; and died, read from a record that stopped being updated.

Listing uses yt-dlp; transcripts come from youtube-transcript-api. Both are imported only
when a pull actually runs, so search over an existing corpus works without them.
"""
from __future__ import annotations

import json
import os
import random
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
PROXY_REASONS = {"proxy_login": "ProxyLoginRefused", "proxy_unreachable": "ProxyUnreachable",
                 "proxy_setup": "ProxySupportMissing"}
NOT_THE_SITE = set(PROXY_REASONS.values()) | {"ViewCountUnavailable"}    # not counted in refusals_by_route


def pull_install_hint(package: str) -> str:
    return "ask the person before running " + shell_command([sys.executable, "-m", "pip", "install", package])
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


RATE_KEYS = ("workers", "delay_ms", "max_requests_per_minute")     # a pull's own value wins over the settings


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
    # A value on the pull wins; then the settings' pull defaults; then the built-in ones. The
    # limits apply whichever it came from.
    rate = config.pull_rate(settings)
    asked = {k: (int(spec[k]) if spec.get(k) else None) for k in RATE_KEYS}
    top = config.MAX_REQUESTS_PER_MINUTE
    if asked["max_requests_per_minute"] is not None and not 1 <= asked["max_requests_per_minute"] <= top:
        raise PullError(f"max_requests_per_minute must be a whole number from 1 to {top}")
    wanted_workers = asked["workers"] or rate["workers"] or 1
    wanted_delay = asked["delay_ms"] or rate["delay_ms"] or config.DEFAULT_DELAY_MS
    job = {
        "id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6],
        "kind": kind, "target": target, "include": tabs,
        "max_videos": max_videos, "min_views": max(0, int(spec.get("min_views") or 0)),
        "details": bool(spec.get("details", True)) or int(spec.get("min_views") or 0) > 0,
        "languages": languages,
        "workers": config.clamp_workers(wanted_workers, len(routes)),
        "delay_ms": config.clamp_delay_ms(wanted_delay),
        # None: no job-wide limit. Otherwise every worker together sends at most this many
        # requests to the site in any minute (RequestLimit).
        "max_requests_per_minute": asked["max_requests_per_minute"] or rate["max_requests_per_minute"],
        "workers_wanted": wanted_workers, "asked": asked,
        "rate_from": {k: "pull" if asked[k] else "settings" if rate[k] else "default" for k in asked},
        "refresh": bool(spec.get("refresh")), "retry_missing": bool(spec.get("retry_missing")),
        "resumed_from": spec.get("resumed_from") or "",
        "routes": [config.mask_proxy(r) for r in routes], "routes_held_back": [], "routes_out": [],
        "warnings": [], "refusals_by_route": {}, "requests": 0,
        "state": "starting", "created": time.time(), "heartbeat": time.time(),
        # listed: the entries the listing read, before max_videos applied. site_count: how many
        # the site says the playlist or tab holds (None when it gave no count).
        "counts": {"listed": 0, "site_count": None, "selected": 0, "done": 0, "stored": 0, "skipped_existing": 0,
                   "skipped_known_missing": 0, "skipped_min_views": 0, "no_transcript": 0, "failed": 0},
        "failure_reasons": {}, "message": "", "pid": 0,
    }
    return job


def create_job(spec: dict) -> dict:
    """Validate a request, record it, and start its worker. Returns the job record."""
    job = build_job(spec)
    job["routes_held_back"] = check_cooldown(job)
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


def cooling_routes() -> dict:
    """{route as host:port: when its cool-down ends}, for routes still cooling down. A route is put
    here when the site stopped answering over it; other routes are not held back."""
    try:
        cd = json.loads((jobs_dir() / "cooldown.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    now = time.time()
    try:
        if isinstance(cd.get("routes"), list):          # the 0.3.1 form: one time for every route of the job
            pairs = [(r, cd["until"]) for r in cd["routes"]]
        else:
            pairs = list((cd.get("routes") or {}).items())
        return {str(r): float(u) for r, u in pairs if float(u) > now}
    except (AttributeError, KeyError, TypeError, ValueError):
        return {}


_COOLDOWN_LOCK = threading.Lock()      # the workers of the one pull running write it; never two at once


def cool_down(masked_route: str, seconds: float = COOLDOWN_S) -> None:
    """Hold one route back from new pulls for a while. Called by the only pull running."""
    with _COOLDOWN_LOCK:
        held = cooling_routes()
        held[masked_route] = max(held.get(masked_route, 0.0), time.time() + seconds)
        path = jobs_dir() / "cooldown.json"
        tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps({"routes": held}), encoding="utf-8")
        for attempt in range(6):          # a reader on Windows can hold the file for a moment
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))
        os.replace(tmp, path)


def check_cooldown(job: dict) -> list:
    """Refuse a new pull when every route it could use is cooling down after the site refused it.
    Returns the routes held back, which the pull then leaves out; the rest are used."""
    held = cooling_routes()
    mine = [r for r in job["routes"] if r in held]
    if mine and len(mine) == len(job["routes"]):
        left = min(held[r] for r in mine) - time.time()
        what = ("this address" if mine == ["direct"] else
                "every proxy route set (" + ", ".join(sorted(set(mine))) + ")")
        raise PullError(f"the site stopped answering over {what} a short while ago. No pull over a route starts "
                        f"until its cool-down ends; the first ends in {int(left // 60) + 1} minutes. Waiting "
                        "longer is better.")
    return sorted(set(mine))


# ---------- listing and fetching (the only code that contacts the site; embed.py is the only
# other code that opens a connection, and only to the embeddings endpoint in the settings) -------


class _Quiet:
    """yt-dlp's logger. Prints nothing, and keeps the last errors and warnings so that a failure
    can be explained: with ignoreerrors on, yt-dlp returns None and says why only here."""
    KEEP = 20

    def __init__(self):
        self.errors: list = []
        self.warnings: list = []

    def debug(self, msg): pass
    def info(self, msg): pass

    def warning(self, msg):
        self.warnings = (self.warnings + [str(msg)])[-self.KEEP:]

    def error(self, msg):
        self.errors = (self.errors + [str(msg)])[-self.KEEP:]


def _ydl(proxy: Optional[str], extra: dict, logger: Optional[_Quiet] = None):
    from yt_dlp import YoutubeDL
    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "logger": logger or _Quiet(),
            "ignoreerrors": True, "socket_timeout": 30}
    if proxy:
        opts["proxy"] = proxy
    opts.update(extra)
    return YoutubeDL(opts)


# What yt-dlp or the transcript library said, sorted into causes a person can act on. Checked in
# this order: a proxy failure is named first, because it hides every other cause.
_CAUSES = (
    # Specific phrases only: a bare "407" can be part of a video id, and every requests error over a
    # SOCKS proxy names its SOCKSHTTPSConnectionPool, so neither alone says the proxy failed.
    ("proxy_setup", ("missing dependencies for socks",)),
    ("proxy_login", ("407 proxy authentication", "http error 407", "tunnel connection failed: 407",
                     "tunnel failed, response 407",
                     "proxy authentication required", "proxy authentication failed",
                     "socks5 authentication failed", "socks5 authentication error")),
    ("proxy_unreachable", ("unable to connect to proxy", "tunnel connection failed", "cannot connect to proxy",
                           "caused by proxyerror", "socks5proxyerror", "socks4proxyerror", "generalproxyerror",
                           "socks proxy")),
    ("bot_check", ("sign in to confirm", "confirm you're not a bot", "confirm you are not a bot")),
    ("region", ("not available in your country", "blocked it in your country", "geo restrict",
                "not made this video available in your country")),
    ("unavailable", ("private video", "video unavailable", "this video has been removed", "has been terminated",
                     "this video is no longer available", "does not exist", "members-only", "join this channel")),
    ("network", ("timed out", "connection refused", "name or service not known", "getaddrinfo failed",
                 "nodename nor servname", "network is unreachable", "connection reset")),
)


def classify(messages: list, proxy: Optional[str]) -> str:
    """The cause behind a list of error messages: one of the names in _CAUSES, or ''."""
    text = " ".join(str(m) for m in messages).lower()
    for cause, words in _CAUSES:
        if cause.startswith("proxy") and not proxy:
            continue
        if any(w in text for w in words):
            return cause
    return ""


def explain(cause: str, proxy: Optional[str], what: str) -> str:
    """A message for the person. Names the route as host:port only."""
    route = config.mask_proxy(proxy)
    return {
        "proxy_login": f"the proxy {route} refused the login: check the user name and password in PROXY_URL or "
                       f"PROXY_URLS ({config.ENCODE_HINT}). proxy_test checks every route",
        "proxy_unreachable": f"the proxy {route} could not be reached or would not open the connection: check its "
                             "host and port, and that the proxy plan is active. proxy_test checks every route",
        "proxy_setup": "a SOCKS proxy is set, and SOCKS needs the PySocks package, which is not installed in "
                       f"the Python the server uses: {pull_install_hint('PySocks')}",
        "bot_check": f"the site asked for a sign-in to prove this is not a bot, over {route}. That is the site "
                     "refusing this address: wait some hours, or use other proxy routes",
        "region": f"{what} is not available in the country of {route}",
        "unavailable": f"{what} is private, removed, members-only or does not exist",
        "network": f"the connection over {route} failed or timed out: check this machine's network"
                   + (" and the proxy" if proxy else ""),
    }.get(cause, "")


def _failure(log: _Quiet, proxy: Optional[str], what: str, fallback: str) -> PullError:
    """The PullError for a read that came back empty: the classified cause, or yt-dlp's own last
    words (with every configured credential filtered out), or the fallback."""
    cause = classify(log.errors, proxy)
    if cause:
        return PullError(explain(cause, proxy, what))
    last = next((m for m in reversed(log.errors) if m.strip()), "")
    if last:
        return PullError(f"{fallback}. yt-dlp said: " + config.scrub(last)[:300])
    return PullError(fallback)


def _note_warnings(job: dict, log: _Quiet) -> None:
    """yt-dlp's own warnings (for example that it is out of date) go into the job record, each once."""
    notes = job.setdefault("warnings", [])
    for w in log.warnings:
        line = "yt-dlp: " + config.scrub(w)[:300]
        if line not in notes and len(notes) < 12:
            notes.append(line)


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


def cut_short(n: int, site_count, end: Optional[int], page: int) -> str:
    """A warning when a listing looks cut off, else ''. An out-of-date yt-dlp stops at the end of
    the first page (100 for a playlist, 30 for a channel tab) and says nothing; a current one does
    the same when the site refuses the request for the next page. `n` counts what the listing
    returned, `site_count` is the total the site reported (None when it gave none) and `end` the
    cap asked for (None for no cap)."""
    if n <= 0 or (end and n >= end):
        return ""
    whole_pages = n % page == 0
    total = _count(site_count)
    fix = ("An out-of-date yt-dlp does this (setup_check prints the upgrade command), and so does a current one "
           "when the site refuses the request for the next page. Videos already stored are skipped when the "
           "pull is resumed.")
    if total is not None and n < total and (whole_pages or total - n > max(5, total // 20)):
        return f"listed {n} of the {total} videos the site says it holds, so the listing may have been cut short. {fix}"
    if total is None and whole_pages:
        return (f"listed exactly {n} videos, a whole number of the site's pages of {page}, so the listing may have "
                f"been cut short. {fix}")
    return ""


def _count(value) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def list_videos(job: dict, proxy: Optional[str], take: Callable = lambda: None) -> list:
    """The videos a job covers, newest first as YouTube lists them. No transcripts yet.

    take() is called before each call to the site (one per playlist, per channel tab, or for the
    one video): the pull's request limit. It may raise _Halted, which is passed on.

    Also sets job['listing']: site_count (the total the site gave, summed over the tabs when
    every tab gave one, else None), short (a playlist or tab came back short of the site's own
    count, by cut_short's measure: more than 5 entries and 5% short, or short and ending on a
    whole page), short_notes (the warnings that
    said so), short_detail (what was short, for the end message) and errors (yt-dlp's own
    error lines during the listing, with credentials filtered out)."""
    cap = job["max_videos"]
    end = cap + 20 if cap else None          # a little past the cap, for entries that are not videos
    flat = {"extract_flat": "in_playlist"}
    if end:
        flat["playlistend"] = end
    out: list = []
    log = _Quiet()
    listing: dict = {"site_count": None, "short": False, "short_notes": [], "short_detail": [], "errors": []}
    job["listing"] = listing
    if job["kind"] == "video":
        take()
        with _ydl(proxy, {}, log) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={job['target']}", download=False)
        _note_warnings(job, log)
        listing["errors"] = [config.scrub(m)[:300] for m in log.errors]
        if not info or not info.get("id"):
            raise _failure(log, proxy, "that video", "that video could not be read")
        kind = "stream" if info.get("was_live") else "video"
        return [{**_entry(info, kind, {}), "has_details": True}]
    if job["kind"] == "playlist":
        urls = [("video", f"https://www.youtube.com/playlist?list={job['target']}")]
    else:
        urls = [(KIND_OF_TAB[t], f"https://www.youtube.com/{job['target']}/{t}") for t in job["include"]]
    errors = 0
    counts: list = []
    for kind, url in urls:
        take()                             # outside the try: a stop while waiting is not a failed tab
        try:
            with _ydl(proxy, flat, log) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as e:  # noqa: BLE001 - a channel with no such tab raises
            log.error(f"{type(e).__name__}: {e}")
            info = None
        if not info or "entries" not in info:
            errors += 1
            counts.append(None)
            continue
        raw = [e for e in (info["entries"] or []) if e]
        for e in raw:
            if re.fullmatch(_VIDEO_ID, str(e.get("id") or "")):
                out.append(_entry(e, kind, info))
        total = _count(info.get("playlist_count"))
        counts.append(total)
        name = url.rsplit('/', 1)[-1] if job['kind'] == 'channel' else 'the playlist'
        note = cut_short(len(raw), total, end, page=30 if job["kind"] == "channel" else 100)
        if note:
            if f"{name}: {note}" not in job.setdefault("warnings", []):
                job["warnings"].append(f"{name}: {note}")
            if total is not None:          # fewer than the site's own count; without a count it is a guess
                listing["short"] = True
                listing["short_notes"].append(f"{name}: {note}")
                listing["short_detail"].append(f"{name}: listed {len(raw)} of {total}")
    _note_warnings(job, log)
    listing["errors"] = [config.scrub(m)[:300] for m in log.errors]
    if counts and all(c is not None for c in counts):
        listing["site_count"] = sum(counts)
    if errors == len(urls):
        raise _failure(log, proxy, "that address",
                       "nothing could be listed: check the address, or the site refused the request")
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


PROBE_URL = "https://www.youtube.com/"     # the one address proxy_test asks for, a HEAD request
PROBE_TIMEOUT_S = 10


def _probe_send(proxy: str) -> int:
    """One HEAD request to PROBE_URL through `proxy`. Returns the status the site answered with."""
    import requests
    with requests.Session() as s:
        s.trust_env = False        # never NO_PROXY or a proxy from the environment: this route, or nothing
        r = s.head(PROBE_URL, proxies={"http": proxy, "https": proxy}, timeout=PROBE_TIMEOUT_S,
                   allow_redirects=False)
        return int(r.status_code)


def probe_result(exc: Optional[BaseException], status: int = 0) -> str:
    """ok, login refused (407), unreachable, timeout or error, from what one probe did. The
    exception is judged by its class names and text, which never leave this function."""
    if exc is None:
        return "login refused (407)" if status == 407 else "ok"
    names = " ".join(c.__name__ for c in type(exc).__mro__).lower()
    text = f"{names} {exc}".lower()
    cause = classify([text], "probe")
    if cause == "proxy_login":
        return "login refused (407)"
    if cause == "proxy_setup":
        return "error: SOCKS needs the PySocks package"
    if "timeout" in names or "timed out" in text:
        return "timeout"
    if any(w in names for w in ("proxyerror", "connectionerror", "oserror")):
        return "unreachable"
    return "error"


def probe_routes(routes: list, send: Callable = _probe_send) -> list:
    """proxy_test: one request per route, in parallel (each route is a different exit address).
    Returns one row per route, as host:port only, in the order of the settings."""
    from concurrent.futures import ThreadPoolExecutor

    def one(proxy: str) -> dict:
        row = {"route": config.mask_proxy(proxy)}
        try:
            status = send(proxy)
            row["result"] = probe_result(None, status)
            row["status"] = status
        except Exception as e:  # noqa: BLE001 - every outcome is a row, never an error out of the tool
            row["result"] = probe_result(e)
            row["error_type"] = type(e).__name__
        return row

    with ThreadPoolExecutor(max_workers=max(1, min(config.MAX_WORKERS, len(routes)))) as ex:
        return list(ex.map(one, routes))


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


class _Halted(Exception):
    """A worker was waiting for its turn under the request limit and the pull is ending."""


class RequestLimit:
    """A limit on requests to the site for the whole pull, shared by all of its workers.

    A request is one call to the site by this code: one listing, one read of a video's page, one
    transcript fetch attempt (each retry is another). A token bucket that holds one token, refilled
    every 60 / per_minute seconds: each request takes the token, so requests are at least that far
    apart and no 60-second window holds more than per_minute of them, whatever the workers' own
    delay. A turn is given when the clock says the token is there, never booked ahead, so a worker
    that wakes late cannot bring two requests closer together. `clock` and `sleep` are replaceable
    so tests need not wait. per_minute None: no limit, and nothing waits."""
    LONGEST_NAP_S = 5.0          # a waiting worker looks this often for a stop request

    def __init__(self, per_minute: Optional[int], clock: Callable = time.monotonic, sleep: Callable = time.sleep):
        self.per_minute = int(per_minute) if per_minute else None
        self.interval = 60.0 / self.per_minute if self.per_minute else 0.0
        self.clock, self.sleep = clock, sleep
        self.count = 0
        self.first: Optional[float] = None     # the clock at the earliest and the latest turn given
        self.last: Optional[float] = None
        self._next: Optional[float] = None
        self._lock = threading.Lock()

    def take(self, stopping: Callable = lambda: False) -> None:
        """Wait for the token, then count one request. Raises _Halted when `stopping` says so first."""
        while True:
            with self._lock:
                now = self.clock()
                if not self.interval or self._next is None or now >= self._next:
                    if self.interval:
                        self._next = now + self.interval + 1e-6     # never closer, whatever the rounding
                    self.count += 1
                    self.first = now if self.first is None else min(self.first, now)
                    self.last = now if self.last is None else max(self.last, now)
                    return
                wait = self._next - now
            if stopping():
                raise _Halted()
            self.sleep(min(wait, self.LONGEST_NAP_S))


def limit_in_force(job: dict) -> Optional[int]:
    """The request limit a job runs with: None when the record holds none (no limit), else a whole
    number from 1 to MAX_REQUESTS_PER_MINUTE. A record edited to something that is not a number, or
    to anything under 1 (0, a fraction, a negative), gets the slowest pace, 1 a minute: never none."""
    v = job.get("max_requests_per_minute")
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 1
    if not f >= 1:                     # also NaN
        return 1
    return int(min(f, config.MAX_REQUESTS_PER_MINUTE))


def jittered(delay_ms: int, rand: Callable = random.random) -> float:
    """The pause after a request, in seconds: delay_ms plus a random 0 to 50% of it, so that requests do
    not arrive on a fixed beat. Never less than delay_ms, and never under the floor whatever the job
    record says."""
    return config.clamp_delay_ms(delay_ms) / 1000.0 * (1.0 + 0.5 * min(1.0, max(0.0, rand())))


def select_videos(job: dict, listed: list) -> list:
    """The first max_videos as the site lists them, which for a channel is newest first."""
    return list(listed[: job["max_videos"]] if job["max_videos"] else listed)


def blocked_message(out: list) -> str:
    """Why a pull stopped once every route was out. `out` holds (route, last reason) pairs."""
    tail = " Then pull_resume: videos already stored are skipped."
    if out == [(None, out[0][1])]:
        return (f"{BLOCK_STREAK} videos in a row got no answer from the site over your own address. The pull "
                "stopped rather than keep asking. Wait some hours, or set a proxy in the settings file." + tail)
    names = ", ".join(f"{config.mask_proxy(r)} ({why})" for r, why in out)
    if all(why in PROXY_REASONS.values() for _, why in out):
        return (f"every proxy route was taken out because the proxy itself failed: {names}. "
                "ProxyLoginRefused means the proxy refused the user name or password; ProxyUnreachable that it "
                "could not be reached. Check PROXY_URL or PROXY_URLS; proxy_test checks each route." + tail)
    return (f"every route was taken out after {BLOCK_STREAK} videos in a row got no answer over it: {names}. The "
            "pull stopped rather than keep asking. Routes the site refused are held back from new pulls for "
            f"{COOLDOWN_S // 60} minutes. Wait for your proxy provider to give those ports new addresses (with "
            "sticky sessions that is often within the hour), or wait some hours." + tail)


def run_job(job_id: str, *, lister: Callable = list_videos, fetcher: Callable = fetch_transcript,
            detailer: Callable = fetch_details, sleep: Callable = time.sleep, store=None,
            clock: Callable = time.monotonic, rand: Callable = random.random) -> dict:
    """Do the pull. `lister`, `fetcher`, `detailer`, `sleep`, `clock` and `rand` are replaceable so
    tests touch no network and never wait."""
    job = read_job(job_id)
    settings = config.load_settings()
    lock = threading.Lock()
    stop_file = jobs_dir() / f"{job_id}.stop"
    done_evt = threading.Event()
    limit = limit_in_force(job)
    rate = RequestLimit(limit, clock=clock, sleep=sleep)

    def save(**changes) -> None:
        with lock:
            job.update(changes)
            job["requests"] = rate.count
            if rate.count >= 2 and rate.last > rate.first:      # from the first request to the latest
                job["request_span_seconds"] = round(rate.last - rate.first, 3)
            job["heartbeat"] = time.time()
            write_job(job)

    def beat() -> None:
        while not done_evt.wait(HEARTBEAT_S):
            save()

    def log(msg: str) -> None:
        print(time.strftime("%H:%M:%S ") + config.scrub(msg, settings), flush=True)

    def listing_over(proxy: Optional[str]) -> tuple:
        """One listing over `proxy`: (the videos, what list_videos recorded about it). The lister takes a
        turn of the request limit before each call it makes to the site (one per playlist or tab); a stop
        request seen while it waits raises _Halted. yt-dlp's own errors during the listing go to the log."""
        job["listing"] = {}
        got = lister(job, proxy, take=lambda: rate.take(stop_file.exists))
        info = dict(job.get("listing") or {})
        for err in info.get("errors") or []:
            log(f"listing over {config.mask_proxy(proxy)}: yt-dlp: {err}")
        return got, info

    own_store = store is None
    threading.Thread(target=beat, daemon=True).start()
    try:
        save(state="running", pid=os.getpid(), started=time.time())
        routes = config.proxy_routes(settings)
        if own_store:
            store = store_mod.open_store(config.storage_config(settings))
        source = f"{job['kind']}:{job['target']}"
        held = cooling_routes()
        usable = [r for r in routes if config.mask_proxy(r) not in held]
        held_back = sorted({config.mask_proxy(r) for r in routes if config.mask_proxy(r) in held})
        save(routes_held_back=held_back)
        log(f"job {job_id}: {source}, routes {[config.mask_proxy(r) for r in usable]}"
            + (f", held back while they cool down: {held_back}" if held_back else "")
            + (f", at most {limit} requests a minute in all" if limit else ""))
        if not usable:
            save(state="blocked", ended=time.time(),
                 message="every route is cooling down after the site stopped answering over it. Wait, then resume.")
            log(job["message"])
            return job
        cap = job["max_videos"]
        listed, info = listing_over(usable[0])
        first_notes = list(info.get("short_notes") or [])
        first_detail = list(info.get("short_detail") or [])
        # A playlist or tab that came back short of the site's own count (cut_short) is listed
        # once more, over the next route that is not cooling down (the route just used may have been
        # refused the next page). A short listing that still holds max_videos videos cost nothing.
        short = bool(info.get("short")) and not (cap and len(listed) >= cap)
        listed_over = [config.mask_proxy(usable[0])]
        if short:
            for w in first_notes:
                log(f"warning: {w}")
            cooling = cooling_routes()
            other = next((r for r in usable[1:] if config.mask_proxy(r) not in cooling), None)
            if other is None:
                log("the listing may have been cut short, and there is no other route to list it again over")
            else:
                listed_over.append(config.mask_proxy(other))
                log(f"the listing may have been cut short: listing it again over {listed_over[1]}")
                try:
                    again, info2 = listing_over(other)
                except _Halted:
                    raise                  # stopped while waiting for its turn: nothing more is sent
                except Exception as e:  # noqa: BLE001 - the first listing still stands
                    again, info2 = [], {}
                    log(f"listing again over {listed_over[1]} failed: {e if isinstance(e, PullError) else type(e).__name__ + ': ' + str(e)}")
                first_len = len(listed)
                have = {v["video_id"] for v in listed}
                listed = list(listed) + [v for v in again if v["video_id"] not in have]
                if len(again) > first_len:     # the longer listing's order: it holds the newest first
                    have = {v["video_id"] for v in again}
                    listed = list(again) + [v for v in listed if v["video_id"] not in have]
                # Judged on everything listed, against the largest count either listing gave. Only a
                # second listing longer than the first can show that the first was what was cut.
                seen_counts = [c for c in (info.get("site_count"), info2.get("site_count")) if c is not None]
                most = max(seen_counts) if seen_counts else None
                page = 30 if job["kind"] == "channel" else 100
                whole = len(again) > first_len and most is not None and not cut_short(len(listed), most, None, page)
                short = not whole and not (cap and len(listed) >= cap)
                info = {**info, "site_count": most, "short": short,
                        "short_detail": [f"listed {len(listed)} of {most}"] if most is not None else first_detail}
                log(f"listed again over {listed_over[1]}: {len(again)}; {len(listed)} in all"
                    + ("" if short else ", so the listing is taken as whole"))
                if not short:              # the first listing's cut-short warnings no longer hold
                    job["warnings"] = [w for w in job.get("warnings") or [] if w not in first_notes]
                    job["warnings"].append(f"the first listing, over {listed_over[0]}, looked cut short ("
                                           + "; ".join(first_detail)
                                           + f"); listed again over {listed_over[1]}: {len(listed)} in all")
        for w in job.get("warnings") or []:
            if w not in first_notes:
                log(f"warning: {w}")
        selected = select_videos(job, listed)
        site = info.get("site_count")
        with lock:
            job["counts"]["listed"], job["counts"]["selected"] = len(listed), len(selected)
            job["counts"]["site_count"] = site
        save()
        log(f"listed {len(listed)}" + (f" of {site}" if site is not None else "") + f", selected {len(selected)}")

        queue = list(selected)
        halt = {"state": "", "message": ""}
        # Routes: each worker holds one, and no route is ever held by two workers at once. Routes
        # beyond the number of workers stand by. A route over which BLOCK_STREAK videos in a row
        # got no answer is taken out for the rest of the job, and a standby route, if any is
        # left, takes its worker over. The job ends blocked only when every route is out.
        n = min(job["workers"], len(usable), max(1, len(queue)))
        spare = list(usable[n:])
        out: list = []                     # (route, the last reason seen over it)
        reasons_seen: set = set()
        refusals = job.setdefault("refusals_by_route", {})    # host:port: refusals that did not take it out

        def stopping() -> bool:
            return bool(halt["state"]) or stop_file.exists()

        def bump(key: str, reason: str = "") -> None:
            with lock:
                job["counts"][key] += 1
                job["counts"]["done"] += 1
                if reason:
                    job["failure_reasons"][reason] = job["failure_reasons"].get(reason, 0) + 1

        def note(proxy: Optional[str], reason: str, detail: str) -> None:
            """The first time a reason is seen over a route, say so in the log."""
            key = (config.mask_proxy(proxy), reason)
            with lock:
                if key in reasons_seen:
                    return
                reasons_seen.add(key)
            log(f"over {key[0]}: {reason}: {detail}"[:400])

        def let_off(proxy: Optional[str], run: list) -> None:
            """A run of videos with no answer that ended without taking its route out is counted against
            the route. Only the site's own silence counts: not the proxy failing, not an unreadable page
            under min_views, not an error of this code or the store."""
            k = sum(1 for _, site_said_nothing in run if site_said_nothing)
            if k:
                masked = config.mask_proxy(proxy)
                with lock:
                    refusals[masked] = refusals.get(masked, 0) + k

        def one(v: dict, proxy: Optional[str], last_reason: list) -> str:
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
                rate.take(stopping)
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
                        last_reason[0] = "ViewCountUnavailable"
                        return "refused"
                    if v["view_count"] < job["min_views"]:
                        bump("skipped_min_views")
                        return "answered"
            last = ""
            for attempt in range(3):
                rate.take(stopping)
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
                    cause = classify([f"{last}: {e}"], proxy) if last not in PERMANENT | BLOCKED else ""
                    if cause in PROXY_REASONS:
                        last = PROXY_REASONS[cause]
                    note(proxy, last, explain(cause, proxy, "the video") or config.scrub(f"{e}", settings)[:300])
                    if last in PERMANENT or last in BLOCKED or last in PROXY_REASONS.values():
                        break              # a definite no, or a refusal: asking again at once helps nobody
                    if attempt < 2:
                        sleep(2.0 * (2 ** attempt))
            permanent = last in PERMANENT
            store.record_miss(vid, last or "Unknown", permanent, source)
            bump("no_transcript" if permanent else "failed", last or "Unknown")
            last_reason[0] = last or "Unknown"
            return "answered" if permanent else "refused"

        def take_out(proxy: Optional[str], reasons: list) -> Optional[list]:
            """Take a route out of this job. `reasons` are those of the run of refusals that took it
            out. Returns [the standby route] to carry on with, [] when there is none for this
            worker, or None when that was the last route in."""
            masked = config.mask_proxy(proxy)
            proxy_only = bool(reasons) and all(r in PROXY_REASONS.values() for r in reasons)
            reason = reasons[-1] if proxy_only else next(r for r in reversed(reasons) if r not in PROXY_REASONS.values())
            with lock:
                out.append((proxy, reason))
                job["routes_out"] = job.get("routes_out", []) + [masked]
                last_in = len(out) >= len(usable)
                nxt = [] if last_in or not spare else [spare.pop(0)]
            if not proxy_only:
                cool_down(masked)          # the site refused it at least once: other pulls leave it alone a while
            log(f"route {masked} taken out: "
                + (f"the proxy itself failed {BLOCK_STREAK} times in a row ({reason}); the site was not asked"
                   if proxy_only else f"{BLOCK_STREAK} videos in a row got no answer over it ({reason})")
                + (f"; {config.mask_proxy(nxt[0])} takes over" if nxt else ""))
            save()
            return None if last_in else nxt

        def work(w: dict) -> None:
            """One worker. w holds its route and that route's own run of videos with no answer (their
            reasons), so that whatever is left of the run when the worker ends can be counted."""
            last_reason = [""]
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
                ours = False                # the failure was this code's or the store's, not the site's
                try:
                    outcome = one(v, w["proxy"], last_reason)
                except _Halted:
                    continue                # waiting for its turn when the pull began to end: the loop's top says why
                except Exception as e:  # noqa: BLE001 - one video must not end the job
                    outcome, ours = "refused", True
                    last_reason[0] = type(e).__name__
                    bump("failed", type(e).__name__)
                    log(f"{v['video_id']}: {type(e).__name__}: {e}")
                save()
                if outcome == "answered":
                    let_off(w["proxy"], w["run"])
                    w["run"] = []
                elif outcome == "refused":
                    why = last_reason[0] or "Unknown"
                    w["run"].append((why, not ours and why not in NOT_THE_SITE))
                    if len(w["run"]) >= BLOCK_STREAK:
                        run, w["run"] = w["run"], []        # this run takes the route out: not counted again
                        nxt = take_out(w["proxy"], [r for r, _ in run])
                        if nxt is None:
                            with lock:
                                if not halt["state"]:
                                    halt["state"] = "blocked"
                                    halt["message"] = blocked_message(out)
                            return
                        if not nxt:
                            return          # the other workers carry on over their own routes
                        w["proxy"] = nxt[0]
                if outcome != "skipped" and queue and not halt["state"]:
                    sleep(jittered(job["delay_ms"], rand))

        def worker(proxy: Optional[str]) -> None:
            w = {"proxy": proxy, "run": []}
            try:
                work(w)
            finally:
                let_off(w["proxy"], w["run"])

        threads = [threading.Thread(target=worker, args=(usable[i],), daemon=True) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        c = job["counts"]
        warn = "".join(f". Warning: over {'your own address' if r == 'direct' else r}, {k} video{'s' if k != 1 else ''} "
                       f"got no answer from the site without the route being taken out"
                       for r, k in sorted(refusals.items()) if k)
        if halt["state"]:
            save(state=halt["state"], message=halt["message"] + warn, ended=time.time())
        else:
            msg = (f"stored {c['stored']}, already had {c['skipped_existing']}, "
                   f"no transcript {c['no_transcript'] + c['skipped_known_missing']}, failed {c['failed']}")
            if out:
                msg += (f". {len(out)} of {len(usable)} routes were taken out: "
                        + ", ".join(f"{config.mask_proxy(r)} ({why})" for r, why in out)
                        + f". The other routes finished the pull. The {BLOCK_STREAK * len(out)} videos that failed over "
                        "the routes taken out are counted in failed; pull_resume tries them again")
            if cap and len(selected) >= cap:
                tabs = job.get("include") or []
                what = ("the playlist" if job["kind"] == "playlist" else
                        f"the channel's {', '.join(tabs)} tab{'s' if len(tabs) > 1 else ''}")
                if site is not None and site > len(selected):
                    msg += f"; {what} has {site}; {site - len(selected)} not tried because of max_videos={cap}"
                elif len(listed) > len(selected):
                    msg += f"; at least {len(listed) - len(selected)} more not tried because of max_videos={cap}"
            if short:
                cut = (f"listed {len(listed)} of {site}" if site is not None
                       else "; ".join(info.get("short_detail") or []) or f"listed {len(listed)}")
                over = (f", over {listed_over[0]} and again over {listed_over[1]}" if len(listed_over) > 1 else
                        f" over {listed_over[0]}, and there was no other route to list it again over")
                save(state="partial", ended=time.time(),
                     message=(f"{cut}: the listing may have been cut short{over}. The videos listed were pulled: {msg}. "
                              "pull_resume tries the listing again" + warn))
            else:
                save(state="done", ended=time.time(), message=msg + warn)
        log(f"{job['state']}: {job['message']}")
    except _Halted:
        save(state="stopped", message="stopped on request, while the listing waited for its turn", ended=time.time())
        log(f"stopped: {job['message']}")
    except PullError as e:
        save(state="failed", message=config.scrub(str(e), settings), ended=time.time())
        log(f"failed: {e}")
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


# How a job ended, as an exit code: `wait` returns these, and so does the worker process (`run`), whose
# own exit code nobody reads but is kept the same. Anything else (failed, stopped): 1.
EXIT_CODES = {"done": 0, "blocked": 2, "died": 3, "partial": 4}


def wait(job_id: str, poll_s: float = 3.0) -> int:
    while True:
        job = read_job(job_id)
        state = effective_state(job)
        if state not in ("starting", "running"):
            print(f"job {job_id}: {state}. {job.get('message', '')}")
            return EXIT_CODES.get(state, 1)
        time.sleep(poll_s)


def main(argv: list) -> int:
    if len(argv) == 3 and argv[1] == "run":
        return EXIT_CODES.get(run_job(argv[2]).get("state"), 1)
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
