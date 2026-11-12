# Security

## Reporting a problem

Please report a security problem privately, not in a public issue: use **Report a vulnerability** under this repository's **Security** tab. Say which plugin and file, what an attacker could do, and how to reproduce it. You will get a reply within a few days.

## What to know before running these plugins

- `rebuild-factory` starts a coding agent with its commands auto-approved. Its rules file refuses the plain forms of `git push` and of common publish and deploy commands by matching command text. A different spelling, a script that deploys from inside, or another tool gets through. It is not a sandbox. The control that actually holds is where the builder runs: no production credentials in reach, and a remote its credentials cannot write to.
- Its audit and review stages run code from the repository under review on the owner's machine.
- It refuses a plan folder that was not accepted on the machine it runs on, records the plan folder around each builder turn, and counts a session as accepted only when the conductor recorded it. Those records are kept in the owner's home folder, where a cloned repository cannot place one. These detect a builder that takes a shortcut; they do not contain a hostile one, which runs as the same user.
- Its bridge refuses to start an auto-approved run without rules, with rules that deny nothing, or in a folder that has its own OpenCode config.
- `rebuild-factory` and `transcribe` store no credentials. The builder tool's own sign-in is used as it is.
- `expertise-miner` reads a proxy address or a MongoDB connection, if you choose to use one, from your environment or from a `.env` file in its own data folder in your home folder. It does not read a `.env` from the project you are working in. Proxy addresses are reduced to host and port wherever they are shown, and error text is filtered for the configured secrets and for the user-and-password part of any URL before it is logged, recorded or returned. That filter matches known values and one URL shape; a credential that reaches an error message in some other form would get through.
- `expertise-miner` hands its downloader only addresses on youtube.com that it built itself from a parsed channel, playlist or video id. It uses no cookies and no sign-in.
- Transcripts and titles fetched by `expertise-miner` are written by strangers and are read by a model. The per-video reader agent is given file reading and writing only, and every quote it reports is checked by code against the stored transcript, twice. This limits what a hostile transcript can do; it does not make a model immune to text it reads. "File reading and writing" is not confined to the run folder: a reader that was talked round by a transcript could read any file your account can read, including the `.env` in the plugin's data folder, and copy it into an item's wording, which is not checked; or write a file somewhere it should not. It has no shell and no network tool of its own. The main session, which has your full tool permissions, reads search results, whole transcripts when you search or when it mines a few videos itself, and the verified items when it clusters them.
- The mining tools of `expertise-miner` write into whatever run folder they are told to, under fixed file names, and overwrite files of those names there. They do not confine that folder to the project.
- An audit may find secrets in the codebase it reads. They are reported by location, never printed, and the plan folder that holds the report is kept out of git by default.

## In scope

A way for a plugin to run a command its rules file should refuse; a way for repository content under audit to make a plugin take an action the owner did not ask for; a secret written to a log, a prompt, a job record, a tool result or a committed file; a way to make `expertise-miner` fetch an address that is not YouTube's, or exceed its own request limits; a mined item that reaches the output with a quote that is not in the stored transcript.
