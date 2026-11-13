# expertise-miner

Find out how an expert actually works, from what they have said on YouTube.

It does two jobs:

1. **Builds a corpus.** Pulls the transcripts of a channel, a playlist or a single video into a local database, and searches them.
2. **Mines it.** Reads those transcripts for the expert's **research questions**, **rules of thumb** and **research steps**. Each item carries the speaker's exact words, the video, the moment they were said, and a way to test the item against data.

It is not a picks scraper. "Take the home side on Saturday" is left out. "I never back a home side until I have checked who is rested" is kept, as a rule that can be checked.

It knows nothing about any one subject. The same steps work on a surgeon, a poker player, a fund manager or a chess coach.

> **Read this before you run it.**
>
> - It makes automated requests to YouTube from your address: a few to list a channel, then for each video a transcript fetch and, by default, a read of its page for the upload date and view count. Each of those is itself several HTTP requests (about three for a transcript). It is slow on purpose. YouTube may still refuse or throttle an address that asks for a lot; when that happens the pull stops using that address and tells you, and with no other route left it stops.
> - Whether collecting and studying a channel's transcripts is acceptable for your purpose is your decision. Use it on material you are entitled to study.
> - Transcripts are strangers' words, and often machine-made captions. Mined items report what was **said**. Nothing here checks whether it is **true**.
> - **Status: new.** Tried on Windows with SQLite, without a proxy and, since 0.3.1, through a proxy of 10 ports and with search by meaning through Cloudflare (a first real set-up, whose report led to 0.3.2). The MongoDB path is covered by automated tests of its settings only and has not been run against a live server. The changes of 0.3.2 (routes taken out one at a time, `proxy_test`, the messages that say why a read failed) and of 0.3.3 (a pull ending `partial`, the job-wide request limit, refusals by route) are tested against stand-ins only. Search by meaning has been run against Cloudflare Workers AI in that set-up; against OpenAI and local servers it is tested with a stand-in only.
> - Search by meaning is off unless you set it up. If you do, and the endpoint you name is not on your own machine, **the text of your stored transcripts is sent to it**, and so is the wording of every search. Embedding a large corpus may cost money.

## Use

In any Claude Code chat:

| Type | What happens |
|---|---|
| `/yt-setup` | Asks three questions (which database, which search, a proxy or not) and writes your settings file. Optional: with no settings everything works |
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
| `numpy` | Only for search by meaning over more than 2,000 passages | `pip install numpy`, into that same Python: `setup_check` warns as soon as search by meaning is set up and numpy is missing, and `embed_status` and `embed_start` say so when a run would pass 2,000 |

The server looks for a working Python by trying `py -3` (Windows), `python3` and `python`, and uses the first that reports version 3.9 or later. To choose one, set `EXPERTISE_MINER_PYTHON` to its full path in your environment.

## Settings

With no settings at all, transcripts go to a SQLite file and requests go out directly. That is the intended way to start.

Every setting answers one of three questions:

1. **Which database holds the transcripts?** SQLite (the default), or your MongoDB.
2. **How do you want to search?** By words (the default), or by words and by meaning through an embeddings endpoint you choose.
3. **Do YouTube pulls go through a proxy?** No (the default), one proxy address, or a list.

`/yt-setup` asks them and writes the settings file for your answers, with every setting in it under its question. It never asks for a secret and never writes one: passwords, keys, addresses and account ids go in as placeholders in capitals, on lines that are switched off. You replace them and switch those lines on yourself. So the file as first written changes nothing and sends nothing: its only active lines are the defaults, and it behaves like having no file. A placeholder left in on a line you switch on is reported as a mistake by `setup_check` and is not used. If a settings file already exists it is left alone. A change to the file takes effect at the next tool call; a pull or an embedding run that is already going keeps the settings it started with.

