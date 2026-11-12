# expertise-miner

Find out how an expert actually works, from what they have said on YouTube.

It does two jobs:

1. **Builds a corpus.** Pulls the transcripts of a channel, a playlist or a single video into a local database, and searches them.
2. **Mines it.** Reads those transcripts for the expert's **research questions**, **rules of thumb** and **research steps**. Each item carries the speaker's exact words, the video, the moment they were said, and a way to test the item against data.

It is not a picks scraper. "Take the home side on Saturday" is left out. "I never back a home side until I have checked who is rested" is kept, as a rule that can be checked.

It knows nothing about any one subject. The same steps work on a surgeon, a poker player, a fund manager or a chess coach.

> **Read this before you run it.**
>
> - It makes automated requests to YouTube from your address: a few to list a channel, then for each video a transcript fetch and, by default, a read of its page for the upload date and view count. Each of those is itself several HTTP requests (about three for a transcript). It is slow on purpose. YouTube may still refuse or throttle an address that asks for a lot; when that happens the pull stops itself and tells you.
> - Whether collecting and studying a channel's transcripts is acceptable for your purpose is your decision. Use it on material you are entitled to study.
> - Transcripts are strangers' words, and often machine-made captions. Mined items report what was **said**. Nothing here checks whether it is **true**.
> - **Status: new.** Tried by its author on Windows, on a handful of videos, with SQLite and no proxy. The MongoDB and proxy paths are covered by automated tests of their settings only and have not been run against a live server by this release.

## Use

In any Claude Code chat:

| Type | What happens |
|---|---|
| `/yt-pull @SomeChannel` | Agrees the size with you, then pulls the transcripts in the background |
| `/yt-search "position sizing"` | Finds where it was said, with quotes and links that open the video at that moment |
| `/mine-expertise @SomeChannel` | Reads the stored videos, checks every quote, clusters the items, writes the files |

Or say it in words: "pull the transcripts for this playlist", "what does she say about stop losses", "build a question bank from this channel".

### What mining produces

A run folder in your project, holding:

| File | Holds |
|---|---|
| `expertise.jsonl` | One line per item |
| `clusters.jsonl` | One line per cluster of items that make the same claim, with all its evidence |
| `summary.md` | The clusters by type, most widely supported first, with quotes and timestamped links |
| `rejected.jsonl` | What was thrown away, and why |

One item:

```json
{"id": "3f2a9c1b7e", "type": "rule_of_thumb",
 "text": "Recent minutes predict a player's output better than the season average does.",
 "quote": "i don't care what he averaged on the year i care what he played the last five games",
 "video_id": "abcdefghijk", "timestamp": 845, "timestamp_label": "14:05",
 "url": "https://www.youtube.com/watch?v=abcdefghijk&t=845s",
 "channel": "Some Expert", "title": "How I research", "upload_date": "20250114",
 "testable_as": "Forecast next-game output from last-five-game minutes and from season minutes; compare average error.",
 "cluster_id": "C004", "cluster_label": "Recent minutes beat season averages"}
```

`type` is `question`, `rule_of_thumb` or `research_step`.

## How mining is kept honest

A model reading a long transcript will sometimes write down a quote that was never said. So the reading and the checking are separate:

| Step | Who | What stops a wrong item |
|---|---|---|
| Read one video, write items | A `transcript-reader` agent per video, with file reading and writing only and no other tools | It is given two file paths and no hint of what to find |
| Check every quote | The `mine_verify` tool, plain code | A quote must appear in the stored transcript word for word (case, punctuation and line breaks aside). If it does not, the item is rejected. If it does, the item's timestamp is set to where the quote was found, whatever the reader wrote |
| Group items across videos | The main session | `mine_build` checks every item's quote against the stored transcript a second time, and rebuilds its link, title, channel and timestamp from the stored record, so a `verified.jsonl` that was edited after the check is refused. It also refuses a cluster that names an unknown item, uses an item twice or mixes types |

