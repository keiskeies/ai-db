# Security Policy

## Supported versions

Security fixes target the latest published `0.0.x` release line. At this policy baseline, the root application and MCP package are `0.0.10`. Before 1.0 there is no LTS or guaranteed backport policy; upgrade to the latest release and report whether an older version is affected.

## Report a vulnerability privately

1. Use [GitHub private vulnerability reporting](https://github.com/keiskeies/ai-db/security/advisories/new) when it is available for this repository.
2. If private reporting is unavailable, open a public issue at <https://github.com/keiskeies/ai-db/issues/new> titled **“Request private security contact”**. Include no vulnerability details, credentials, personal data, or production payload. A maintainer must establish a private channel before you disclose the report.
3. Do not assume a public issue or pull request is confidential. Do not report exploitable details in a public discussion.

Include the affected version or commit, platform, engine, reproduction steps, impact, and sanitized logs. Remove database contents, tokens, connection strings, and customer data before sharing anything.

## Response targets

These are policy targets, not a guaranteed SLA:

| Target | Policy goal |
| --- | --- |
| Acknowledge a private report | Within 7 calendar days |
| Initial scope and severity assessment | Within 14 calendar days |
| Status update for an open accepted report | At least every 30 calendar days |
| Fix or mitigation planning | Based on severity, exploitability, affected versions, and maintainer capacity; communicated in the private report |

There is no guaranteed response time, bounty, or remediation date unless a separate written agreement says otherwise.

## Handling and disclosure

Maintainers should coordinate remediation and disclosure with the reporter. The default disclosure target is 90 days after a report, but active exploitation, dependency constraints, or reporter needs may justify an earlier or later date. Please do not test against production systems, exfiltrate data, disrupt services, or access accounts without authorization. Use a disposable local database and sanitized fixtures.

## Scope

Reports are relevant to AiDB Studio’s gateway, desktop/mobile clients, MCP package, authentication and device scopes, read-only enforcement, credential storage, pairing, filesystem boundaries, and supplied integrations. For an upstream dependency or database-server flaw, also report it upstream and explain the AiDB impact. Provider outages, database misconfiguration, and unsupported vendor behavior are not automatically product vulnerabilities.

See [SUPPORT.md](./SUPPORT.md) for supported runtimes and [PRIVACY.md](./PRIVACY.md) for data-handling boundaries.