Settings are read from your environment, or from a file named `.env` in the data folder, which is `.expertise-miner` in your home folder. The environment wins. [`.env.example`](.env.example) is that same file with the default answer to each question; you can copy it there and edit it by hand instead. A `.env` in the project you happen to be working in is **not** read. (Claude Code's own project settings can still set environment variables for a session, as they can for any tool; that is outside this plugin.)

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
| `EXPERTISE_MINER_WORKERS` | Workers for a pull that does not say. Still never more than the routes, at most 8 | 1 |
| `EXPERTISE_MINER_DELAY_MS` | The pause per worker for a pull that does not say. Still never under 500 | 1500 |
| `EXPERTISE_MINER_MAX_REQUESTS_PER_MINUTE` | A limit on requests to YouTube per minute for a whole pull, all its workers together, 1 to 600, for a pull that does not say | None: no limit |
| `EXPERTISE_MINER_EMBED_URL` | Search by meaning: the base address of an OpenAI-compatible embeddings API, the part before `/embeddings` | None: off |
| `EXPERTISE_MINER_EMBED_MODEL` | The embedding model's name, as that endpoint spells it | None |
| `EXPERTISE_MINER_EMBED_KEY` | Sent to that endpoint as a bearer token. Leave out for a local server | None |
| `EXPERTISE_MINER_EMBED_BATCH` | Passages per request, 1 to 256 | 32 |

The four `EXPERTISE_MINER_EMBED_` settings are read as a set: from the environment if it holds any of them, otherwise from `.env`. A value of `workers`, `delay_ms` or `max_requests_per_minute` given on a pull wins over `EXPERTISE_MINER_WORKERS`, `EXPERTISE_MINER_DELAY_MS` and `EXPERTISE_MINER_MAX_REQUESTS_PER_MINUTE`; `pull_resume` keeps what the earlier pull was given and otherwise takes these settings as they are then, unless it is given its own `workers`, `delay_ms` or `max_requests_per_minute`, which win. `setup_check` shows what a pull would run with (`pull_defaults`); a value it cannot read is a problem there and stops pulls until it is fixed.

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

The addresses and names in this table were read from each provider's documentation in November 2026. **Of the three, only Cloudflare has been called for real** (in a user's set-up of 0.3.1); the others are tested against a stand-in only. Model names come and go; take the current one from your provider's list.

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
| `numpy` | Needed to rank more than 2,000 vectors. `setup_check` warns, with the install command, as soon as embeddings are set and numpy is missing; `embed_status` and `embed_start` add a `numpy_notice` when the stored vectors plus those a run would make pass 2,000. Below that, plain Python is used and nothing need be installed, and is slower: measured on one machine, 0.05 s for 500 vectors of 1,024 numbers and one wording, growing in proportion to vectors times wordings, so over a second for 2,000 vectors and 8 wordings. The server answers nothing else meanwhile |

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

By default one worker fetches one video at a time from your own address. More workers only help when each has its own exit address; two workers behind one address just double what that address sends. So the number of workers is never more than the number of distinct routes: one without a proxy, `PROXY_PORT_COUNT` with a port range, or the length of `PROXY_URLS`. At most 8. Each worker holds one route, and no route is used by two workers at once.