What this does **not** do: it does not check that an item's `text` is a fair reading of its quote, that `testable_as` is a good test, or that a cluster's label and statement are fair to its items. Those are a model's judgement, and a model that read a hostile transcript wrote some of them. The quote and the link are there so that you can check them yourself.

## What installing does, and does not do

Installing copies the skills, the agent and the server, and registers an MCP server named `expertise-miner` in every Claude Code session. It does **not** install Python packages. On first use `setup_check` says what is missing and prints the exact install command; Claude runs it only when you agree.

| Needed | For | How it arrives |
|---|---|---|
| Node 18 or later | Starting the server | You install it |
| Python 3.9 or later | The server | You install it |
| `yt-dlp`, `youtube-transcript-api` | Pulling. Search and mining of an existing corpus work without them | `pip install yt-dlp youtube-transcript-api`, into the Python the server uses: `setup_check` prints the exact command |
| `pymongo` | Only if you choose MongoDB | `pip install pymongo`, into that same Python |

The server looks for a working Python by trying `py -3` (Windows), `python3` and `python`, and uses the first that reports version 3.9 or later. To choose one, set `EXPERTISE_MINER_PYTHON` to its full path in your environment.

## Settings

With no settings at all, transcripts go to a SQLite file and requests go out directly. That is the intended way to start.

