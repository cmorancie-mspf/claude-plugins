"""Embeddings, through an OpenAI-compatible endpoint that the settings name. Optional.

Passages are sent in batches to POST <address>/embeddings as {"model": ..., "input": [...]},
with the key as a bearer token, and the vectors that come back are stored beside the passages
(store.py). Embedding a corpus is many requests and may cost money, so it runs as its own
process, like a pull:

    python embed.py run  <job_id>     the worker (started by the server, not by hand)
    python embed.py wait <job_id>     blocks until the job ends; exit 0 done, 1 failed or
                                      stopped, 2 the endpoint kept refusing, 3 the worker went quiet

This file is the only code that contacts the embeddings endpoint. The address comes from the
settings alone, never from a tool call, a job record or a transcript. Redirects are not
followed: the key and the text would go with them. Nothing here reads another program's
stored credentials. Standard library only.
"""
from __future__ import annotations

import http.client
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import pull  # noqa: E402
import store as store_mod  # noqa: E402

PullError = pull.PullError

MAX_RESPONSE_BYTES = 64 * 1024 * 1024
REQUEST_TIMEOUT_S = 60        # for each network step (connecting, sending, each wait for more of the
QUERY_TIMEOUT_S = 20          # answer), and again for the whole of the answer's body. Name lookup is the
                              # system's own and is not covered. A search uses the shorter one.
MIN_DELAY_MS = 100
LATE_REJECT_STREAK = 50       # the same, once the endpoint has embedded something: then it is the passages
RETRIES = 5                   # tries of one request that was answered "busy" or not at all
MAX_WAIT_S = 120
REJECT_STREAK = 5             # passages in a row the endpoint would not embed before the run gives up,
                              # while it has embedded nothing at all: then it is the model or the address
DEFAULT_DELAY_MS = 200
STATES_RUNNING = ("starting", "running")


class EmbedError(Exception):
    """A request that did not produce vectors. kind: 'auth' (the key was refused), 'request'
    (the endpoint will not take this request: wrong model, wrong address, text too long),
    'busy' (asked to slow down, or a server error), 'network' (no answer), 'response' (an
    answer that could not be used)."""

    def __init__(self, kind: str, message: str, retry_after: Optional[float] = None):
        super().__init__(message)
        self.kind, self.retry_after = kind, retry_after


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None               # not followed: the 3xx then surfaces as an error


def _opener(cfg: dict):
    handlers: list = [_NoRedirect()]
    if cfg["local"]:
        handlers.append(urllib.request.ProxyHandler({}))      # this machine is never reached through a proxy
    return urllib.request.build_opener(*handlers)


def _snippet(raw: bytes) -> str:
    return " ".join(raw.decode("utf-8", errors="replace").split())[:200]


