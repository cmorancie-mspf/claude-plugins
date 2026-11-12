"""First-time set-up: turn three answers into a settings file.

    1. Which database holds the transcripts?        sqlite | mongo
    2. How do you want to search?                   words | meaning (with which kind of endpoint)
    3. Do YouTube pulls go through a proxy?         none | one | list

The file this writes holds every setting the plugin reads, grouped under those three questions.
What it never holds is a value only the person has: no password, no key, no proxy address, no
account id, no server name. Those are written as placeholders in CAPITALS, and **every line
that needs one is written switched off** (commented out). So a file fresh from here behaves
exactly like no file at all: SQLite, search by words, no proxy, nothing sent anywhere new.
The person fills the placeholders in and removes the "# " themselves.

Nothing here takes an address, a key or any free text from a tool call: the answers are picked
from fixed lists, and an existing settings file is never overwritten.
"""
from __future__ import annotations

import os
from pathlib import Path

import config

STORES = ("sqlite", "mongo")
SEARCHES = ("words", "meaning")
PROXIES = ("none", "one", "list")

# Where the embedding model runs. Each is the address shape and the placeholders that kind of
# endpoint needs. The model names are examples that were current when this was written; the
# person checks their provider's list.
ENDPOINTS = {
    "local": {
        "label": "a server on this machine (for example Ollama). Nothing leaves the machine",
        "url": "http://localhost:11434/v1", "example": "", "key": "",
        "fill": ["MODEL_NAME: an embedding model you have pulled into that server"],
    },
    "cloudflare": {
        "label": "Cloudflare Workers AI",
        "url": "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1", "example": "@cf/baai/bge-m3", "key": "TOKEN",
        "fill": ["ACCOUNT_ID: your Cloudflare account id", "MODEL_NAME: an embedding model from Cloudflare's current list",
                 "TOKEN: an API token of that account with Workers AI permission"],
    },
    "openai": {
        "label": "OpenAI",
        "url": "https://api.openai.com/v1", "example": "text-embedding-3-small", "key": "API_KEY",
        "fill": ["MODEL_NAME: an embedding model from OpenAI's current list", "API_KEY: your API key"],
    },
    "other": {
        "label": "another OpenAI-compatible embeddings endpoint",
        "url": "https://HOST/v1", "example": "", "key": "KEY",
        "fill": ["HOST: the endpoint's address, the part before /embeddings", "MODEL_NAME: the model's name there",
                 "KEY: its key, or delete that line if it needs none"],
    },
}

RULE = "#" * 91


class OnboardError(Exception):
    """A refusal with a message meant for the person."""


def _pick(name: str, value, allowed: tuple, default: str) -> str:
    if value is None or value == "":
        return default
    if not isinstance(value, str) or value not in allowed:
        raise OnboardError(f"{name} must be one of: {', '.join(allowed)}")
    return value


def read_choices(a: dict) -> dict:
    """The answers, each checked against its fixed list. Nothing else is accepted."""
    known = {"store", "search", "endpoint", "proxy"}
    extra = sorted(set(a) - known)
    if extra:
        raise OnboardError("not an option here: " + ", ".join(extra) + ". Addresses, keys and passwords are never "
                           "passed to a tool: the person types them into the file.")
    c = {"store": _pick("store", a.get("store"), STORES, "sqlite"),
         "search": _pick("search", a.get("search"), SEARCHES, "words"),
         "proxy": _pick("proxy", a.get("proxy"), PROXIES, "none"),
         "endpoint": _pick("endpoint", a.get("endpoint"), tuple(ENDPOINTS), "")}
    if c["search"] == "meaning" and not c["endpoint"]:
        raise OnboardError("search by meaning needs endpoint: one of " + ", ".join(ENDPOINTS))
    if c["search"] == "words":
        c["endpoint"] = ""
    if c["search"] == "meaning" and c["store"] == "mongo":
        raise OnboardError("search by meaning is kept in the SQLite store only: choose SQLite with it, or MongoDB "
                           "with search by words")
    return c


