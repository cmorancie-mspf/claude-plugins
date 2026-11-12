"""Where transcripts are kept: a local SQLite file by default, MongoDB when asked for.

One record per video, keyed on video_id. A record holds the transcript twice: as one text
(`transcript`, for search) and as timed lines (`segments`, a list of [start_seconds, text]),
which is what lets a quote be traced to a moment in the video.

The SQLite store can also hold one embedding vector per passage (optional, see embed.py).
Every vector row names the model that made it, and the store refuses a second model.
"""
from __future__ import annotations

import bisect
import hashlib
import heapq
import json
import math
import re
import sqlite3
import struct
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

META_FIELDS = (
    "video_id", "channel", "channel_handle", "channel_id", "title", "url",
    "duration_seconds", "view_count", "upload_date", "kind",
    "language", "is_generated", "source", "fetched_at",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- text helpers (shared with search and with quote checking) ---------


def norm(text: str) -> str:
    """Lower case, letters and digits only, single spaces. Two texts that differ only in
    punctuation, case or line breaks are equal after this."""
    return " ".join(re.findall(r"[^\W_]+", str(text).lower()))


class TimedText:
    """A transcript's timed lines as one normalised text, with a way back from a position in
    that text to the line, and so the second, it came from."""

    def __init__(self, segments: list):
        self.segments = segments
        parts: list = []
        self.offsets: list = []
        pos = 0
        for seg in segments:
            n = norm(seg[1])
            self.offsets.append(pos)
            if n:
                parts.append(n)
                pos += len(n) + 1
        self.text = " ".join(parts)
        self._padded = f" {self.text} "

    def find_all(self, phrase: str, limit: int = 200) -> list:
        """Segment indexes where the normalised phrase starts, whole words only."""
        p = norm(phrase)
        if not p:
            return []
        needle = f" {p} "
        out: list = []
        at = self._padded.find(needle)
        while at != -1 and len(out) < limit:
            out.append(max(0, bisect.bisect_right(self.offsets, at) - 1))
            at = self._padded.find(needle, at + 1)
        return out

    def start(self, index: int) -> float:
        return float(self.segments[index][0])


def stamp(seconds) -> str:
    """MM:SS, or H:MM:SS from one hour on. Empty for None."""
    if seconds is None:
        return ""
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def blocks(segments: list, start: float = 0.0, first: int = 0, seconds: float = 30.0, chars: int = 400):
    """Caption lines are a few words each. Yield them joined into readable lines of about half a
    minute: (index_of_first_segment, start_seconds, "[MM:SS] text").

    Reading resumes by position (`first`), never by time: caption lines can share a start time or
    be out of order, and a resume by time would then repeat or lose lines. `start` only chooses
    the position to begin at: the first line that starts at or after it."""
    if not first and start > 0:
        first = next((i for i, s in enumerate(segments) if s[0] >= start), len(segments))
    cur, cur_first, cur_start, cur_len = [], 0, None, 0
    for i in range(max(0, int(first)), len(segments)):
        st, tx = segments[i]
        if cur and (st - cur_start >= seconds or st < cur_start or cur_len >= chars):
            yield cur_first, cur_start, f"[{stamp(cur_start)}] " + " ".join(cur)
            cur, cur_start, cur_len = [], None, 0
        if cur_start is None:
            cur_first, cur_start = i, st
        cur.append(tx)
        cur_len += len(tx) + 1
    if cur:
        yield cur_first, cur_start, f"[{stamp(cur_start)}] " + " ".join(cur)


def parse_query(query: str) -> list:
    """Words, and phrases in double quotes, each normalised. Empty ones are dropped."""
    terms: list = []
    for phrase, word in re.findall(r'"([^"]*)"|(\S+)', str(query)):
        n = norm(phrase or word)
        words = n.split()
        if not n or n in terms or len(words) > 40 or any(len(w) > 64 for w in words):
            continue                       # nothing searchable, said already, or too long to be a real term
        terms.append(n)
    return terms[:12]


JOIN_WORDS = 12        # words either side of the join with the next passage, indexed apart from the
                       # passage's own words so that a phrase can cross the join and a single word cannot
PASSAGE_CHARS = 400
JOIN_CANDIDATES = 500  # passages whose join text matches a phrase that are looked at, each checked on its own
CROSS_FIRST = 10       # at most this many passages found by a phrase across a join are listed first


def make_passages(doc: dict) -> list:
    """A cleaned record cut into passages of about half a minute: (idx, start_seconds or None,
    text, joint). joint is the last words of this passage and the first of the next, or ""."""
    texts: list = []
    if doc["segments"]:
        for _, start, line in blocks(doc["segments"], chars=PASSAGE_CHARS):
            texts.append((float(start), line.split("] ", 1)[1]))
    else:                                   # a record with no timed lines: cut the text by length
        cur, size = [], 0
        for w in doc["transcript"].split():
            cur.append(w)
            size += len(w) + 1
            if size >= PASSAGE_CHARS:
                texts.append((None, " ".join(cur)))
                cur, size = [], 0
        if cur:
            texts.append((None, " ".join(cur)))
    out = []
    for i, (start, text) in enumerate(texts):
        joint = ""
        if i + 1 < len(texts):
            joint = " ".join(text.split()[-JOIN_WORDS:] + texts[i + 1][1].split()[:JOIN_WORDS])
        out.append((i, start, text, joint))
    return out


def rank_rows(rows: list, terms: list, match: str, limit: int) -> list:
    """Rank passages without a full-text index: by how many of the terms each holds, whole words,
    exact forms. rows: (video_id, idx, start, text, joint, title), with the title given for a
    video's first passage only. A single word counts in the passage's own words. A phrase also
    counts when it lies across the join with the next passage: in the join text, and not wholly
    inside either passage."""
    need = len(terms) if match == "all" else 1
    own = {(r[0], r[1]): f" {norm(r[3])} " for r in rows}
    scored = []
    for vid, idx, start, text, joint, title in rows:
        base = f"{own[(vid, idx)]}| {norm(title)} "
        join = f" {norm(joint)} "
        nxt = own.get((vid, idx + 1), "")
        n = 0
        for t in terms:
            pad = f" {t} "
            if pad in base or (" " in t and pad in join and pad not in nxt):
                n += 1
        if n >= need:
            scored.append((-n, vid, idx, start, text))
    scored.sort()
    return [{"video_id": v, "idx": i, "seconds": st, "text": tx} for _, v, i, st, tx in scored[:int(limit)]]


def fuse(rankings: list, k: int = 60) -> list:
    """Merge several ranked lists of keys into one (reciprocal rank fusion): a key near the top of
    any list does well, and one found by several lists does better."""
    score: dict = {}
    for ranking in rankings:
        for rank, key in enumerate(ranking):
            score[key] = score.get(key, 0.0) + 1.0 / (k + rank + 1)
    return sorted(score, key=lambda key: (-score[key], key))


# ---------- embedding vectors (optional) -----------------------------------------

EMBED_CHARS = 2000          # at most this much of a passage is sent to be embedded; passages are about 400
PURE_PYTHON_VECTORS = 2000  # without numpy, vector ranking is refused past this many stored vectors
MAX_DIM = 8192
_SCAN_ROWS = 2048           # vectors read from disk at a time during a search, with numpy
_SCAN_ROWS_PLAIN = 128      # and without it, where a vector unpacked into Python numbers is many times larger


class VectorError(Exception):
    """A refusal to store or use vectors, with a message meant for the person."""


def embed_text(text: str) -> str:
    """The part of a passage that is embedded."""
    return " ".join(str(text).split())[:EMBED_CHARS]


def text_hash(text: str) -> str:
    """Ties a vector to the exact text it was made from. A passage whose text has changed since
    (the video was pulled again, or the index was rebuilt by another version) no longer matches,
    and its vector is not used."""
    return hashlib.sha1(embed_text(text).encode("utf-8")).hexdigest()[:20]


def unit_vector(values) -> list:
    """The numbers of one embedding, checked and scaled to length 1. Raises VectorError."""
    if not isinstance(values, (list, tuple)) or not (1 <= len(values) <= MAX_DIM):
        raise VectorError("an embedding was not a list of numbers")
    out = []
    try:
        for v in values:
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                raise VectorError("an embedding held something that is not a finite number")
            out.append(float(v))
        length = math.sqrt(math.fsum(v * v for v in out))
    except (OverflowError, ValueError):            # a whole number too large to be a float
        raise VectorError("an embedding held a number too large to use") from None
    if not math.isfinite(length) or length < 1e-12:
        raise VectorError("an embedding was all zeros")
    return [v / length for v in out]


def pack_vector(unit: list) -> bytes:
    return struct.pack(f"<{len(unit)}f", *unit)


def _numpy():
    """numpy when it is installed, else None. Tests replace this to exercise both paths."""
    try:
        import numpy
        return numpy
    except Exception:  # noqa: BLE001 - a broken install counts as absent
        return None


def _scores(blobs: list, queries: list, dim: int, np) -> list:
    """Dot products of each stored vector with each query: one list of floats per query.
    Everything is unit length, so this is the cosine similarity."""
    if np is not None:
        m = np.frombuffer(b"".join(blobs), dtype="<f4").reshape(len(blobs), dim)
        s = np.nan_to_num(m @ np.asarray(queries, dtype="<f4").T, nan=-1.0, posinf=-1.0, neginf=-1.0)
        return [s[:, i].tolist() for i in range(len(queries))]
    rows = [struct.unpack(f"<{dim}f", b) for b in blobs]
    out = []
    for q in queries:
        col = []
        for r in rows:
            v = math.fsum(map(float.__mul__, q, r))
            col.append(v if math.isfinite(v) else -1.0)
        out.append(col)
    return out


def clean_doc(doc: dict) -> dict:
    """A record in the one shape every caller sees, whatever wrote it."""
    segs = doc.get("segments") or []
    if isinstance(segs, str):
        try:
            segs = json.loads(segs)
        except ValueError:
            segs = []
    out = {k: doc.get(k) for k in META_FIELDS}
    out["video_id"] = str(doc.get("video_id") or "")
    for k in ("channel", "channel_handle", "channel_id", "title", "upload_date", "kind",
              "language", "source"):
        out[k] = str(out[k] or "")
    out["url"] = f"https://www.youtube.com/watch?v={out['video_id']}"    # built here, never taken from a record
    out["duration_seconds"] = int(out["duration_seconds"] or 0)
    out["view_count"] = int(out["view_count"] or 0)
    out["is_generated"] = bool(out["is_generated"])
    out["fetched_at"] = str(out["fetched_at"] or "")
    out["segments"] = [[float(s[0]), str(s[1])] for s in segs if isinstance(s, (list, tuple)) and len(s) >= 2]
    out["transcript"] = str(doc.get("transcript") or " ".join(s[1] for s in out["segments"]))
    return out


def meta_only(doc: dict) -> dict:
    out = {k: doc.get(k) for k in META_FIELDS}
    out["has_timestamps"] = bool(doc.get("segments"))
    out["transcript_chars"] = len(doc.get("transcript") or "")
    return out


def _channel_key(channel: str) -> str:
    return str(channel).strip().lstrip("@").lower()


# ---------- SQLite ------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY, channel TEXT, channel_handle TEXT, channel_id TEXT, title TEXT,
  url TEXT, duration_seconds INTEGER, view_count INTEGER, upload_date TEXT,
  kind TEXT, language TEXT, is_generated INTEGER,
  transcript TEXT, segments TEXT, source TEXT, fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS videos_channel ON videos (channel);
CREATE TABLE IF NOT EXISTS misses (
  video_id TEXT PRIMARY KEY, reason TEXT, permanent INTEGER, source TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS passages (
  id INTEGER PRIMARY KEY, video_id TEXT, idx INTEGER, start REAL, text TEXT, joint TEXT,
  UNIQUE (video_id, idx)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS vectors (
  passage_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL,
  text_hash TEXT NOT NULL, vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS vectors_kept (
  video_id TEXT NOT NULL, text_hash TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
  vec BLOB NOT NULL, PRIMARY KEY (video_id, text_hash)
);
CREATE TABLE IF NOT EXISTS embed_refused (
  passage_id INTEGER PRIMARY KEY, model TEXT NOT NULL, text_hash TEXT NOT NULL
);
"""
INDEX_VERSION = "2"


class SqliteStore:
    kind = "sqlite"

    def __init__(self, path: str, stemming: bool = True):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, timeout=60, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self.stemming = bool(stemming)
        self._tokenizer = "porter unicode61" if self.stemming else "unicode61"
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(_SCHEMA)
            self._db.commit()
            self._ensure_index()

    def _fts_available(self) -> bool:
        try:
            self._db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS temp.em_fts_probe USING fts5(x)")
            self._db.execute("DROP TABLE IF EXISTS temp.em_fts_probe")
            return True
        except sqlite3.OperationalError:
            return False                   # this Python's SQLite has no FTS5: search scans instead

    def _create_fts(self) -> None:
        self._db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5("
                         f"video_id UNINDEXED, idx UNINDEXED, title, body, joint, tokenize='{self._tokenizer}')")

    def _drop(self, table: str) -> None:
        try:
            self._db.execute(f"DROP TABLE IF EXISTS {table}")
        except sqlite3.OperationalError:
            pass                           # a full-text table this SQLite cannot open: left where it is, unused

    def _marker(self) -> str:
        r = self._db.execute("SELECT value FROM meta WHERE key = 'index'").fetchone()
        return r[0] if r else ""

    def _ensure_index(self) -> None:
        """Make the passage index match this version, this stemming setting and this SQLite.

        The marker records all three, including whether a full-text table was built. When it does
        not match, the index is emptied under a write lock; passages are then (re)built one video
        at a time in short transactions, so nothing else is locked out for long, a crash loses
        nothing, and the next open carries on. The videos table is never written here."""
        self.fts = self._fts_available()
        want = f"{INDEX_VERSION}|{self._tokenizer if self.fts else '-'}|{'fts' if self.fts else 'nofts'}"
        if self._marker() != want:
            self._db.commit()
            self._db.execute("BEGIN IMMEDIATE")
            try:
                if self._marker() != want:
                    self._drop("videos_fts")                     # the 0.1 whole-video index
                    self._drop("passages_fts")
                    # Passage ids are about to change. Vectors are set aside by video and text, and
                    # go back to the passages with the same text as each video is indexed again.
                    self._db.execute(
                        "INSERT OR REPLACE INTO vectors_kept (video_id, text_hash, model, dim, vec) "
                        "SELECT p.video_id, x.text_hash, x.model, x.dim, x.vec FROM vectors x "
                        "JOIN passages p ON p.id = x.passage_id")
                    self._db.execute("DELETE FROM vectors")
                    self._db.execute("DELETE FROM passages")
                    if self.fts:
                        self._create_fts()
                    self._db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('index', ?)", (want,))
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        elif self._db.execute("SELECT 1 FROM sqlite_master WHERE name = 'videos_fts'").fetchone():
            self._drop("videos_fts")       # a 0.1 process opened this corpus again and put it back
            self._db.commit()
        self.repair()

    def repair(self) -> int:
        """Index every video that has no passages: after the index was emptied, or because a
        process of the first version stored it. Returns how many were indexed."""
        with self._lock:
            ids = [r[0] for r in self._db.execute(
                "SELECT v.video_id FROM videos v WHERE NOT EXISTS "
                "(SELECT 1 FROM passages p WHERE p.video_id = v.video_id)").fetchall()]
            for n, vid in enumerate(ids, 1):
                r = self._db.execute("SELECT * FROM videos WHERE video_id = ?", (vid,)).fetchone()
                if r is not None:
                    self._index(clean_doc(dict(r)))
                if n % 20 == 0:
                    self._db.commit()
            self._db.commit()
        return len(ids)

    def index_info(self) -> dict:
        """What the index on disk is now, which another process may have changed since this one opened."""
        with self._lock:
            parts = (self._marker().split("|") + ["", "", ""])[:3]
        return {"stemming": parts[1].startswith("porter"), "full_text": parts[2] == "fts"}

    def _index(self, d: dict) -> None:
        # A passage's row in the full-text table has the passage's own id, so both are reached directly.
        vid = d["video_id"]
        # A passage's vector must never outlive the passage: ids are reused. The video's vectors are
        # taken out here and given back only to new passages whose text is exactly what was embedded.
        kept = {r[0]: (r[1], r[2], r[3]) for r in self._db.execute(
            "SELECT text_hash, model, dim, vec FROM vectors_kept WHERE video_id = ?", (vid,))}
        kept.update({r[0]: (r[1], r[2], r[3]) for r in self._db.execute(
            "SELECT x.text_hash, x.model, x.dim, x.vec FROM vectors x JOIN passages p ON p.id = x.passage_id "
            "WHERE p.video_id = ?", (vid,))})
        self._db.execute("DELETE FROM vectors WHERE passage_id IN (SELECT id FROM passages WHERE video_id = ?)", (vid,))
        self._db.execute("DELETE FROM vectors_kept WHERE video_id = ?", (vid,))
        if self.fts:
            self._db.execute("DELETE FROM passages_fts WHERE rowid IN (SELECT id FROM passages WHERE video_id = ?)",
                             (vid,))
        self._db.execute("DELETE FROM passages WHERE video_id = ?", (vid,))
        for idx, start, text, joint in make_passages(d):
            pid = self._db.execute(
                "INSERT INTO passages (video_id, idx, start, text, joint) VALUES (?, ?, ?, ?, ?)",
                (d["video_id"], idx, start, text, joint)).lastrowid
            # An id can be handed out again after a process of an older version removed passages
            # without their vectors, so whatever vector sits on this id is not this passage's.
            self._db.execute("DELETE FROM vectors WHERE passage_id = ?", (pid,))
            old = kept.get(text_hash(text)) if kept else None
            if old:
                self._db.execute("INSERT OR REPLACE INTO vectors (passage_id, model, dim, text_hash, vec) "
                                 "VALUES (?, ?, ?, ?, ?)", (pid, old[0], old[1], text_hash(text), old[2]))
            if self.fts:                   # the title is searched as part of the video's first passage only
                self._db.execute(
                    "INSERT OR REPLACE INTO passages_fts (rowid, video_id, idx, title, body, joint) VALUES (?, ?, ?, ?, ?, ?)",
                    (pid, d["video_id"], idx, d["title"] if idx == 0 else "", text, joint))

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def upsert_video(self, doc: dict) -> None:
        d = clean_doc(doc)
        row = [d[k] for k in META_FIELDS]
        row[META_FIELDS.index("is_generated")] = int(d["is_generated"])
        cols = ", ".join(META_FIELDS) + ", transcript, segments"
        marks = ", ".join("?" for _ in range(len(META_FIELDS) + 2))
        with self._lock:
            self._db.execute(f"INSERT OR REPLACE INTO videos ({cols}) VALUES ({marks})",
                             row + [d["transcript"], json.dumps(d["segments"], ensure_ascii=False)])
            self._index(d)
            self._db.execute("DELETE FROM misses WHERE video_id = ?", (d["video_id"],))
            self._db.commit()

    def has_video(self, video_id: str) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM videos WHERE video_id = ?", (video_id,)).fetchone() is not None

    def get_video(self, video_id: str) -> Optional[dict]:
        with self._lock:
            r = self._db.execute("SELECT * FROM videos WHERE video_id = ?", (video_id,)).fetchone()
        return clean_doc(dict(r)) if r else None

    def record_miss(self, video_id: str, reason: str, permanent: bool, source: str) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO misses (video_id, reason, permanent, source, at) "
                             "VALUES (?, ?, ?, ?, ?)", (video_id, reason, int(permanent), source, now_iso()))
            self._db.commit()

    def get_miss(self, video_id: str) -> Optional[dict]:
        with self._lock:
            r = self._db.execute("SELECT * FROM misses WHERE video_id = ?", (video_id,)).fetchone()
        return {**dict(r), "permanent": bool(r["permanent"])} if r else None

    def channels(self) -> list:
        with self._lock:
            rows = self._db.execute(
                "SELECT channel, MAX(channel_handle) AS channel_handle, COUNT(*) AS videos, "
                "SUM(CASE WHEN segments != '[]' THEN 1 ELSE 0 END) AS with_timestamps, "
                "SUM(duration_seconds) AS seconds, MIN(NULLIF(upload_date, '')) AS oldest, "
                "MAX(upload_date) AS newest, MAX(fetched_at) AS last_pulled "
                "FROM videos GROUP BY channel ORDER BY videos DESC").fetchall()
        return [dict(r) for r in rows]

    def _where_channel(self, channel: Optional[str], prefix: str = "") -> tuple:
        if not channel:
            return "", []
        key = _channel_key(channel)
        return (f" AND (lower({prefix}channel) = ? OR lower(ltrim({prefix}channel_handle, '@')) = ?)",
                [key, key])

    def videos(self, channel: Optional[str] = None, limit: int = 50, offset: int = 0) -> tuple:
        where, args = self._where_channel(channel)
        cols = ", ".join(META_FIELDS)
        with self._lock:
            total = self._db.execute(f"SELECT COUNT(*) FROM videos WHERE 1=1{where}", args).fetchone()[0]
            rows = self._db.execute(
                f"SELECT {cols}, segments != '[]' AS has_timestamps, length(transcript) AS transcript_chars "
                f"FROM videos WHERE 1=1{where} ORDER BY upload_date DESC, fetched_at DESC, video_id "
                f"LIMIT ? OFFSET ?", args + [int(limit), int(offset)]).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["has_timestamps"] = bool(d["has_timestamps"])
            d["is_generated"] = bool(d["is_generated"])
            out.append(d)
        return out, total

    def search_passages(self, terms: list, match: str = "ranked", channel: Optional[str] = None,
                        limit: int = 60) -> list:
        """Passages for the terms, best first: [{video_id, idx, seconds, text}]. `terms` are
        normalised words and phrases (parse_query), so nothing in them can alter the query."""
        if not terms:
            return []
        where, args = self._where_channel(channel, "v.")
        as_hit = lambda r: {"video_id": r[0], "idx": r[1], "seconds": r[2], "text": r[3]}   # noqa: E731
        own = lambda t: '{title body} : "' + t + '"'                                          # noqa: E731

        def row_holds(pid, expr: str) -> bool:
            return pid is not None and self._db.execute(
                "SELECT 1 FROM passages_fts WHERE passages_fts MATCH ? AND rowid = ?", (expr, pid)).fetchone() is not None

        with self._lock:
            if self.fts:
                # Every term in the passage's own words (for a first passage, its video's title too).
                hits = [as_hit(r) for r in self._db.execute(
                    "SELECT p.video_id, p.idx, p.start, p.text FROM passages_fts f "
                    "JOIN passages p ON p.id = f.rowid JOIN videos v ON v.video_id = p.video_id "
                    f"WHERE passages_fts MATCH ?{where} "
                    "ORDER BY bm25(passages_fts, 0.0, 0.0, 0.3, 1.0, 0.0), p.video_id, p.idx LIMIT ?",
                    [(" AND " if match == "all" else " OR ").join(own(t) for t in terms)] + args + [int(limit)])]
                # A phrase may also lie across the join with the next passage. Each passage whose join
                # text matches is checked by itself: the phrase must be in the own words of neither it
                # nor the next one, or it does not cross and belongs to one of them. A cap on how many
                # are looked at can only miss such a passage, never admit a wrong one. The few found
                # go first: the phrase was asked for as written and it is there.
                have = {(h["video_id"], h["idx"]) for h in hits}
                extra, seen = [], set()
                for t in (t for t in terms if " " in t):
                    body = '{body} : "' + t + '"'
                    cands = self._db.execute(
                        "SELECT p.id, p.video_id, p.idx, p.start, p.text FROM passages_fts f "
                        "JOIN passages p ON p.id = f.rowid JOIN videos v ON v.video_id = p.video_id "
                        f"WHERE passages_fts MATCH ?{where} ORDER BY p.video_id, p.idx LIMIT ?",
                        ['{joint} : "' + t + '"'] + args + [JOIN_CANDIDATES]).fetchall()
                    for pid, vid, idx, start, text in cands:
                        if len(extra) >= CROSS_FIRST:
                            break
                        if (vid, idx) in have or (vid, idx) in seen or row_holds(pid, body):
                            continue
                        nxt = self._db.execute("SELECT id FROM passages WHERE video_id = ? AND idx = ?",
                                               (vid, idx + 1)).fetchone()
                        if row_holds(nxt[0] if nxt else None, body):
                            continue
                        rest = [u for u in terms if u != t]
                        if match == "all" and rest and not row_holds(pid, " AND ".join(own(u) for u in rest)):
                            continue
                        seen.add((vid, idx))
                        extra.append(as_hit((vid, idx, start, text)))
                return (extra + hits)[:int(limit)]
            cond, largs = "1=1", []
            if all(t.isascii() for t in terms):          # SQLite lower-cases ASCII only: else read every row
                cond = " OR ".join("lower(p.text) LIKE ? OR lower(p.joint) LIKE ? OR lower(v.title) LIKE ?" for _ in terms)
                for t in terms:
                    largs += [f"%{t.split()[0]}%"] * 3
            rows = self._db.execute(
                "SELECT p.video_id, p.idx, p.start, p.text, p.joint, CASE WHEN p.idx = 0 THEN v.title ELSE '' END "
                f"FROM passages p JOIN videos v ON v.video_id = p.video_id WHERE ({cond}){where} "
                "ORDER BY p.video_id, p.idx LIMIT 50000", largs + args).fetchall()
        return rank_rows([tuple(r) for r in rows], terms, match, limit)

    def video_meta(self, video_ids: list) -> dict:
        if not video_ids:
            return {}
        marks = ", ".join("?" for _ in video_ids)
        with self._lock:
            rows = self._db.execute(
                f"SELECT video_id, title, channel, upload_date, view_count FROM videos "
                f"WHERE video_id IN ({marks})", list(video_ids)).fetchall()
        return {r["video_id"]: dict(r) for r in rows}

    # ----- embedding vectors -----

    def _embed_marker(self) -> Optional[dict]:
        r = self._db.execute("SELECT value FROM meta WHERE key = 'embed'").fetchone()
        try:
            m = json.loads(r[0]) if r else None
            return {"model": str(m["model"]), "dim": int(m["dim"])} if m else None
        except (ValueError, KeyError, TypeError):
            return None

    def vector_info(self) -> dict:
        """Which model the stored vectors were made by, and how many there are. The count is of
        rows: one whose passage text was changed since by a process that knew nothing of vectors
        is still counted here, is not used, and is owed again (count_pending is exact)."""
        with self._lock:
            m = self._embed_marker()
            total = self._db.execute("SELECT COUNT(*) FROM passages").fetchone()[0]
            n = 0
            if m:
                n = self._db.execute(
                    "SELECT COUNT(*) FROM vectors x JOIN passages p ON p.id = x.passage_id "
                    "WHERE x.model = ? AND x.dim = ?", (m["model"], m["dim"])).fetchone()[0]
        return {"model": m["model"] if m else "", "dim": m["dim"] if m else 0, "vectors": n, "passages": total}

    def pending_passages(self, model: str, after_id: int = 0, limit: int = 32, scan: int = 500,
                         _refused: Optional[list] = None) -> tuple:
        """Passages with no usable vector by this model, in id order from after_id on:
        ([(id, text_to_embed)], last_id_looked_at, reached_the_end). A passage the endpoint
        refused when it was sent alone is left out for as long as its text stays the same."""
        out: list = []
        last = int(after_id)
        with self._lock:
            while len(out) < limit:
                rows = self._db.execute(
                    "SELECT p.id, p.text, x.text_hash, r.text_hash FROM passages p "
                    "LEFT JOIN vectors x ON x.passage_id = p.id AND x.model = ? "
                    "LEFT JOIN embed_refused r ON r.passage_id = p.id AND r.model = ? "
                    "WHERE p.id > ? ORDER BY p.id LIMIT ?", (model, model, last, int(scan))).fetchall()
                if not rows:
                    return out, last, True
                if after_id == 0 and last == 0:        # a fresh pass: drop records of passages that are gone
                    self._db.execute("DELETE FROM embed_refused WHERE passage_id NOT IN (SELECT id FROM passages)")
                    self._db.commit()
                for pid, text, have, refused in rows:
                    last = pid
                    body = embed_text(text)
                    if not body:
                        continue
                    h = text_hash(text)
                    if have == h:
                        continue
                    if refused == h:
                        if _refused is not None:
                            _refused.append(pid)
                        continue
                    out.append((pid, body))
                    if len(out) >= limit:
                        break
        return out, last, False

    def count_pending(self, model: str) -> dict:
        """How much an embedding run would send: passages and characters. `refused` counts the
        passages the endpoint would not take when sent alone, which a run leaves out."""
        n = chars = last = 0
        refused: list = []
        while True:
            got, last, end = self.pending_passages(model, last, limit=2000, scan=2000, _refused=refused)
            n += len(got)
            chars += sum(len(t) for _, t in got)
            if end:
                return {"passages": n, "characters": chars, "refused": len(refused)}

    def record_refused(self, model: str, passage_id: int, body: str) -> None:
        """Remember that the endpoint would not embed this passage, so that later runs go past it."""
        with self._lock:
            r = self._db.execute("SELECT text FROM passages WHERE id = ?", (passage_id,)).fetchone()
            if r is not None and embed_text(r[0]) == body:
                self._db.execute("INSERT OR REPLACE INTO embed_refused (passage_id, model, text_hash) VALUES (?, ?, ?)",
                                 (passage_id, model, text_hash(r[0])))
                self._db.commit()

    def forget_refused(self, passage_ids: list) -> None:
        with self._lock:
            self._db.executemany("DELETE FROM embed_refused WHERE passage_id = ?", [(int(i),) for i in passage_ids])
            self._db.commit()

    def clear_refused(self) -> int:
        with self._lock:
            n = self._db.execute("SELECT COUNT(*) FROM embed_refused").fetchone()[0]
            self._db.execute("DELETE FROM embed_refused")
            self._db.commit()
        return n

    def store_vectors(self, model: str, dim: int, rows: list) -> int:
        """Store [(passage_id, text_embedded, unit_vector)]. One model per corpus: the first vector
        stored fixes the model and the vector size, and anything else is refused until
        clear_vectors. A vector is stored only if its passage still holds the text that was sent."""
        dim = int(dim)
        with self._lock:
            self._db.commit()
            self._db.execute("BEGIN IMMEDIATE")
            try:
                m = self._embed_marker()
                if m and (m["model"] != model or m["dim"] != dim):
                    raise VectorError(
                        f"this corpus holds vectors made by {m['model']} ({m['dim']} numbers each); vectors by "
                        f"{model} ({dim}) cannot be mixed with them. Start the embedding again with reembed to "
                        "change model: that removes the stored vectors first.")
                if not m:
                    if self._db.execute("SELECT 1 FROM vectors LIMIT 1").fetchone() or \
                            self._db.execute("SELECT 1 FROM vectors_kept LIMIT 1").fetchone():
                        raise VectorError("this corpus holds vectors with no record of the model that made them. "
                                          "Start the embedding again with reembed.")
                    self._db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('embed', ?)",
                                     (json.dumps({"model": model, "dim": dim}),))
                stored = 0
                for pid, body, unit in rows:
                    if len(unit) != dim:
                        raise VectorError("the endpoint returned vectors of different sizes")
                    r = self._db.execute("SELECT text FROM passages WHERE id = ?", (pid,)).fetchone()
                    if r is None or embed_text(r[0]) != body:
                        continue               # the passage changed while its text was away
                    self._db.execute("INSERT OR REPLACE INTO vectors (passage_id, model, dim, text_hash, vec) "
                                     "VALUES (?, ?, ?, ?, ?)", (pid, model, dim, text_hash(r[0]), pack_vector(unit)))
                    stored += 1
                self._db.commit()
                return stored
            except Exception:
                self._db.rollback()
                raise

    def clear_vectors(self) -> int:
        """Forget every vector and the model they were made by. Returns how many were removed."""
        with self._lock:
            self._db.commit()
            self._db.execute("BEGIN IMMEDIATE")
            try:
                n = self._db.execute("SELECT COUNT(*) FROM vectors").fetchone()[0]
                self._db.execute("DELETE FROM vectors")
                self._db.execute("DELETE FROM vectors_kept")
                self._db.execute("DELETE FROM embed_refused")
                self._db.execute("DELETE FROM meta WHERE key = 'embed'")
                self._db.commit()
                return n
            except Exception:
                self._db.rollback()
                raise

    def search_vectors(self, queries: list, model: str, channel: Optional[str] = None, limit: int = 60) -> list:
        """For each query (a unit vector), the passages whose vectors lie closest, best first:
        one list of [{video_id, idx, seconds, text, score}] per query. Only vectors made by `model`
        are read, and a vector whose passage text has changed since is left out. Vectors are read
        from disk a block at a time, so memory does not grow with the corpus. Without numpy the
        blocks are small, the corpus is limited, and a search is slow: seconds near the limit."""
        if not queries:
            return []
        np = _numpy()
        where, args = self._where_channel(channel, "v.")
        with self._lock:
            m = self._embed_marker()
            if not m or m["model"] != model:
                raise VectorError("the stored vectors were not made by the configured model")
            dim = m["dim"]
            if any(len(q) != dim for q in queries):
                raise VectorError(f"the endpoint now returns vectors of a different size than the {dim} stored")
            if np is None:
                n = self._db.execute("SELECT COUNT(*) FROM vectors WHERE model = ? AND dim = ?", (model, dim)).fetchone()[0]
                if n > PURE_PYTHON_VECTORS:
                    raise VectorError(f"ranking {n} vectors needs the numpy package (without it the limit is "
                                      f"{PURE_PYTHON_VECTORS})")
            cur = self._db.execute(
                "SELECT x.passage_id, x.vec FROM vectors x JOIN passages p ON p.id = x.passage_id "
                f"JOIN videos v ON v.video_id = p.video_id WHERE x.model = ? AND x.dim = ?{where}",
                [model, dim] + args)
            tops: list = [[] for _ in queries]
            while True:
                chunk = cur.fetchmany(_SCAN_ROWS if np is not None else _SCAN_ROWS_PLAIN)
                if not chunk:
                    break
                good = [(r[0], r[1]) for r in chunk if isinstance(r[1], bytes) and len(r[1]) == dim * 4]
                if not good:
                    continue
                scores = _scores([b for _, b in good], queries, dim, np)
                for qi, col in enumerate(scores):
                    tops[qi] = heapq.nsmallest(int(limit), tops[qi] + [(-s, pid) for s, (pid, _) in zip(col, good)])
            out = []
            for top in tops:
                hits = []
                for neg, pid in top:
                    r = self._db.execute(
                        "SELECT p.video_id, p.idx, p.start, p.text, x.text_hash FROM passages p "
                        "JOIN vectors x ON x.passage_id = p.id WHERE p.id = ?", (pid,)).fetchone()
                    if r is None or r[4] != text_hash(r[3]):
                        continue               # the passage was replaced after its vector was made
                    hits.append({"video_id": r[0], "idx": r[1], "seconds": r[2], "text": r[3], "score": round(-neg, 4)})
                out.append(hits)
        return out

    def stats(self) -> dict:
        with self._lock:
            n, ts = self._db.execute(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN segments != '[]' THEN 1 ELSE 0 END), 0) "
                "FROM videos").fetchone()
            misses = self._db.execute("SELECT COUNT(*) FROM misses").fetchone()[0]
            passages_n = self._db.execute("SELECT COUNT(*) FROM passages").fetchone()[0]
        return {"videos": n, "with_timestamps": ts, "passages": passages_n, "recorded_misses": misses}


# ---------- MongoDB -----------------------------------------------------------


class MongoStore:
    """Optional. Reads records written by other tools too, as long as they carry video_id and
    transcript; such records have no timed lines until they are pulled again."""

    kind = "mongo"

    def __init__(self, cfg: dict):
        try:
            from pymongo import MongoClient
        except ImportError:
            raise RuntimeError("MongoDB storage needs the pymongo package") from None
        if cfg.get("uri"):
            self._client = MongoClient(cfg["uri"], serverSelectionTimeoutMS=15000)
        else:
            kw = {"host": cfg["host"], "port": cfg["port"], "serverSelectionTimeoutMS": 15000}
            if cfg.get("user"):
                kw.update(username=cfg["user"], password=cfg["password"], authSource=cfg["auth_source"])
            self._client = MongoClient(**kw)
        db = self._client[cfg["db"]]
        self._videos = db[cfg["collection"]]
        self._misses = db[cfg["collection"] + "_misses"]

    def close(self) -> None:
        self._client.close()

    def upsert_video(self, doc: dict) -> None:
        d = clean_doc(doc)
        self._videos.update_one({"video_id": d["video_id"]}, {"$set": d}, upsert=True)
        self._misses.delete_one({"video_id": d["video_id"]})

    def has_video(self, video_id: str) -> bool:
        return self._videos.find_one({"video_id": video_id}, {"_id": 1}) is not None

    def get_video(self, video_id: str) -> Optional[dict]:
        r = self._videos.find_one({"video_id": video_id}, {"_id": 0})
        return clean_doc(r) if r else None

    def record_miss(self, video_id: str, reason: str, permanent: bool, source: str) -> None:
        self._misses.update_one({"video_id": video_id}, {"$set": {
            "video_id": video_id, "reason": reason, "permanent": bool(permanent),
            "source": source, "at": now_iso()}}, upsert=True)

    def get_miss(self, video_id: str) -> Optional[dict]:
        return self._misses.find_one({"video_id": video_id}, {"_id": 0})

    @staticmethod
    def _channel_filter(channel: Optional[str]) -> dict:
        if not channel:
            return {}
        key = re.escape(_channel_key(channel))
        return {"$or": [{"channel": {"$regex": f"^{key}$", "$options": "i"}},
                        {"channel_handle": {"$regex": f"^@?{key}$", "$options": "i"}}]}

    def channels(self) -> list:
        rows = self._videos.aggregate([{"$group": {
            "_id": "$channel", "channel_handle": {"$max": "$channel_handle"}, "videos": {"$sum": 1},
            "with_timestamps": {"$sum": {"$cond": [{"$gt": [{"$size": {"$ifNull": ["$segments", []]}}, 0]}, 1, 0]}},
            "seconds": {"$sum": {"$ifNull": ["$duration_seconds", 0]}},
            "newest": {"$max": "$upload_date"}}}, {"$sort": {"videos": -1}}])
        return [{"channel": r["_id"], **{k: v for k, v in r.items() if k != "_id"}} for r in rows]

    def videos(self, channel: Optional[str] = None, limit: int = 50, offset: int = 0) -> tuple:
        flt = self._channel_filter(channel)
        total = self._videos.count_documents(flt)
        cur = (self._videos.find(flt, {"_id": 0}).sort([("upload_date", -1), ("video_id", 1)])
               .skip(int(offset)).limit(int(limit)))
        return [meta_only(clean_doc(r)) for r in cur], total

    def search_passages(self, terms: list, match: str = "ranked", channel: Optional[str] = None,
                        limit: int = 60) -> list:
        """As the SQLite one, without an index: the matching videos are found with regular
        expressions, then their passages are scored here by how many terms each holds. No stemming."""
        if not terms:
            return []
        per = []
        for t in terms:
            rx = r"\W+".join(re.escape(w) for w in t.split())
            per.append({"$or": [{"transcript": {"$regex": rx, "$options": "i"}},
                                {"title": {"$regex": rx, "$options": "i"}}]})
        flt: dict = {"$and": per} if match == "all" else {"$or": per}
        ch = self._channel_filter(channel)
        if ch:
            flt = {"$and": [flt, ch]}
        rows = []
        for r in self._videos.find(flt, {"_id": 0}).sort([("view_count", -1)]).limit(40):
            d = clean_doc(r)
            rows += [(d["video_id"], idx, start, text, joint, d["title"] if idx == 0 else "")
                     for idx, start, text, joint in make_passages(d)]
        return rank_rows(rows, terms, match, limit)

    def video_meta(self, video_ids: list) -> dict:
        cur = self._videos.find({"video_id": {"$in": list(video_ids)}},
                                {"_id": 0, "video_id": 1, "title": 1, "channel": 1, "upload_date": 1, "view_count": 1})
        return {r["video_id"]: {"video_id": r["video_id"], "title": str(r.get("title") or ""),
                                "channel": str(r.get("channel") or ""), "upload_date": str(r.get("upload_date") or ""),
                                "view_count": int(r.get("view_count") or 0)} for r in cur}

    def stats(self) -> dict:
        return {"videos": self._videos.estimated_document_count(),
                "with_timestamps": self._videos.count_documents({"segments.0": {"$exists": True}}),
                "recorded_misses": self._misses.estimated_document_count()}


def open_store(cfg: dict):
    if cfg["kind"] == "sqlite":
        return SqliteStore(cfg["path"], stemming=cfg.get("stemming", True))
    return MongoStore(cfg)