def post_embeddings(cfg: dict, texts: list, timeout: float = REQUEST_TIMEOUT_S, opener=None) -> list:
    """One request. Returns one unit-length vector (a list of floats) per text, in order, all of
    one size. Raises EmbedError. `opener` is replaceable so tests open no connection."""
    body = json.dumps({"model": cfg["model"], "input": list(texts)}).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json",
               "User-Agent": "expertise-miner"}
    if cfg["key"]:
        headers["Authorization"] = "Bearer " + cfg["key"]
    req = urllib.request.Request(cfg["url"], data=body, headers=headers, method="POST")
    try:
        deadline = time.monotonic() + timeout
        with (opener or _opener(cfg)).open(req, timeout=timeout) as resp:
            # Read as it arrives, against a clock: an answer that drips in is given up on, and so
            # is one that never ends.
            read = getattr(resp, "read1", None) or resp.read
            parts, size = [], 0
            while size <= MAX_RESPONSE_BYTES:
                chunk = read(65536)
                if not chunk:
                    break
                parts.append(chunk)
                size += len(chunk)
                if time.monotonic() > deadline:
                    raise EmbedError("network", f"the answer had not finished arriving after {int(timeout)} seconds")
            raw = b"".join(parts)
    except EmbedError:
        raise
    except urllib.error.HTTPError as e:
        code = int(e.code)
        try:
            detail = _snippet(e.read(2000))
        except Exception:  # noqa: BLE001
            detail = ""
        retry_after = None
        try:
            retry_after = float((e.headers or {}).get("Retry-After", ""))
        except (TypeError, ValueError):
            pass
        if 300 <= code < 400:
            raise EmbedError("request", f"HTTP {code}: the endpoint answered with a redirect, which is never "
                                        "followed. Set the address it really lives at.") from None
        kind = "auth" if code in (401, 403) else "busy" if code in (408, 409, 425, 429) or code >= 500 else "request"
        raise EmbedError(kind, f"HTTP {code}" + (f": {detail}" if detail else ""), retry_after) from None
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
        raise EmbedError("network", f"{type(e).__name__}: {getattr(e, 'reason', e)}") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise EmbedError("response", "the answer was too large to be a batch of embeddings")
    try:
        data = json.loads(raw.decode("utf-8"))["data"]
        if not isinstance(data, list) or len(data) != len(texts) or not all(isinstance(d, dict) for d in data):
            raise ValueError
    except (ValueError, KeyError, TypeError, RecursionError):
        raise EmbedError("response", "the answer was not {\"data\": [...]} with one embedding per text. "
                                     "Is the address an OpenAI-compatible /embeddings endpoint?") from None
    indexes = [d.get("index") for d in data]
    if all(isinstance(i, int) and not isinstance(i, bool) for i in indexes):
        if sorted(indexes) != list(range(len(texts))):
            raise EmbedError("response", "the answer's index numbers do not match the texts sent")
        data = sorted(data, key=lambda d: d["index"])
    elif any(i is not None for i in indexes):
        raise EmbedError("response", "the answer's index numbers could not be read")
    try:
        vectors = [store_mod.unit_vector(d.get("embedding")) for d in data]
    except store_mod.VectorError as e:
        raise EmbedError("response", str(e)) from None
    if len({len(v) for v in vectors}) != 1:
        raise EmbedError("response", "the answer held vectors of different sizes")
    return vectors


def query_vectors(cfg: dict, texts: list) -> list:
    """Vectors for search wordings: one request, a short wait, no retries."""
    return post_embeddings(cfg, [store_mod.embed_text(t) for t in texts], timeout=QUERY_TIMEOUT_S)


# ---------- the job ----------------------------------------------------------------


def need_config(settings: Optional[dict] = None) -> dict:
    """The endpoint settings, or a refusal that says what to set."""
    s = settings if settings is not None else config.load_settings()
    if config.storage_config(s)["kind"] != "sqlite":
        raise PullError("embeddings are kept in the SQLite store only; with MongoDB, search stays by words")
    try:
        cfg = config.embed_config(s)
    except ValueError as e:
        raise PullError(str(e)) from None
    if cfg is None:
        raise PullError("no embeddings endpoint is set. The person puts EXPERTISE_MINER_EMBED_URL and "
                        "EXPERTISE_MINER_EMBED_MODEL (and a key, if the endpoint needs one) in the .env file "
                        "that setup_check names. Search by words works without it.")
    return cfg


def build_job(spec: dict) -> dict:
    """Validate a request and return its job record. Starts nothing. The record holds the model
    and the endpoint's host, never the key or the full address."""
    cfg = need_config()
    for name in ("reembed", "retry_refused"):          # these delete or spend: "false" must not count as yes
        if spec.get(name) is not None and not isinstance(spec[name], bool):
            raise PullError(f"{name} must be true or false")
    for name in ("max_passages", "delay_ms"):
        v = spec.get(name)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or v != v
                              or v in (float("inf"), float("-inf")) or v != int(v)):
            raise PullError(f"{name} must be a whole number")
    max_passages = int(spec.get("max_passages") or 0)
    if max_passages < 0 or max_passages > 10_000_000:
        raise PullError("max_passages must be 0 (everything not yet embedded) or a positive number")
    delay = spec.get("delay_ms")
    delay = DEFAULT_DELAY_MS if delay is None else int(delay)
    return {
        "id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6],
        "kind": "embed", "model": cfg["model"], "endpoint": cfg["host"], "local": cfg["local"],
        "batch": cfg["batch"], "delay_ms": max(MIN_DELAY_MS, min(delay, 600_000)),
        "max_passages": max_passages, "reembed": spec.get("reembed") is True,
        "retry_refused": spec.get("retry_refused") is True,
        "state": "starting", "created": time.time(), "heartbeat": time.time(),
        "counts": {"to_embed": 0, "embedded": 0, "skipped": 0, "refused_before": 0, "requests": 0,
                   "characters_sent": 0},
        "message": "", "pid": 0,
    }


