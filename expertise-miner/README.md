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
> - **Status: new.** Tried by its author on Windows, on a handful of videos, with SQLite and no proxy. The MongoDB and proxy paths are covered by automated tests of their settings only and have not been run against a live server by this release. Search by meaning, new in 0.3, is tested against a stand-in for the embeddings endpoint only: no real endpoint has been called by this release.
> - Search by meaning is off unless you set it up. If you do, and the endpoint you name is not on your own machine, **the text of your stored transcripts is sent to it**, and so is the wording of every search. Embedding a large corpus may cost money.

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
| `numpy` | Only for search by meaning over more than 2,000 passages | `pip install numpy`, into that same Python: `setup_check` prints the exact command when it is needed |

The server looks for a working Python by trying `py -3` (Windows), `python3` and `python`, and uses the first that reports version 3.9 or later. To choose one, set `EXPERTISE_MINER_PYTHON` to its full path in your environment.

## Settings

With no settings at all, transcripts go to a SQLite file and requests go out directly. That is the intended way to start.

Settings are read from your environment, or from a file named `.env` in the data folder, which is `.expertise-miner` in your home folder. The environment wins. [`.env.example`](.env.example) lists every name; copy it there and fill in what you need. A `.env` in the project you happen to be working in is **not** read. (Claude Code's own project settings can still set environment variables for a session, as they can for any tool; that is outside this plugin.)

| Name | Does | Default |
|---|---|---|
| `EXPERTISE_MINER_HOME` | The data folder. Environment only | `.expertise-miner` in your home folder |
| `EXPERTISE_MINER_PYTHON` | The Python to run under. Environment only | Found automatically |
| `EXPERTISE_MINER_DB` | The SQLite file | `corpus.db` in the data folder |
| `EXPERTISE_MINER_SEARCH_STEMMING` | `on` or `off`: whether a word also finds its other forms | `on` |
| `EXPERTISE_MINER_SEARCH_MATCH` | `ranked` or `all`: how a search treats its words unless the search says otherwise | `ranked` |
| `EXPERTISE_MINER_STORE` | `mongo` to use MongoDB | `sqlite` |
| `MONGO_URI`, or `MONGO_HOST` `MONGO_PORT` `MONGO_USER` `MONGO_PASS` `MONGO_AUTH_SOURCE` | The MongoDB server | |
| `MONGO_DB`, `MONGO_COLLECTION` | Where in it | `expertise_miner`, `videos` |
| `PROXY_URL` | One proxy: `scheme://user:password@host:port` | None |
| `PROXY_PORT_COUNT` | Use this many consecutive ports of `PROXY_URL` as separate routes | 1 |
| `PROXY_URLS` | A comma-separated list of proxies, used in place of `PROXY_URL` | |
| `EXPERTISE_MINER_EMBED_URL` | Search by meaning: the base address of an OpenAI-compatible embeddings API, the part before `/embeddings` | None: off |
| `EXPERTISE_MINER_EMBED_MODEL` | The embedding model's name, as that endpoint spells it | None |
| `EXPERTISE_MINER_EMBED_KEY` | Sent to that endpoint as a bearer token. Leave out for a local server | None |
| `EXPERTISE_MINER_EMBED_BATCH` | Passages per request, 1 to 256 | 32 |

The four `EXPERTISE_MINER_EMBED_` settings are read as a set: from the environment if it holds any of them, otherwise from `.env`.

### Search

Transcripts are cut into passages of about half a minute, and search works on passages, so a result is the moment something was said and not just the video it is somewhere in. A video's title is searched as part of its first passage: a word that is only in the title returns that first passage, which may not say the word.

| Option | What it does | Default | Change it |
|---|---|---|---|
| Stemming | A word also finds its other forms: `stack` finds "stacking" and "stacked". English rules; it also joins some words that only look related | on | `EXPERTISE_MINER_SEARCH_STEMMING`. The index is rebuilt the next time the corpus is opened, which means after Claude Code is restarted. Every session using the corpus must have the same setting, or each rebuilds it the other way |
| Match | `ranked`: every passage holding any of the words is a candidate, and those holding more of them, and rarer ones, come first; a quoted phrase is one such term, not a requirement. `all`: only passages holding every word and phrase | `ranked` | `EXPERTISE_MINER_SEARCH_MATCH`, or `match` on one search |
| Several wordings | One search can carry up to 8 wordings of the same question. Each is searched, the best 60 passages of each are kept, and the rankings are merged: a passage near the top for any wording does well, one found by several does better. A wording made only of common words counts as much as a good one | used when given | `queries` on a search |

A phrase in double quotes is matched as written, give or take stemming. It may run across the join between two passages when no more than 12 of its words fall on either side; a longer quote that straddles a join is not found, so search for a shorter piece of it. Passages found by a phrase across a join are listed first, ahead of the ranked ones, and at most ten of them. A single word never counts for the passage before the one it is in.

Stemming and ranking by how rare a word is come from SQLite's full-text module (FTS5), which nearly every Python has; `setup_check` says whether yours does. Without it, and on MongoDB, passages are ranked by how many of the words they hold, in their exact forms, and passages that tie come out in the order of their video ids.

**Updating from 0.1.** Let any running pull finish before you update. The first time 0.2 opens a corpus made by 0.1 it re-indexes it by passage, a video at a time; nothing is fetched again. Expect something like a minute per thousand hours of video (measured on one machine, on a made-up corpus of a few hundred hours; yours may differ), during which searches see only what has been indexed so far. If it is interrupted it carries on at the next start.

This is still a search by words. It finds "how much I put in play each night" for a search about bankroll only when one of the wordings uses those words. That is what the several-wordings option is for: Claude supplies the rephrasings. The section below adds a search by meaning for those who want one.

### Search by meaning (optional)

Off unless you set it up. With none of the `EXPERTISE_MINER_EMBED_` settings present, search is by words as described above, nothing more is installed, and nothing more leaves your machine.

Word search cannot find "how much I put in play each night" for a search about bankroll. An embedding model can: it turns a passage into a list of numbers (a vector), and passages about the same thing get vectors that lie close together. This plugin does not contain or run such a model. It calls one that you choose, using the request shape of OpenAI's embeddings API (`POST <address>/embeddings` with `{"model", "input"}` and the key as a bearer token), which several hosted services and local servers also accept. There is no default model and no default address.

| Where the model runs | `EXPERTISE_MINER_EMBED_URL` | `EXPERTISE_MINER_EMBED_MODEL` | Key |
|---|---|---|---|
| On your own machine, in an Ollama server | `http://localhost:11434/v1` | An embedding model you have pulled into it | None |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/<your account id>/ai/v1` | For example `@cf/baai/bge-m3` | An API token of that account |
| OpenAI | `https://api.openai.com/v1` | For example `text-embedding-3-small` | An API key |

The addresses and names in this table were read from each provider's documentation in November 2026. **None of the three has been called by this release**: the code is tested against a stand-in only. Model names come and go; take the current one from your provider's list.

To use it:

1. Put the settings in the `.env` file in the data folder. They are read on every call, so no restart is needed. The four embeddings settings are taken as a set from one place: if your environment holds any of them, the ones in `.env` are ignored, all of them, so that an address from one place is never sent the key from the other.
2. Ask for the size: `embed_status` reports how many passages and characters would be sent. What that costs is on your provider's price list; nothing here knows it.
3. `embed_start` sends the passages that have no vector yet, as a background job like a pull. It can be stopped, and running it again continues where it stopped.
4. Search then uses both. Nothing else changes: the same tool and the same result shape, with three more fields (`by_meaning`, `found_by_meaning` on each wording, `found_by` on each passage).

What it does, as built:

| | |
|---|---|
| Sent when embedding | The text of each passage (about 400 characters; at most the first 2,000), the model name, and the key. Not titles, channel names or video ids |
| Sent on every search | The wordings of the search, once embeddings are set and the corpus holds vectors. That includes a wording with no searchable words in it, which a word search would refuse. `by_meaning: false` on a search, or `match: "all"`, sends nothing |
| Stored | One vector per passage in the SQLite file, with the name of the model that made it. Four bytes per number: about 4 KB a passage for a 1,024-number model |
| One model per corpus | The first vector stored fixes the model name and the vector size. Vectors from any other are refused by the store, the job and the search. To change model, `embed_start` with `reembed: true` deletes every stored vector first and embeds the whole corpus again, at the whole cost again |
| How the two searches are combined | For each wording, its 60 nearest passages by vector are one more ranking, merged with the word rankings in the same way several wordings are merged. A passage found both ways does best |
| When the endpoint does not answer a search | Each network step (connecting, sending, each wait for more of the answer) is given 20 seconds, and the answer's body is dropped if it is still arriving 20 seconds after the request was sent. The search then answers by words alone, and `by_meaning.why_not` says what happened. This is not one overall limit: the steps add up, and looking the host's name up is left to your system. While it waits, the server answers no other tool. Any answer the endpoint gives, however malformed, ends the same way: by words |
| When the endpoint refuses during a job | A refused key (HTTP 401 or 403) ends the job at once. "Slow down", a server error or no answer is tried again up to 5 times, waiting 2, 4, 8 and 16 seconds or as long as the endpoint asks, at most 2 minutes; then the job ends `blocked`. A batch the endpoint will not take is sent again one passage at a time, and a passage refused alone is left out and counted. While the endpoint has never embedded anything for this corpus, 5 of those in a row end the job: that is usually a wrong model name or address. (If it is really the first few passages of the corpus that the endpoint cannot take, the job cannot get past them.) Once the endpoint has embedded something, a passage it refuses is remembered and later runs go past it (`retry_refused: true` on `embed_start` sends them again); 50 refusals in a row end the job and are not remembered, because that many points at the endpoint and not at the passages. A passage is remembered by its place in the index, so pulling its video again sends it once more. Each step of a request is given 60 seconds, as for a search. A stop request is seen when the request in hand returns, or when a wait between retries ends |
| Pause after each request | 0.2 s, `delay_ms` on `embed_start`, never under 0.1 s. 32 passages per request, `EXPERTISE_MINER_EMBED_BATCH`. If your endpoint takes fewer texts per request than that, every batch is refused and re-sent one passage at a time, which works but wastes a request per batch; the job's log says so, and a smaller batch setting avoids it |
| Pulling a video again, rebuilding the index | A passage whose text is unchanged keeps its vector. One whose text changed loses it and is embedded by the next run |
| `numpy` | Needed to rank more than 2,000 vectors; `setup_check` then prints the install command. Below that, plain Python is used and nothing need be installed, and is slower: measured on one machine, 0.05 s for 500 vectors of 1,024 numbers and one wording, growing in proportion to vectors times wordings, so over a second for 2,000 vectors and 8 wordings. The server answers nothing else meanwhile |

What to know before relying on it:

- **A search by meaning always returns something.** The nearest passages are returned even when nothing in the corpus is about the subject. Each passage in a result says how it was found (`found_by`: `words`, `meaning` or `both`). One found by meaning alone may hold none of the words searched for. Read it before citing it.
- **The model check is by name and vector size.** Two different models served under one name, with vectors of one size, would be mixed and nothing here would notice. If you move to another endpoint and are not sure it serves the very same model, use `reembed`.
- **Text goes in as it is.** Some models expect a short instruction in front of a search query or a passage. None is added, and there is no setting for one yet. Such a model still works, usually less well than it could.
- **Every search reads every vector from the file**, a block at a time (2,048 vectors with `numpy`, 128 without), so memory does not grow with the corpus and time does. This has not been timed on a real corpus.
- **Only part of the corpus may be embedded** (a run was stopped, new videos were pulled since, the endpoint refused some passages). The rest is found by words only. The search result says how many passages have a vector; that count can be a little high after an older version of the plugin has changed the corpus, and `embed_status` gives the exact number still owed.
- **SQLite only.** With MongoDB, search stays by words.
- **An older version of this plugin opened on the same corpus knows nothing of the vectors.** If it rebuilds the index, vectors are left pointing at nothing or at other text. They are never used in that state, because each vector is tied to the exact text it was made from; those passages are simply embedded again by the next run.
- **Plain `http` is accepted only for this machine** (`localhost`, `127.0.0.1`, `::1`). Any other address must be `https`. A redirect from the endpoint is never followed, because the key and the text would go with it. The address comes from your settings only: no tool takes an address.
- Requests to a hosted endpoint go directly, or through the proxy your operating system or the standard `HTTPS_PROXY` variable names. They never use `PROXY_URL`, which is for YouTube only. What the provider does with the text is governed by its terms, not by anything here.

### MongoDB

MongoDB is used only when `EXPERTISE_MINER_STORE=mongo`. Mongo settings that are in your environment for some other tool are never picked up by accident. Search there has no index: the matching videos are found with regular expressions, at most 40 of them and the most viewed first, and their passages are ranked by how many of the words each holds. There is no stemming and no ranking by how rare a word is. With ranked matching and a common word in the search, those 40 can all be videos that hold only the common word; use `match: "all"` or rarer words there. That is fine for a few thousand videos.

A collection written by another tool can be read as it is, as long as each record has `video_id` and `transcript`. Such records have no timed lines, so they can be searched but not mined with timestamps until they are pulled again with `refresh`.

### Proxies, and why workers are capped

By default one worker fetches one video at a time from your own address. More workers only help when each has its own exit address; two workers behind one address just double what that address sends. So the number of workers is never more than the number of distinct routes: one without a proxy, `PROXY_PORT_COUNT` with a port range, or the length of `PROXY_URLS`. At most 8.

Any HTTP or SOCKS5 proxy works. One common arrangement is a provider that gives a different exit address on each port of one gateway; for that, set `PROXY_URL` to the first port and `PROXY_PORT_COUNT` to how many you may use. For example a mobile proxy from Decodo, with ports 10001 upward, is `PROXY_URL=http://USER:PASS@gate.decodo.com:10001` and `PROXY_PORT_COUNT=4`.

Proxy addresses are shown as `host:port` only, in tool results and job records. Error text is passed through a filter before it is logged, recorded or returned: it removes the configured proxy and MongoDB addresses, the user name and password inside them, and the user-and-password part of any other URL. The embeddings key and address are removed in the same way (the address whole, its path alone, and any piece of the path of six or more characters that holds a digit, such as an account id), and so is whatever follows the word `Bearer`. It matches those known values and those shapes; a credential that turned up in an error in some other form would get through. Anything the worker process itself prints on a crash goes to its log file unfiltered.

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
- If you set an embeddings endpoint: the text of stored passages goes to it when you run `embed_start`, and the wording of each search goes to it when you search. If that endpoint is a server on your own machine, this stays on your machine. If it is a hosted service, your transcripts' text and your searches go to that service. The settings table and the section on search by meaning say exactly what is sent.
- Nothing else is sent anywhere by the server. It has no telemetry. It calls no model except that embeddings endpoint, and only when you have set one.
- Transcript text that Claude reads, in a search or while mining, becomes part of your conversation with Claude like any file it reads.

## The tools

| Tool | Does |
|---|---|
| `setup_check` | Reports Python, packages, storage, routes and the embeddings settings (never the key). Contacts nothing |
| `pull_channel`, `pull_playlist` | Start a pull in its own process and return a job id |
| `pull_video` | Pulls one video and waits up to 45 seconds for it |
| `pull_status` | Progress of a job, or the recent jobs |
| `pull_resume` | Starts a stopped, blocked, failed or dead job again; skips what is stored |
| `pull_stop` | Asks a running pull to stop after the request it is on |
| `search_transcripts` | Ranked word and phrase search over passages, for one wording or several. Also by meaning where embeddings are set up |
| `embed_status` | What is set for search by meaning, what is stored, and how much `embed_start` would send. Contacts nothing |
| `embed_start` | Sends the passages with no vector yet to your embeddings endpoint, in its own process, and returns a job id |
| `embed_stop` | Asks a running embedding job to stop after the request it is on |
| `get_transcript` | One transcript as timed lines, in parts |
| `list_corpus` | Channels, or a channel's videos |
| `mine_prepare` | Writes the chosen transcripts into a run folder for readers |
| `mine_verify` | Checks every item's quote against the stored transcript |
| `mine_build` | Writes the final files from the verified items and the clusters |

Only addresses on youtube.com and youtu.be are accepted. What you type is parsed into a channel, playlist or video id and the address is built from that, so the downloader is never handed an arbitrary URL.

The mining tools write only inside the run folder they are given, under fixed names: `transcripts/`, `items/`, `videos.json`, `verified.jsonl`, `rejected.jsonl`, `expertise.jsonl`, `clusters.jsonl`, `summary.md`. They will overwrite files of those names there.

## Limits worth knowing

- **Search is by words unless you set up search by meaning.** It ranks passages, knows a word's other forms and merges several wordings. Without an embeddings endpoint, a passage that says it in words no wording used is not found. With one, see what to know before relying on it, above.
- **Captions are often machine-made**: no punctuation, misheard names. Quotes are kept exactly as stored, errors included.
- **A channel listing is newest first.** There is no "most viewed first"; `min_views` filters within the videos selected.
- **A pull that dies** (the machine slept, the process was killed) is noticed when its record has not been updated for 90 seconds. What it stored is kept, and `pull_resume` continues. A worker that was only frozen stands down when it wakes and finds that another pull has taken its place.
- **Members-only, private and age-restricted videos** are not fetched. No sign-in or cookies are used.

## Removing it

Uninstalling leaves your data: the data folder (`.expertise-miner` in your home folder: the corpus with any vectors in it, job records and logs, your `.env`), any run folders in your projects, and the Python packages.

## Tests

```
python tests/test_miner.py
```

Use `python3`, or `py -3` on Windows, where `python` is not on the path.

Standard library only. Listing, fetching and the embeddings endpoint are replaced by stand-ins, so the tests contact nothing and need none of the packages above. One test compares the `numpy` ranking with the plain one and is skipped where `numpy` is not installed.