Routes beyond a pull's workers stand by. A route is taken out for the rest of the pull when five videos in a row get no answer over it, or when, among its last 10 videos, at least one was answered, at least 3 got no answer and those are more than 30% of them (3 of 9 or fewer, or 4 of 10). The second rule is for a route the site refuses part of the time, with answers in between. A route that has answered nothing in its last 10 is judged by the first rule alone, so a route that never answers is out after five, as before; once a route has answered, the second rule can take it out sooner (for example at the third refusal in a row after one to six answers, or the fourth after seven or more). A standby route, if one is left, takes the worker over; otherwise that worker stops and the others carry on. That holds with one worker too: it moves to the next route. The pull ends `blocked` only when every route is out. `pull_status` lists the routes taken out (`routes_out`) and why (`routes_out_why`, for example `refused 3 of its last 9 (RequestBlocked)`); the job's log says the same. While routes stand by, each worker also hands its route back to the end of the standby list every 20 videos it sends for and takes the next standby route (never one in use by another worker, taken out or cooling down), so that one weak route does not carry a fixed share of every pull; videos skipped because they are already stored do not count towards the 20. Videos the site gave no answer for over a route without taking it out (they had left its last 10 by the time it was taken out, or it never was) are counted for that route in `refusals_by_route` (while the pull runs it also holds those still among a route's last 10, which drop out of it if they then take the route out), as `host:port` (`direct` for your own address), and the message at the end of the pull warns about each such route, for example `over us.example:10001, 4 videos got no answer from the site without the route being taken out`: an early sign that the site is starting to refuse it. Not counted there: a failure of the proxy itself (login refused, unreachable, SOCKS support missing), a page that could not be read under `min_views`, and an error of this code or of the store. Those still count towards taking the route out.

Any HTTP or SOCKS5 proxy works. One common arrangement is a provider that gives a different exit address on each port of one gateway; for that, set `PROXY_URL` to the first port and `PROXY_PORT_COUNT` to how many you may use: `PROXY_URL=http://USER:PASS@gate.example.com:10001` with `PROXY_PORT_COUNT=10` is ports 10001 to 10010, ten routes. Decodo's mobile proxies are one such provider.

Two things that trip people up when writing the address:

- **The order.** It is `scheme://user:password@host:port`. Providers often export `host:port:user:pass`; `setup_check` recognises that order and says how to rewrite it, without repeating the user name or password.
- **Characters in the password.** If the user name or password holds `@ : / # ?` or `%`, write them as `%40 %3A %2F %23 %3F %25`. Other characters, such as `=`, can stay as they are. Both libraries that pull decode these before sending them to the proxy: checked for 0.3.2 against yt-dlp 2026.10.26 (its requests handler and its SOCKS code), requests 2.34.2 (which youtube-transcript-api uses, for HTTP and SOCKS proxies) and Python's own urllib (yt-dlp's fallback), by asking each what it would send, with no proxy contacted. A raw `@` in the password is refused by `setup_check` with that advice.

`setup_check` checks the address's form only; it contacts nothing. To check that each route actually works, `proxy_test` sends one `HEAD` request to `https://www.youtube.com/` through each configured route (with a 10-second timeout, up to 8 routes at once) and reports each as `host:port` only: `ok`, `login refused (407)`, `unreachable`, `timeout` or `error`. It never sends anything from your own address: with no proxy set, it sends nothing. Claude runs it only when you agree. When a pull fails because the proxy refused the login or could not be reached, the message and the job's log say so, naming the route as `host:port`.

Proxy addresses are shown as `host:port` only, in tool results and job records. Error text is passed through a filter before it is logged, recorded or returned: it removes the configured proxy and MongoDB addresses, the user name and password inside them, and the user-and-password part of any other URL. The embeddings key and address are removed in the same way (the address whole, its path alone, and any piece of the path of six or more characters that holds a digit, such as an account id), and so is whatever follows the word `Bearer`. It matches those known values and those shapes; a credential that turned up in an error in some other form would get through. Anything the worker process itself prints on a crash goes to its log file unfiltered.

## Politeness, as built

| Behaviour | Value | Can it be changed |
|---|---|---|
| Pause after each video, per worker | 1.5 s, plus a random 0 to 50% on top so that requests do not come on a fixed beat | The 1.5 s, yes: `delay_ms` on a pull or `EXPERTISE_MINER_DELAY_MS`; never below 0.5 s. The random part, no |
| Requests to YouTube per minute, all workers of a pull together | No limit | Yes, `max_requests_per_minute` on a pull or `EXPERTISE_MINER_MAX_REQUESTS_PER_MINUTE`, 1 to 600. When set, it holds across all workers, whatever their pause |
| Workers | 1 | Yes, `workers` on a pull or `EXPERTISE_MINER_WORKERS`; up to the number of routes, at most 8 |
| Videos per pull | 50, newest first | Yes, `max_videos`; 0 is the whole channel |
| Pulls running at once | 1 per data folder | No |
| Asking again for a video already stored | Never, unless `refresh` | |
| Asking again for a video known to have no captions | Never, unless `retry_missing` | |
| Videos on one route that got neither a transcript nor a definite "none": five in a row, or, when at least one of its last 10 was answered, at least 3 of those 10 and more than 30% of them (3 of 9 or fewer, or 4 of 10) | That route is taken out for the rest of the pull, and a standby route takes over if one is left. The pull stops as `blocked` when every route is out. Without a proxy there is one route, so the pull stops. A route that never answers is out after five | No |
| Workers and standby routes | While routes stand by, a worker hands its route back to the end of the standby list every 20 videos it sends for (videos already stored do not count) and takes the next standby route that is not cooling down. No route is ever held by two workers | No |
| A route the site refused | Held back from new pulls for 30 minutes. Only that route: a new pull uses the others and says which it held back, and is refused only when every one of its routes is held back. A route is not held back only when every failure that took it out (the run, or those among its last 10 videos) was the proxy's own (it refused the login, could not be reached, or SOCKS support is missing), since the site was then never asked | No |

