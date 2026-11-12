"""Settings for expertise-miner: the data folder, storage, proxy routes and the embeddings endpoint.

Everything comes from the process environment, or from a `.env` file in the data folder
(`~/.expertise-miner/.env` unless EXPERTISE_MINER_HOME says otherwise). The process
environment wins. A `.env` in the current project folder is deliberately NOT read: a cloned
repository must not be able to choose the proxy your requests go through.
"""
from __future__ import annotations

import ipaddress
import os
import re
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlsplit

MAX_WORKERS = 8
DEFAULT_DELAY_MS = 1500
MIN_DELAY_MS = 500
DEFAULT_MAX_VIDEOS = 50
DEFAULT_LANGUAGES = ("en", "en-US", "en-GB")

_KEYS = (
    "EXPERTISE_MINER_STORE", "EXPERTISE_MINER_DB",
    "MONGO_URI", "MONGO_HOST", "MONGO_PORT", "MONGO_USER", "MONGO_PASS",
    "MONGO_AUTH_SOURCE", "MONGO_DB", "MONGO_COLLECTION",
    "PROXY_URL", "PROXY_URLS", "PROXY_PORT_COUNT",
    "EXPERTISE_MINER_SEARCH_STEMMING", "EXPERTISE_MINER_SEARCH_MATCH",
    "EXPERTISE_MINER_EMBED_URL", "EXPERTISE_MINER_EMBED_KEY", "EXPERTISE_MINER_EMBED_MODEL",
    "EXPERTISE_MINER_EMBED_BATCH",
)


def home_dir() -> Path:
    raw = os.environ.get("EXPERTISE_MINER_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".expertise-miner"


def _read_env_file(path: Path) -> dict:
    out: dict = {}
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return out
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        k = k.strip()
        if k.startswith("export "):
            k = k[7:].strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k] = v
    return out


_EMBED_KEYS = ("EXPERTISE_MINER_EMBED_URL", "EXPERTISE_MINER_EMBED_KEY", "EXPERTISE_MINER_EMBED_MODEL",
               "EXPERTISE_MINER_EMBED_BATCH")


def load_settings() -> dict:
    """The named settings only, the environment over the data folder's .env.

    The embeddings settings are taken as a set from one place: if the environment holds any of
    them, the .env file's are ignored, all of them. Otherwise an address from one source could
    be sent the key from the other."""
    file_vals = _read_env_file(home_dir() / ".env")
    embed_from_env = any((os.environ.get(k) or "").strip() for k in _EMBED_KEYS)
    out: dict = {}
    for k in _KEYS:
        v = os.environ.get(k)
        if k in _EMBED_KEYS:
            v = (v or "") if embed_from_env else file_vals.get(k, "")
        elif v is None or v == "":
            v = file_vals.get(k, "")
        out[k] = v.strip()
    return out


# ---------- search ----------------------------------------------------------


def _switch(name: str, raw: str, default: bool) -> bool:
    v = raw.lower()
    if v == "":
        return default
    if v in ("on", "true", "yes", "1"):
        return True
    if v in ("off", "false", "no", "0"):
        return False
    raise ValueError(f"{name} must be on or off")


def search_config(settings: Optional[dict] = None) -> dict:
    """How search behaves unless a call says otherwise.

    stemming  on: a word also finds its other forms (check, checks, checking). English rules.
    match     ranked: passages holding more of the words, and rarer words, come first;
              all: only passages holding every word.
    """
    s = settings if settings is not None else load_settings()
    match = (s["EXPERTISE_MINER_SEARCH_MATCH"] or "ranked").lower()
    if match not in ("ranked", "all"):
        raise ValueError("EXPERTISE_MINER_SEARCH_MATCH must be 'ranked' or 'all'")
    return {"stemming": _switch("EXPERTISE_MINER_SEARCH_STEMMING", s["EXPERTISE_MINER_SEARCH_STEMMING"], True),
            "match": match}


# ---------- storage ---------------------------------------------------------


def storage_config(settings: Optional[dict] = None) -> dict:
    """SQLite unless EXPERTISE_MINER_STORE=mongo. Mongo settings present in the environment
    for some other tool are never picked up by accident."""
    s = settings if settings is not None else load_settings()
    kind = (s["EXPERTISE_MINER_STORE"] or "sqlite").lower()
    if kind not in ("sqlite", "mongo"):
        raise ValueError("EXPERTISE_MINER_STORE must be 'sqlite' or 'mongo'")
    if kind == "sqlite":
        raw = s["EXPERTISE_MINER_DB"]
        path = Path(raw).expanduser() if raw else home_dir() / "corpus.db"
        return {"kind": "sqlite", "path": str(path), "stemming": search_config(s)["stemming"]}
    if not (s["MONGO_URI"] or s["MONGO_HOST"]):
        raise ValueError("EXPERTISE_MINER_STORE=mongo needs MONGO_URI, or MONGO_HOST and its companions")
    port = s["MONGO_PORT"] or "27017"
    if not port.isdigit():
        raise ValueError("MONGO_PORT must be a number")
    for name in ("MONGO_DB", "MONGO_COLLECTION"):
        if s[name] and not re.fullmatch(r"[A-Za-z0-9_\-]{1,60}", s[name]):
            raise ValueError(f"{name} may hold letters, digits, _ and - only")
    return {
        "kind": "mongo",
        "uri": s["MONGO_URI"],
        "host": s["MONGO_HOST"], "port": int(port),
        "user": s["MONGO_USER"], "password": s["MONGO_PASS"],
        "auth_source": s["MONGO_AUTH_SOURCE"] or "admin",
        "db": s["MONGO_DB"] or "expertise_miner",
        "collection": s["MONGO_COLLECTION"] or "videos",
    }


