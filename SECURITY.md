# Security policy

Ambient holds people's notes, meetings and work. We take reports about its security seriously and are grateful for them.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately, either way:

- [GitHub private vulnerability reporting](https://github.com/Ambient-Artifacts/ambient-core/security/advisories/new) (preferred), or
- email **nikolai@ambientartifacts.si**.

Include what's affected (a URL, an endpoint, a file), the steps to reproduce it, and the impact you see. A proof of concept helps.

## What happens next

- We confirm we got it within **3 business days**.
- We keep you posted while we investigate and fix it, and agree with you on a date to disclose it.
- We credit you in the advisory, unless you'd rather not be named.

There is no paid bug bounty.

## Scope

In scope: this repository's code, which runs both [Ambient Cloud](https://ambientartifacts.si) and self-hosted servers.

- Ways around sign-in, scopes or team membership: reading another person's or team's notes, or a team-only token reaching personal notes.
- Breaking the encryption of personal pages, or getting key material out of the gateway.
- Getting past the team servers' token check.
- Injection, request forgery or remote code execution in the gateway, the team server, the runner or the Claude Code plugin.
- Secrets reaching logs, notes or third parties when they shouldn't.

Out of scope:

- Denial of service and volume-based attacks, including rate limits.
- Reports from automated scanners without a demonstrated impact.
- Social engineering, and physical attacks.
- Self-hosted servers that weren't configured as the docs describe (for example, the team server or Convex exposed to the internet).
- Vulnerabilities in dependencies without a way to exploit them here. Do report them to the dependency.

## Testing rules

- Test against your own self-hosted server (`ops/docker/init.sh --local` takes a few minutes). On Ambient Cloud, use only accounts you own, and never access or change other people's data.
- Stop and tell us as soon as you've shown a problem. Don't keep or share data you came across.

If you follow these rules, we won't take legal action against you for your research, and we'll treat it as authorized.

## Supported versions

Fixes go to `main` and Ambient Cloud. Self-hosted servers get them by updating to the latest `main` (`git pull && docker compose up -d --build`).