def create_job(spec: dict) -> dict:
    return pull.launch(build_job(spec), Path(__file__).resolve(), pull.EMBED_LOCK)


def wait_command(job_id: str) -> str:
    return pull.wait_command(job_id, Path(__file__).resolve())


def run_job(job_id: str, *, sender: Callable = post_embeddings, sleep: Callable = time.sleep, store=None) -> dict:
    """Embed what is not embedded yet. `sender` and `sleep` are replaceable so tests open no connection."""
    job = pull.read_job(job_id)
    settings = config.load_settings()
    lock = threading.Lock()
    stop_file = pull.jobs_dir() / f"{job_id}.stop"
    done_evt = threading.Event()

    def save(**changes) -> None:
        with lock:
            job.update(changes)
            job["heartbeat"] = time.time()
            pull.write_job(job)

    def beat() -> None:
        while not done_evt.wait(pull.HEARTBEAT_S):
            save()

    def log(msg: str) -> None:
        print(time.strftime("%H:%M:%S ") + config.scrub(msg, settings), flush=True)

    def stood_down() -> str:
        if stop_file.exists():
            return "stopped on request"
        if pull.slot_holder(pull.EMBED_LOCK) not in ("", job_id):
            return "another embedding run took over; this one stood down"
        return ""

    own_store = store is None
    threading.Thread(target=beat, daemon=True).start()
    try:
        if job.get("kind") != "embed":
            raise PullError("not an embedding job")
        save(state="running", pid=os.getpid(), started=time.time())
        cfg = need_config(settings)
        if cfg["model"] != job["model"] or cfg["host"] != job["endpoint"]:
            raise PullError("the embeddings settings changed after this job was created. Start it again.")
        if own_store:
            store = store_mod.open_store(config.storage_config(settings))
        model, counts = cfg["model"], job["counts"]
        info = store.vector_info()
        why = stood_down()
        if why:                               # before anything is removed: this worker may have been
            raise PullError(why)              # taken for dead, and another run may own the vectors now
        if job["reembed"] is True:
            log(f"reembed: removed {store.clear_vectors()} stored vectors")
        elif info["model"] and info["model"] != model:
            raise PullError(f"the stored vectors were made by {info['model']}, and the settings now name {model}. "
                            "Two models' vectors cannot be compared. Either set the old model again, or start "
                            "with reembed=true, which removes the stored vectors and embeds everything again.")
        if job.get("retry_refused") is True:
            log(f"retry_refused: {store.clear_refused()} passages refused before will be sent again")
        pending = store.count_pending(model)
        todo = pending["passages"]
        if job["max_passages"]:
            todo = min(todo, job["max_passages"])
        with lock:
            counts["to_embed"], counts["refused_before"] = todo, pending["refused"]
        # Has this endpoint ever embedded anything for this corpus? If not, a run of refusals is
        # the model name or the address, and is given up on quickly.
        state = {"streak": 0, "worked": store.vector_info()["vectors"] > 0, "hinted": False, "recorded": []}
        save()
        log(f"job {job_id}: {todo} passages to embed with {config.describe_embed(cfg)}, {cfg['batch']} per request")

        def send(texts: list) -> list:
            for attempt in range(RETRIES):
                with lock:
                    counts["requests"] += 1
                    counts["characters_sent"] += sum(len(t) for t in texts)
                try:
                    got = sender(cfg, texts)
                    if not isinstance(got, list) or len(got) != len(texts):
                        raise EmbedError("response", "the answer did not hold one vector per text")
                    return got
                except EmbedError as e:
                    if e.kind not in ("busy", "network") or attempt == RETRIES - 1 or stood_down():
                        raise
                    pause = min(MAX_WAIT_S, max(1.0, e.retry_after or 2.0 * (2 ** attempt)))
                    log(f"{e}; trying again in {int(pause)} s")
                    sleep(pause)
            raise EmbedError("busy", "no answer")                # not reached

        def keep(batch: list, vectors: list) -> None:
            n = store.store_vectors(model, len(vectors[0]), [(pid, text, v) for (pid, text), v in zip(batch, vectors)])
            with lock:
                counts["embedded"] += n

        def pause() -> None:
            sleep(job["delay_ms"] / 1000.0)

        def skip(item: tuple, e: EmbedError) -> None:
            state["streak"] += 1
            with lock:
                counts["skipped"] += 1
            log(f"passage {item[0]} was not embedded: {e}")
            # Remembered, so that later runs go past it: but only a passage the endpoint itself said no
            # to (not an answer that could not be used), and only once the endpoint has worked.
            if state["worked"] and e.kind == "request":
                store.record_refused(model, item[0], item[1])
                state["recorded"].append(item[0])
            limit = LATE_REJECT_STREAK if state["worked"] else REJECT_STREAK
            if state["streak"] >= limit:
                # So many in a row is the endpoint, not the passages: none of this run of them is
                # held against its passage.
                store.forget_refused(state["recorded"])
                state["recorded"] = []
                raise EmbedError("rejected", f"{limit} passages in a row were not accepted. The last answer: {e}")

        def embed_batch(batch: list) -> None:
            """Embed and store a batch. A passage the endpoint will not take is left out and counted;
            anything that should end the run is raised."""
            try:
                keep(batch, send([t for _, t in batch]))
                state.update(streak=0, worked=True, recorded=[])
                return
            except EmbedError as e:
                if e.kind not in ("request", "response"):
                    raise
                if len(batch) == 1:
                    return skip(batch[0], e)
                # One passage may be the cause (too long for the model, say), so each is sent alone
                # and only the refused ones are left out.
                log(f"a batch of {len(batch)} was not accepted ({e}); sending its passages one at a time")
            accepted = 0
            for item in batch:
                if stood_down():
                    return
                pause()                           # the same pause after every request, single ones too
                try:
                    keep([item], send([item[1]]))
                    state.update(streak=0, worked=True, recorded=[])
                    accepted += 1
                except EmbedError as e:
                    if e.kind not in ("request", "response"):
                        raise
                    skip(item, e)
            if accepted == len(batch) and not state["hinted"]:
                state["hinted"] = True
                log(f"every passage of that batch was accepted alone: the endpoint may not take {len(batch)} texts "
                    "in one request. A smaller EXPERTISE_MINER_EMBED_BATCH would save requests.")

        halt = {"state": "", "message": ""}
        last, done = 0, 0
        while True:
            why = stood_down()
            if why:
                halt.update(state="stopped", message=why + ".")
                break
            room = (job["max_passages"] - done) if job["max_passages"] else job["batch"]
            if room <= 0:
                break
            batch, last, end = store.pending_passages(model, last, limit=min(job["batch"], room))
            if not batch:
                if end:
                    break
                continue
            done += len(batch)
            try:
                embed_batch(batch)
            except EmbedError as e:
                if e.kind == "auth":
                    halt.update(state="failed", message=f"The endpoint refused the key ({e}). Nothing more was sent. "
                                                        "The person checks EXPERTISE_MINER_EMBED_KEY.")
                elif e.kind in ("busy", "network"):
                    halt.update(state="blocked", message=f"The endpoint kept refusing or could not be reached ({e}). "
                                                         "What was embedded is kept. Start again later: it "
                                                         "continues where it stopped.")
                else:
                    halt.update(state="failed", message=f"The endpoint would not embed the passages ({e}). Check "
                                                        "the model name and the address. What was embedded is kept.")
                break
            except store_mod.VectorError as e:
                halt.update(state="failed", message=str(e))
                break
            save()
            pause()
        info = store.vector_info()
        tail = f"{info['vectors']} of {info['passages']} passages now have vectors"
        if halt["state"]:
            save(state=halt["state"], message=config.scrub(f"{halt['message']} {tail[0].upper()}{tail[1:]}.", settings)[:1200],
                 ended=time.time())
        else:
            save(state="done", ended=time.time(),
                 message=f"embedded {counts['embedded']}, not accepted {counts['skipped']}"
                         + (f", left out because refused before {counts['refused_before']}" if counts["refused_before"] else "")
                         + f"; {tail}")
        log(f"{job['state']}: {job['message']}")
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
        pull._release_slot(job_id, pull.EMBED_LOCK)
    return job


def main(argv: list) -> int:
    if len(argv) == 3 and argv[1] == "run":
        return 0 if run_job(argv[2]).get("state") == "done" else 1
    if len(argv) == 3 and argv[1] == "wait":
        try:
            return pull.wait(argv[2])
        except PullError as e:
            print(str(e), file=sys.stderr)
            return 1
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