The pause is between videos, not between HTTP requests. A video takes a transcript fetch and, by default, a read of its page for the upload date and view count, which a channel listing does not carry; `details: false` leaves the second out. A failed transcript fetch is retried twice, after 2 and 4 seconds, unless the site said the video has no transcript or refused the address.

The request limit counts calls this code makes to the site: the listing of a playlist or of one channel tab (a channel pulled with three tabs is three calls, each waiting its turn), one read of a video's page, one transcript fetch attempt (each retry is another). Those are not single HTTP requests: a transcript fetch is itself about three HTTP requests, and a listing one or more per page of the playlist or tab. When the limit is set, every such call waits its turn, so that calls are at least 60 / limit seconds apart and no 60-second window holds more than the limit; the pause per worker still applies on top. A stop request is seen while a call waits, and the call is then not sent. Without it, a listing is not paced at all, and the rate is set only by the pause and the number of workers: N workers send about N times as much. Through a mobile proxy plan, with one worker, a pause of 8 seconds and page reads on (about 7 to 10 calls a minute), the site refused requests over the route after about 5 minutes in one user's pulls; the settings file suggests 6 a minute for such plans. That is one observation, not a guarantee. `pull_status` shows the calls made so far (`requests`), their rate (`requests_per_minute`: the calls after the first, over the time from the first call to the latest, so that with a limit it never reads above it) and the limit in force (`request_limit_per_minute`).

