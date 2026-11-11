# Security

## Reporting a problem

Please report a security problem privately, not in a public issue: use **Report a vulnerability** under this repository's **Security** tab. Say which plugin and file, what an attacker could do, and how to reproduce it. You will get a reply within a few days.

## What to know before running these plugins

- `rebuild-factory` starts a coding agent with its commands auto-approved. The rules file it ships refuses pushes and common deploy commands by matching command text. It is not a sandbox. Run the build stage only where an unattended coding agent is acceptable, with no production credentials in reach.
- The plugins store no credentials. The builder tool's own sign-in is used as it is.
- An audit may find secrets in the codebase it reads. They are reported by location, never printed, and the plan folder that holds the report is kept out of git by default.

## In scope

A way for a plugin to run a command its rules file should refuse; a way for repository content under audit to make a plugin take an action the owner did not ask for; a secret written to a log, a prompt or a committed file.

