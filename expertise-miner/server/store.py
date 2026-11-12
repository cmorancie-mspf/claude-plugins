"""Where transcripts are kept: a local SQLite file by default, MongoDB when asked for.

One record per video, keyed on video_id. A record holds the transcript twice: as one text
(`transcript`, for search) and as timed lines (`segments`, a list of [start_seconds, text]),
which is what lets a quote be traced to a moment in the video.
"""
from __future__ import annotations

import bisect
import json
import re
import sqlite3
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
        if n and n not in terms:
            terms.append(n)
    return terms[:12]


def passages(doc: dict, terms: list, max_passages: int = 3, context: int = 2) -> dict:
    """Where the terms occur in one video: a few passages with their timestamps."""
    segments = doc.get("segments") or []
    if not segments:
        text = doc.get("transcript") or ""
        found = []
        for t in terms:
            m = re.search(r"\W+".join(re.escape(w) for w in t.split()), text, flags=re.I)
            if m:
                a, b = max(0, m.start() - 160), min(len(text), m.end() + 240)
                found.append({"timestamp": None, "text": text[a:b].strip()})
            if len(found) >= max_passages:
                break
        return {"hits": len(found), "passages": found}
    tt = TimedText(segments)
    hit_idx = sorted({i for t in terms for i in tt.find_all(t)})
    out: list = []
    last_end = -1
    for i in hit_idx:
        if i <= last_end:
            continue
        a, b = max(0, i - 1), min(len(segments), i + context + 1)
        last_end = b - 1
        out.append({
            "timestamp": int(tt.start(a)),
            "text": " ".join(str(s[1]).strip() for s in segments[a:b]),
        })
        if len(out) >= max_passages:
            break
    return {"hits": len(hit_idx), "passages": out}


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
"""


class SqliteStore:
    kind = "sqlite"

    def __init__(self, path: str):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, timeout=30, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(_SCHEMA)
            try:
                self._db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5("
                                 "video_id UNINDEXED, title, transcript, tokenize='unicode61')")
                self.fts = True
            except sqlite3.OperationalError:
                self.fts = False  # this Python's SQLite has no FTS5: search falls back to a scan
            self._db.commit()

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
            if self.fts:
                self._db.execute("DELETE FROM videos_fts WHERE video_id = ?", (d["video_id"],))
                self._db.execute("INSERT INTO videos_fts (video_id, title, transcript) VALUES (?, ?, ?)",
                                 (d["video_id"], d["title"], d["transcript"]))
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

    def search(self, terms: list, any_term: bool = False, channel: Optional[str] = None,
               limit: int = 10) -> list:
        if not terms:
            return []
        joiner = " OR " if any_term else " AND "
        with self._lock:
            if self.fts:
                where, args = self._where_channel(channel, "v.")
                match = joiner.join('"' + t + '"' for t in terms)
                rows = self._db.execute(
                    "SELECT v.* FROM videos_fts f JOIN videos v ON v.video_id = f.video_id "
                    f"WHERE videos_fts MATCH ?{where} ORDER BY bm25(videos_fts) LIMIT ?",
                    [match] + args + [int(limit)]).fetchall()
            else:
                where, args = self._where_channel(channel)
                like = joiner.join("(lower(transcript) LIKE ? OR lower(title) LIKE ?)" for _ in terms)
                largs: list = []
                for t in terms:
                    largs += [f"%{t}%", f"%{t}%"]
                rows = self._db.execute(
                    f"SELECT * FROM videos WHERE ({like}){where} ORDER BY view_count DESC LIMIT ?",
                    largs + args + [int(limit)]).fetchall()
        return [clean_doc(dict(r)) for r in rows]

    def stats(self) -> dict:
        with self._lock:
            n, ts = self._db.execute(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN segments != '[]' THEN 1 ELSE 0 END), 0) "
                "FROM videos").fetchone()
            misses = self._db.execute("SELECT COUNT(*) FROM misses").fetchone()[0]
        return {"videos": n, "with_timestamps": ts, "recorded_misses": misses}


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

    def search(self, terms: list, any_term: bool = False, channel: Optional[str] = None,
               limit: int = 10) -> list:
        if not terms:
            return []
        per = []
        for t in terms:
            rx = r"\W+".join(re.escape(w) for w in t.split())
            per.append({"$or": [{"transcript": {"$regex": rx, "$options": "i"}},
                                {"title": {"$regex": rx, "$options": "i"}}]})
        flt: dict = {"$or": per} if any_term else {"$and": per}
        ch = self._channel_filter(channel)
        if ch:
            flt = {"$and": [flt, ch]}
        cur = self._videos.find(flt, {"_id": 0}).sort([("view_count", -1)]).limit(int(limit))
        return [clean_doc(r) for r in cur]

    def stats(self) -> dict:
        return {"videos": self._videos.estimated_document_count(),
                "with_timestamps": self._videos.count_documents({"segments.0": {"$exists": True}}),
                "recorded_misses": self._misses.estimated_document_count()}


def open_store(cfg: dict):
    return SqliteStore(cfg["path"]) if cfg["kind"] == "sqlite" else MongoStore(cfg)