def render(c: dict) -> tuple:
    """(the file's text, the steps left for the person). `c` comes from read_choices."""
    todo: list = []
    mongo, meaning, proxy = c["store"] == "mongo", c["search"] == "meaning", c["proxy"]
    ep = ENDPOINTS[c["endpoint"] or "other"]
    L: list = [
        "# expertise-miner settings. Three questions, one section each.",
        "#",
        "# This file belongs in the data folder:  <your home folder>/.expertise-miner/.env",
        "# The same names set in your environment win over it. It is read on every tool call, so",
        "# a change takes effect at the next one; a pull or an embedding run already going keeps",
        "# the settings it started with. Never commit a filled-in copy: it holds credentials.",
        "#",
        '# A line that starts with "#" is off. To switch a line on, remove the "# " in front of it.',
        "# Words in CAPITALS (HOST, TOKEN, ...) are placeholders: replace them before switching the",
        "# line on (one left in is reported as a mistake and not used). Every line that needs one",
        "# starts off, so this file as written changes nothing: SQLite, search by words, no proxy.",
        "",
        RULE,
        "# 1. WHICH DATABASE HOLDS THE TRANSCRIPTS?",
        "#    YOUR ANSWER: " + ("MongoDB. NOT ON YET: see choice B. SQLite is used until then."
                               if mongo else "SQLite (the default)."),
        RULE,
        "",
        "# --- Choice A: SQLite, a file on this machine (ON) " + "-" * 39,
        "# Needed for search by meaning, and for ranking by how rare a word is.",
        "EXPERTISE_MINER_STORE=sqlite",
        "# The file. Default: corpus.db in the data folder.",
        "# EXPERTISE_MINER_DB=",
        "",
        "# --- Choice B: MongoDB (off) " + "-" * 61,
        "# Search is then by words only, without ranking by how rare a word is. Needs the pymongo",
        '# package. To choose it: fill in the placeholders, put "# " in front of',
        '# EXPERTISE_MINER_STORE=sqlite above, and remove the "# " from the setting lines below.',
        "# For a server with no sign-in, leave the USER, PASS and AUTH_SOURCE lines off.",
        "# EXPERTISE_MINER_STORE=mongo",
        "# MONGO_HOST=HOST",
        "# MONGO_PORT=27017",
        "# MONGO_USER=USER",
        "# MONGO_PASS=PASSWORD",
        "# MONGO_AUTH_SOURCE=admin",
        "# MONGO_DB=expertise_miner",
        "# MONGO_COLLECTION=videos",
        "# Or one connection string in place of the HOST, PORT, USER, PASS and AUTH_SOURCE lines:",
        "# MONGO_URI=",
        "",
        RULE,
        "# 2. HOW DO YOU WANT TO SEARCH?",
        "#    YOUR ANSWER: " + (f"by words, and by meaning through {ep['label']}. NOT ON YET: see below."
                               if meaning else "by words (the default)."),
        RULE,
        "",
        "# --- Search by words: always on " + "-" * 58,
        "# on: a word also finds its other forms (check, checks, checking). off: exact forms only.",
        "# Changing it rebuilds the search index the next time the corpus is opened.",
        "EXPERTISE_MINER_SEARCH_STEMMING=on",
        "# ranked: passages holding more of the words, and rarer ones, come first.",
        "# all: only passages holding every word.",
        "EXPERTISE_MINER_SEARCH_MATCH=ranked",
        "",
        "# --- Add search by meaning (off) " + "-" * 57,
        "# Finds a passage that says it in other words. Needs SQLite in section 1. It calls an",
        "# embedding model through an OpenAI-compatible endpoint that you choose.",
        "# When on: the text of stored passages is sent to that endpoint by embed_start, and the",
        "# wording of each search is sent to it too. If the endpoint is not on this machine, that",
        "# text leaves it, and embedding a corpus may cost money.",
        "# To choose it: fill in the placeholders, then remove the \"# \" from the URL and MODEL",
        "# lines, and from the KEY line if your endpoint needs a key.",
        "# The address and the model go together: both, or neither. These four settings are read",
        "# as a set from one place: if your environment holds any one of them, all four of the",
        "# lines here are ignored.",
        "# The address must be https, unless it is on this machine (http://localhost:PORT/v1).",
        "# EXPERTISE_MINER_EMBED_URL=" + ep["url"],
        "# The model's name, exactly as that endpoint spells it. There is no default."
        + (f" An example,\n# current when this was written: {ep['example']}. Check your provider's list." if ep["example"] else ""),
        "# EXPERTISE_MINER_EMBED_MODEL=MODEL_NAME",
        *([] if ep["key"] else ["# A server on this machine usually needs no key: leave the next line off unless yours asks for one."]),
        "# EXPERTISE_MINER_EMBED_KEY=" + (ep["key"] or "KEY"),
        "# Passages per request, 1 to 256. Lower it if the job log says batches are refused.",
        "# EXPERTISE_MINER_EMBED_BATCH=32",
        "",
        RULE,
        "# 3. DO YOUTUBE PULLS GO THROUGH A PROXY?",
        "#    YOUR ANSWER: " + {"none": "no (the default). Pulls go out from your own address.",
                               "one": "yes, one proxy address. NOT ON YET: see choice B.",
                               "list": "yes, a list of proxies. NOT ON YET: see choice C."}[proxy],
        RULE,
        "",
        "# --- Choice A: no proxy (ON while every line below is off) " + "-" * 31,
        "",
        "# Writing a proxy address, for choices B and C:",
        "# - The order is scheme://USER:PASSWORD@HOST:PORT. Providers often export host:port:user:pass;",
        "#   reorder it: gate.example.com:10001:me:pw becomes http://me:pw@gate.example.com:10001",
        "# - If the user name or password holds @ : / # ? or %, write them as %40 %3A %2F %23 %3F %25.",
        "#   Other characters, such as =, can stay as they are. Both pulling libraries decode these.",
        "",
        "# --- Choice B: one proxy address (off) " + "-" * 51,
        "# http, https, socks5 or socks5h.",
        "# PROXY_URL=http://USER:PASSWORD@HOST:PORT",
        "# How many consecutive ports of that address to use as separate routes, 1 to 64. Each route",
        "# is one exit address. Raise it only if your proxy plan gives you that many ports. For",
        "# example, PROXY_URL=http://USER:PASSWORD@gate.example.com:10001 with PROXY_PORT_COUNT=10",
        "# gives ports 10001 to 10010: 10 routes. This is the short way for a provider that gives one",
        "# exit address per port.",
        "# PROXY_PORT_COUNT=1",
        "",
        "# --- Choice C: a list of proxies (off) " + "-" * 51,
        "# Comma-separated, one route each. When set, the lines of choice B are ignored. If your",
        "# routes are one host on consecutive ports, choice B says the same in two lines.",
        "# PROXY_URLS=http://USER:PASSWORD@HOST1:PORT,http://USER:PASSWORD@HOST2:PORT",
        "",
        "# A proxy is for YouTube only. Search by meaning never uses it.",
        "",
        "# --- How fast pulls go (off: the built-in defaults) " + "-" * 39,
        "# The defaults for a pull that does not say: workers 1, a pause of 1500 ms per worker.",
        "# A value given on a pull wins. The limits stay whatever is set here: never more workers",
        "# than routes, at most 8, and never a pause under 500 ms. With no proxy, one worker runs.",
        "# A safe start with a proxy plan of several ports: 4 workers and 3000 ms. A random 0 to 50%",
        "# is always added to the pause, so that requests do not arrive on a fixed beat.",
        "# EXPERTISE_MINER_WORKERS=4",
        "# EXPERTISE_MINER_DELAY_MS=3000",
        "# A limit on requests to YouTube per minute for the whole pull, all workers together, 1 to",
        "# 600. Off by default: no limit beyond the pause. A request here is one call to YouTube: the",
        "# listing of one playlist or channel tab, one read of a video's page, or one transcript fetch",
        "# attempt. A transcript fetch is itself about three HTTP requests. Through a mobile proxy",
        "# plan, the site has been seen to refuse requests over a route after 5 minutes of 1 worker",
        "# at 8000 ms with page reads on (about 7 to 10 a minute): 6 is a start for such plans. A",
        "# pull's own max_requests_per_minute wins over this line.",
        "# EXPERTISE_MINER_MAX_REQUESTS_PER_MINUTE=6",
        "",
        RULE,
        "# NOT IN THIS FILE",
        RULE,
        "# Two more settings exist, and neither can be set here: they are read before this file is.",
        "# Set them as environment variables of your system if you need them, then start a new",
        "# Claude Code session. Nothing to fill in or switch on in this file.",
        "#   The data folder: environment variable EXPERTISE_MINER_HOME. Default: .expertise-miner",
        "#   in your home folder.",
        "#   The Python the server runs under: environment variable EXPERTISE_MINER_PYTHON. Default:",
        "#   the first of py -3, python3, python that is version 3.9 or later.",
        "",
    ]
    if mongo:
        todo.append("MongoDB (section 1, choice B): replace HOST, USER and PASSWORD (or use MONGO_URI), check the "
                    "database and collection names, put \"# \" in front of EXPERTISE_MINER_STORE=sqlite, and remove "
                    "the \"# \" from the MongoDB lines. Until then SQLite is used.")
    if meaning:
        todo.append("Search by meaning (section 2): replace " + "; ".join(ep["fill"]) + ". Then remove the \"# \" from "
                    + ("the EXPERTISE_MINER_EMBED_URL, _MODEL and _KEY lines" if ep["key"] else
                       "the EXPERTISE_MINER_EMBED_URL and _MODEL lines (not the _KEY line, unless your server needs one)")
                    + ". Until then search is by words. After that, embed_status says "
                    "how much embed_start would send.")
    if proxy == "one":
        todo.append("Proxy (section 3, choice B): replace USER, PASSWORD, HOST and PORT in PROXY_URL and remove its "
                    "\"# \". If the plan gives one exit address per port, also set PROXY_PORT_COUNT. Until then pulls "
                    "go out from your own address. The file says how to write a password holding @ : / # ? or %.")
    if proxy == "list":
        todo.append("Proxies (section 3, choice C): replace the example addresses in PROXY_URLS with your own and "
                    "remove its \"# \". If they are one host on consecutive ports, choice B (PROXY_URL with "
                    "PROXY_PORT_COUNT) is the shorter way. Until then pulls go out from your own address. The file "
                    "says how to write a password holding @ : / # ? or %.")
    return "\n".join(L), todo


