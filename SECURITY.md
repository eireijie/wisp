# Security

Warren runs AI agents that can use computers, read and write memory, and act on your behalf, so security reports matter a lot to us.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through [GitHub's security advisories](https://github.com/eireijie/warren/security/advisories/new). Include what's affected, how to reproduce it, and what someone could do with it. You'll hear back within a week.

## Supported versions

Warren updates from `main` (`warren update`, or **Settings → Advanced → About**). Fixes land there, so please check the latest `main` before reporting.

## What's in scope

Things like:

- Someone in a workspace reaching data, memory, devices or computers they shouldn't (for example, another member's device screen or private memory folder)
- An agent getting around its access level, its memory permissions, or approvals
- A device token, harness token or connection token leaking, or working after it was revoked
- A device's own screen opening from Warren without its code, or the hub saving or logging the code
- Anyone without an account reaching the hub's API, live views or files
- Prompt injection that makes an agent act outside what the person asked, where Warren could reasonably have stopped it

Running a hub on the open internet without HTTPS, or giving an agent **Full access** on a device started with `--allow-full-access`, are choices people make knowingly; see [docs/deploy.md](docs/deploy.md) and [docs/computers.md](docs/computers.md).