Settings are read from your environment, or from a file named `.env` in the data folder, which is `.expertise-miner` in your home folder. The environment wins. [`.env.example`](.env.example) lists every name; copy it there and fill in what you need. A `.env` in the project you happen to be working in is **not** read. (Claude Code's own project settings can still set environment variables for a session, as they can for any tool; that is outside this plugin.)

| Name | Does | Default |
|---|---|---|
| `EXPERTISE_MINER_HOME` | The data folder. Environment only | `.expertise-miner` in your home folder |
| `EXPERTISE_MINER_PYTHON` | The Python to run under. Environment only | Found automatically |
| `EXPERTISE_MINER_DB` | The SQLite file | `corpus.db` in the data folder |
| `EXPERTISE_MINER_STORE` | `mongo` to use MongoDB | `sqlite` |
| `MONGO_URI`, or `MONGO_HOST` `MONGO_PORT` `MONGO_USER` `MONGO_PASS` `MONGO_AUTH_SOURCE` | The MongoDB server | |
| `MONGO_DB`, `MONGO_COLLECTION` | Where in it | `expertise_miner`, `videos` |
| `PROXY_URL` | One proxy: `scheme://user:password@host:port` | None |
| `PROXY_PORT_COUNT` | Use this many consecutive ports of `PROXY_URL` as separate routes | 1 |
| `PROXY_URLS` | A comma-separated list of proxies, used in place of `PROXY_URL` | |

### MongoDB

MongoDB is used only when `EXPERTISE_MINER_STORE=mongo`. Mongo settings that are in your environment for some other tool are never picked up by accident. Search there is a scan with regular expressions, which is fine for a few thousand videos.

A collection written by another tool can be read as it is, as long as each record has `video_id` and `transcript`. Such records have no timed lines, so they can be searched but not mined with timestamps until they are pulled again with `refresh`.

### Proxies, and why workers are capped

By default one worker fetches one video at a time from your own address. More workers only help when each has its own exit address; two workers behind one address just double what that address sends. So the number of workers is never more than the number of distinct routes: one without a proxy, `PROXY_PORT_COUNT` with a port range, or the length of `PROXY_URLS`. At most 8.

Any HTTP or SOCKS5 proxy works. One common arrangement is a provider that gives a different exit address on each port of one gateway; for that, set `PROXY_URL` to the first port and `PROXY_PORT_COUNT` to how many you may use. For example a mobile proxy from Decodo, with ports 10001 upward, is `PROXY_URL=http://USER:PASS@gate.decodo.com:10001` and `PROXY_PORT_COUNT=4`.

Proxy addresses are shown as `host:port` only, in tool results and job records. Error text is passed through a filter before it is logged, recorded or returned: it removes the configured proxy and MongoDB addresses, the user name and password inside them, and the user-and-password part of any other URL. It matches those known values and that one shape; a credential that turned up in an error in some other form would get through. Anything the worker process itself prints on a crash goes to its log file unfiltered.

## Politeness, as built

| Behaviour | Value | Can it be changed |
|---|---|---|
| Pause after each video, per worker | 1.5 s | Yes, `delay_ms`; never below 0.5 s |
| Workers | 1 | Yes, up to the number of routes, at most 8 |
| Videos per pull | 50, newest first | Yes, `max_videos`; 0 is the whole channel |
| Pulls running at once | 1 per data folder | No |
| Asking again for a video already stored | Never, unless `refresh` | |
| Asking again for a video known to have no captions | Never, unless `retry_missing` | |
| Five videos in a row, on one route, that got neither a transcript nor a definite "none" | The pull stops as `blocked`, and no new pull starts over any route that pull was using for 30 minutes | No |

The pause is between videos, not between HTTP requests. A video takes a transcript fetch and, by default, a read of its page for the upload date and view count, which a channel listing does not carry; `details: false` leaves the second out. Listing a channel is not paced. A failed transcript fetch is retried twice, after 2 and 4 seconds, unless the site said the video has no transcript or refused the address.

These limits are per pull and per data folder. Nothing stops someone from running a second data folder, or starting again 30 minutes after a block; the limits make the polite thing the default, they do not make the impolite thing impossible.

## What leaves your machine

- Requests to YouTube for listings and transcripts, from your address or through the proxy you set.
- If you chose MongoDB, the transcripts go to your MongoDB server.
- Nothing else is sent anywhere by the server. It has no telemetry and calls no model.
- Transcript text that Claude reads, in a search or while mining, becomes part of your conversation with Claude like any file it reads.

## The tools

| Tool | Does |
|---|---|
| `setup_check` | Reports Python, packages, storage and routes. Contacts nothing |
| `pull_channel`, `pull_playlist` | Start a pull in its own process and return a job id |
| `pull_video` | Pulls one video and waits up to 45 seconds for it |
| `pull_status` | Progress of a job, or the recent jobs |
| `pull_resume` | Starts a stopped, blocked, failed or dead job again; skips what is stored |
| `pull_stop` | Asks a running pull to stop after the request it is on |
| `search_transcripts` | Word and phrase search, with timed passages |
| `get_transcript` | One transcript as timed lines, in parts |
| `list_corpus` | Channels, or a channel's videos |
| `mine_prepare` | Writes the chosen transcripts into a run folder for readers |
| `mine_verify` | Checks every item's quote against the stored transcript |
| `mine_build` | Writes the final files from the verified items and the clusters |

Only addresses on youtube.com and youtu.be are accepted. What you type is parsed into a channel, playlist or video id and the address is built from that, so the downloader is never handed an arbitrary URL.

The mining tools write only inside the run folder they are given, under fixed names: `transcripts/`, `items/`, `videos.json`, `verified.jsonl`, `rejected.jsonl`, `expertise.jsonl`, `clusters.jsonl`, `summary.md`. They will overwrite files of those names there.

## Limits worth knowing

- **Search is by words, not meaning.** There are no embeddings. Ask in several wordings.
- **Captions are often machine-made**: no punctuation, misheard names. Quotes are kept exactly as stored, errors included.
- **A channel listing is newest first.** There is no "most viewed first"; `min_views` filters within the videos selected.
- **A pull that dies** (the machine slept, the process was killed) is noticed when its record has not been updated for 90 seconds. What it stored is kept, and `pull_resume` continues. A worker that was only frozen stands down when it wakes and finds that another pull has taken its place.
- **Members-only, private and age-restricted videos** are not fetched. No sign-in or cookies are used.

## Removing it

Uninstalling leaves your data: the data folder (`.expertise-miner` in your home folder: the corpus, job records and logs, your `.env`), any run folders in your projects, and the Python packages.

## Tests

```
python tests/test_miner.py
```

Use `python3`, or `py -3` on Windows, where `python` is not on the path.

Standard library only. Listing and fetching are replaced by stand-ins, so the tests contact nothing and need none of the packages above.