def write(a: dict) -> dict:
    """Write the settings file for these answers. Refuses when one is already there."""
    c = read_choices(a)
    text, todo = render(c)
    home = config.home_dir()
    path = home / ".env"
    home.mkdir(parents=True, exist_ok=True)
    taken = OnboardError(f"{path} already exists and is not touched: it may hold credentials. The person edits it "
                         "themselves; setup_check shows what is in effect.")
    if path.is_symlink() or path.exists():        # a file, a folder, or a link to anywhere, even to nothing
        raise taken
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)      # never over an existing file
    except FileExistsError:
        raise taken from None
    except OSError as e:
        raise OnboardError(f"{path} could not be created: {type(e).__name__}") from None
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return {"written": str(path), "answers": {k: v for k, v in c.items() if v != ""},
            "in_effect_now": "what was in effect before: the file as written sets only the defaults (SQLite, "
                             "stemming on, ranked matching) and switches on nothing else. setup_check shows it.",
            "left_for_the_person": todo,
            "note": ("The person opens that file, replaces the placeholders in CAPITALS and removes the \"# \" from "
                     "those lines. Never ask for, print or write those values yourself. Then call setup_check."
                     if todo else "Nothing is left to fill in. setup_check shows what is in effect.")}


def example_text() -> str:
    """The shipped .env.example: the same file, with the default answer to every question."""
    return render(read_choices({}))[0]


def summary(settings: dict) -> dict:
    """The three answers as the settings in force give them, for setup_check. No values."""
    out: dict = {}
    try:
        kind = config.storage_config(settings)["kind"]
        out["database"] = "MongoDB" if kind == "mongo" else "SQLite"
    except ValueError:
        out["database"] = "not usable: see problems"
    try:
        e = config.embed_config(settings)
        out["search"] = "by words" + (f", and by meaning ({e['model']} at {e['host']})" if e else "")
    except ValueError:
        out["search"] = "by words (the search-by-meaning settings are incomplete: see problems)"
    try:
        routes = [r for r in config.proxy_routes(settings) if r]
        out["proxy"] = f"{len(routes)} route(s)" if routes else "none"
    except ValueError:
        out["proxy"] = "not usable: see problems"
    return out


if __name__ == "__main__":
    import sys
    sys.stdout.write(example_text())          # python onboard.py > ../.env.example