def describe_storage(cfg: dict) -> str:
    """For people. Never includes a password or a connection string."""
    if cfg["kind"] == "sqlite":
        return f"sqlite file {cfg['path']}"
    return f"mongodb database '{cfg['db']}', collection '{cfg['collection']}'"


# ---------- embeddings (optional) -------------------------------------------

DEFAULT_EMBED_BATCH = 32
MAX_EMBED_BATCH = 256


def _is_loopback(host: str) -> bool:
    if host.lower() in ("localhost", "localhost."):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def embed_config(settings: Optional[dict] = None) -> Optional[dict]:
    """The embeddings endpoint, or None when none is configured (search is then by words only).

    EXPERTISE_MINER_EMBED_URL    the base address of an OpenAI-compatible API, the part before
                                 /embeddings: for example https://host/v1. An address that
                                 already ends in /embeddings is used as it is.
    EXPERTISE_MINER_EMBED_MODEL  the model's name, as that endpoint spells it. There is no default.
    EXPERTISE_MINER_EMBED_KEY    sent as a bearer token. Optional: a local server needs none.
    EXPERTISE_MINER_EMBED_BATCH  passages per request. Default 32.

    Plain http is accepted for this machine only (localhost, 127.0.0.1, ::1). Anything else
    must be https: the request carries transcript text and the key.
    """
    s = settings if settings is not None else load_settings()
    url, model, key = s["EXPERTISE_MINER_EMBED_URL"], s["EXPERTISE_MINER_EMBED_MODEL"], s["EXPERTISE_MINER_EMBED_KEY"]
    if not url and not model:
        if key or s["EXPERTISE_MINER_EMBED_BATCH"]:
            raise ValueError("embeddings need EXPERTISE_MINER_EMBED_URL and EXPERTISE_MINER_EMBED_MODEL")
        return None
    if not url or not model:
        raise ValueError("embeddings need both EXPERTISE_MINER_EMBED_URL and EXPERTISE_MINER_EMBED_MODEL")
    if re.search(r"[\s\x00-\x1f\x7f\\]", url):
        raise ValueError("EXPERTISE_MINER_EMBED_URL must not hold spaces, control characters or backslashes")
    try:
        parts = urlsplit(url)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise ValueError("EXPERTISE_MINER_EMBED_URL could not be read") from None
    if parts.scheme not in ("http", "https") or not host:
        raise ValueError("EXPERTISE_MINER_EMBED_URL must look like https://host/v1")
    if "@" in parts.netloc:
        raise ValueError("EXPERTISE_MINER_EMBED_URL must not hold a user name or password; "
                         "the key goes in EXPERTISE_MINER_EMBED_KEY")
    if parts.query or parts.fragment or "?" in url or "#" in url:
        raise ValueError("EXPERTISE_MINER_EMBED_URL must be a plain address with no ?query or #fragment")
    local = _is_loopback(host)
    if parts.scheme == "http" and not local:
        raise ValueError("EXPERTISE_MINER_EMBED_URL must be https, unless it is on this machine "
                         "(localhost): the request carries transcript text and the key")
    if not re.fullmatch(r"[A-Za-z0-9@][A-Za-z0-9@/_.:\-]{0,199}", model):
        raise ValueError("EXPERTISE_MINER_EMBED_MODEL may hold letters, digits and @ / _ . : - only")
    if key and not re.fullmatch(r"[\x21-\x7e]{1,4096}", key):
        raise ValueError("EXPERTISE_MINER_EMBED_KEY may not hold spaces or control characters")
    batch_raw = s["EXPERTISE_MINER_EMBED_BATCH"]
    if batch_raw and (not batch_raw.isdigit() or not (1 <= int(batch_raw) <= MAX_EMBED_BATCH)):
        raise ValueError(f"EXPERTISE_MINER_EMBED_BATCH must be a number from 1 to {MAX_EMBED_BATCH}")
    path = parts.path.rstrip("/")
    if not path.endswith("/embeddings"):
        path += "/embeddings"
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc += f":{port}"
    return {"url": f"{parts.scheme}://{netloc}{path}", "host": netloc, "local": local, "key": key,
            "model": model, "batch": int(batch_raw) if batch_raw else DEFAULT_EMBED_BATCH}