These limits are per pull and per data folder. Nothing stops someone from running a second data folder, or starting again 30 minutes after a block; the limits make the polite thing the default, they do not make the impolite thing impossible. Routes are told apart for the cool-down by `host:port`, so two routes on the same host and port with different user names (a provider's sticky sessions, say) are held back together.

## What leaves your machine

- Requests to YouTube for listings and transcripts, from your address or through the proxy you set.
- If you agree to `proxy_test`: one `HEAD` request to `https://www.youtube.com/` through each proxy route you set, and nothing else.
- If you chose MongoDB, the transcripts go to your MongoDB server.
- If you set an embeddings endpoint: the text of stored passages goes to it when you run `embed_start`, and the wording of each search goes to it when you search. If that endpoint is a server on your own machine, this stays on your machine. If it is a hosted service, your transcripts' text and your searches go to that service. The settings table and the section on search by meaning say exactly what is sent.
- Nothing else is sent anywhere by the server. It has no telemetry. It calls no model except that embeddings endpoint, and only when you have set one.
- Transcript text that Claude reads, in a search or while mining, becomes part of your conversation with Claude like any file it reads.

## The tools

| Tool | Does |
|---|---|
| `setup_check` | Reports Python, packages, storage, routes, the pull defaults, the embeddings settings (never the key), the three choices in effect, the age of the installed yt-dlp and whether a JavaScript runtime is found, and `warnings` that need no action yet. Contacts nothing, except your own MongoDB server when that is the store |
| `proxy_test` | Optional: one request through each proxy route, to say which work. Run only when you agree |
| `setup_write` | Writes the settings file from answers to the three questions, with placeholders where a secret goes. Never overwrites one |
| `pull_channel`, `pull_playlist` | Start a pull in its own process and return a job id |
| `pull_video` | Pulls one video and waits up to 45 seconds for it |
| `pull_status` | Progress of a job, or the recent jobs. `counts.listed` is the entries the listing read, before `max_videos` applied; `counts.site_count` is how many the site says the playlist or tabs hold (none when it gave no count); `counts.hidden` is how many videos the site said it hid from the listing |
| `pull_resume` | Starts a stopped, blocked, failed, dead or partial job again; skips what is stored, and lists again. Optional `workers`, `delay_ms` and `max_requests_per_minute` replace the earlier job's, with the same limits as on a new pull (0 keeps the earlier job's); `resumed_from` still names the earlier job |
| `pull_stop` | Asks a running pull to stop after the request it is on |
| `search_transcripts` | Ranked word and phrase search over passages, for one wording or several. Also by meaning where embeddings are set up |
| `embed_status` | What is set for search by meaning, what is stored, and how much `embed_start` would send. Contacts nothing: it reads the SQLite file |
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
- **A listing can be cut short without an error.** An out-of-date yt-dlp (one about 240 days old was seen to list only the first 100 videos of a 175-video playlist) does it, and so does a current one when the site refuses the request for the next page: a current yt-dlp listed 99 of 174 right after a route was refused. `setup_check` reports yt-dlp's age (a warning past 60 days, a problem past 90) with the upgrade command. When a playlist or tab comes back short of the count the site gives (short means more than 5 entries and more than 5% of the count short, or short at all while ending on a whole number of pages (of 100 for a playlist, 30 for a channel tab); a few missing entries are taken as videos the site counts and does not list), the pull lists it once more over the next route that is not cooling down (with one route there is none). It is then judged again tab by tab (a playlist is one tab): each tab on the entries the two listings found in it together, against the larger count either gave for that tab and with the same allowance; a tab found short stays short unless its second listing was the longer one. The listing is whole only when every tab is; a tab for which the site gave no count is never what keeps it short. For a channel, the message names the tab that was short. If it is still short, the pull fetches what was listed and ends `partial`, with a message such as `listed 99 of 174: the listing may have been cut short`; `pull_resume` lists again. A listing short of the count while still holding `max_videos` videos is not treated as cut. A listing of nothing at all is short whenever the site gives a count above 0: it is listed again like any other and ends `partial`, not `done`. When yt-dlp passes on the site's note that `N unavailable videos are hidden`, the number goes into `counts.hidden` (the largest number yt-dlp gave per playlist or tab, since it passes the note on more than once; 0 when listing again made the listing whole) and a `partial` message says `the site hid N videos in this listing; they may have gone private, or this route may be served a restricted view` (one 27-video playlist listed 27 in the morning and 0 two hours later, with that note). A playlist whose count includes more entries that yt-dlp never lists (private or removed videos that the site still counts, say) than that allowance ends `partial` every time; the message then says the same numbers each time, and `pull_resume` will not change them. With no count from the site, a listing that stops at a whole page (100 for a playlist, 30 for a channel tab) is only warned about in `warnings`, since a playlist of exactly 100 videos looks the same. yt-dlp's own warnings go to `warnings` and its errors during the listing to the job's log.
- **A capped pull is not the whole playlist.** When `max_videos` left videos out, the end message says how many, for example `the playlist has 174; 124 not tried because of max_videos=50`.
- **yt-dlp wants a JavaScript runtime** (Deno) for YouTube, and says reading it without one is deprecated. `setup_check` warns when none is on the PATH, and a job that ends `partial` while none is found adds: `No JavaScript runtime (Deno) was found; yt-dlp says listings may fail without one: install Deno`. Transcripts come through another library and do not need it today.

## Removing it

Uninstalling leaves your data: the data folder (`.expertise-miner` in your home folder: the corpus with any vectors in it, job records and logs, your `.env`), any run folders in your projects, and the Python packages.

## Tests

```
python tests/test_miner.py
```

Use `python3`, or `py -3` on Windows, where `python` is not on the path.

Standard library only. Listing, fetching and the embeddings endpoint are replaced by stand-ins, so the tests contact nothing and need none of the packages above. One test compares the `numpy` ranking with the plain one and is skipped where `numpy` is not installed.
