# Security

## Reporting a problem

Please report a security problem privately, not in a public issue: use **Report a vulnerability** under this repository's **Security** tab. Say which plugin and file, what an attacker could do, and how to reproduce it. You will get a reply within a few days.

## What to know before running these plugins

- `rebuild-factory` starts a coding agent with its commands auto-approved. Its rules file refuses the plain forms of `git push` and of common publish and deploy commands by matching command text. A different spelling, a script that deploys from inside, or another tool gets through. It is not a sandbox. The control that actually holds is where the builder runs: no production credentials in reach, and a remote its credentials cannot write to.
- Its audit and review stages run code from the repository under review on the owner's machine.
- It refuses a plan folder that was not accepted on the machine it runs on, records the plan folder around each builder turn, and counts a session as accepted only when the conductor recorded it. Those records are kept in the owner's home folder, where a cloned repository cannot place one. These detect a builder that takes a shortcut; they do not contain a hostile one, which runs as the same user.
- Its bridge refuses to start an auto-approved run without rules, with rules that deny nothing, or in a folder that has its own OpenCode config.
- The plugins store no credentials. The builder tool's own sign-in is used as it is.
- An audit may find secrets in the codebase it reads. They are reported by location, never printed, and the plan folder that holds the report is kept out of git by default.

## In scope

A way for a plugin to run a command its rules file should refuse; a way for repository content under audit to make a plugin take an action the owner did not ask for; a secret written to a log, a prompt or a committed file.