def describe_embed(cfg: Optional[dict]) -> str:
    """For people: the model and the host only. The address can hold an account id, so its
    path is left out, and the key is never included."""
    if not cfg:
        return "off"
    return f"model {cfg['model']} at {cfg['host']}" + (" (this machine)" if cfg["local"] else "")


# ---------- proxies ---------------------------------------------------------

_PROXY_SCHEMES = ("http", "https", "socks5", "socks5h")


def _check_proxy(url: str) -> str:
    try:
        parts = urlsplit(url)
        host, _ = parts.hostname, parts.port
    except ValueError:
        raise ValueError("a proxy URL could not be read") from None
    if parts.scheme not in _PROXY_SCHEMES or not host:
        raise ValueError("a proxy URL must look like http://user:pass@host:port "
                         "(http, https, socks5 or socks5h)")
    return url


def proxy_routes(settings: Optional[dict] = None) -> list:
    """The distinct routes requests can take. [None] means one direct route.

    PROXY_URLS  a comma-separated list, one route each; or
    PROXY_URL   one route; with PROXY_PORT_COUNT=N it becomes N routes on N consecutive ports,
                for providers that give one address per port.
    """
    s = settings if settings is not None else load_settings()
    if s["PROXY_URLS"]:
        urls = [u.strip() for u in s["PROXY_URLS"].split(",") if u.strip()]
        seen: list = []
        for u in urls:
            _check_proxy(u)
            if u not in seen:
                seen.append(u)
        return seen or [None]
    base = s["PROXY_URL"]
    if not base:
        return [None]
    _check_proxy(base)
    count_raw = s["PROXY_PORT_COUNT"]
    if not count_raw:
        return [base]
    if not count_raw.isdigit() or not (1 <= int(count_raw) <= 64):
        raise ValueError("PROXY_PORT_COUNT must be a number from 1 to 64")
    m = re.match(r"^(.*:)(\d{1,5})(/?)$", base)
    if not m or urlsplit(base).port is None:
        raise ValueError("PROXY_PORT_COUNT needs PROXY_URL to end in a port number")
    first = int(m.group(2))
    if first + int(count_raw) - 1 > 65535:
        raise ValueError("PROXY_PORT_COUNT runs past port 65535")
    return [f"{m.group(1)}{first + i}{m.group(3)}" for i in range(int(count_raw))]


def mask_proxy(url: Optional[str]) -> str:
    """host:port only. Credentials in a proxy URL must never reach a log or a tool result."""
    if not url:
        return "direct"
    try:
        parts = urlsplit(url)
        return f"{parts.hostname}:{parts.port}" if parts.port else str(parts.hostname)
    except ValueError:
        return "proxy"


def scrub(text: str, settings: Optional[dict] = None) -> str:
    """Remove anything secret-shaped from text that is about to be logged or returned:
    every configured proxy URL, the Mongo URI and password, the embeddings key and address (the
    address whole, its path alone, and any piece of the path of six characters or more that
    holds a digit, such as an account id), whatever follows the word Bearer, and the user:pass
    part of any URL."""
    s = settings if settings is not None else load_settings()
    out = str(text)
    secrets = [s["MONGO_URI"], s["MONGO_PASS"], s["PROXY_URL"],
               s["EXPERTISE_MINER_EMBED_KEY"], s["EXPERTISE_MINER_EMBED_URL"].rstrip("/")]
    secrets += [u.strip() for u in s["PROXY_URLS"].split(",")]
    try:
        secrets += [u for u in proxy_routes(s) if u]
    except ValueError:
        pass
    try:                               # the embeddings address may be echoed without its host: its path, and
        epath = urlsplit(s["EXPERTISE_MINER_EMBED_URL"]).path.rstrip("/")     # any piece of it that looks like an id
        if len(epath) >= 8:
            secrets.append(epath)
        secrets += [seg for seg in epath.split("/") if len(seg) >= 6 and re.search(r"\d", seg)]
    except ValueError:
        pass
    for url in [x for x in secrets if x and "://" in x]:      # the user and password inside each URL
        try:
            parts = urlsplit(url)
            for piece in (parts.username, parts.password):
                if piece:
                    secrets += [piece, unquote(piece)]
        except ValueError:
            pass
    for sec in sorted({x for x in secrets if x and len(x) >= 4}, key=len, reverse=True):
        out = re.sub(re.escape(sec), "[hidden]", out, flags=re.I)
    out = re.sub(r"(\bBearer\s+)[^\s\"',;]+", r"\1[hidden]", out, flags=re.I)
    # the user-and-password part of any other URL, up to the last @ before the host
    return re.sub(r"([a-z][a-z0-9+.\-]*://)[^/\s]*@", r"\1[hidden]@", out, flags=re.I)


def clamp_workers(requested: int, n_routes: int) -> int:
    """Never more workers than distinct routes: two workers on one address only double the
    request rate that address sees."""
    return max(1, min(int(requested), n_routes, MAX_WORKERS))


def clamp_delay_ms(requested: int) -> int:
    return max(MIN_DELAY_MS, min(int(requested), 600_000))
