# Privacy Policy

**Policy baseline:** AiDB Studio `0.0.11`. This policy describes the current repository’s data paths; it does not claim certifications, an independent audit, or a guaranteed service level.

## Local-first boundary

AiDB Studio is primarily a user-run local application, not a maintainer-hosted database service. By default, the maintainers do not receive your local database, app state, prompts, or query results. “Local-first” does not mean anonymous or risk-free: you choose the databases, model providers, remote Bridge endpoints, integrations, and files you use.

| Data path | Current boundary |
| --- | --- |
| Local app state | The gateway keeps connections, settings, query/audit history, agent sessions, memories, and artifacts in its local SQLite store. Database passwords, API keys, SSH secrets, and integration secrets in designated secret fields use AES-256-GCM encryption with a separately managed master secret. Other records are not claimed to be encrypted. Protect the host, data directory, and master secret. |
| Database and SSH traffic | Queries and credentials go from the Bridge to the database or SSH endpoint you configure. Use TLS and trusted certificates for remote connections, least-privilege database accounts, and read-only mode where appropriate. Database server and network logs are controlled by their operators. |
| Model and embedding providers | When you invoke AI or embedding features, the configured provider receives the prompts and context sent for that operation. Depending on the request, this can include schema, query text, sampled/query results, memories, tool arguments/results, and attachments. Provider retention, training, residency, and deletion terms are the provider’s and your account’s responsibility. A user-configured local endpoint avoids sending that request to a third-party provider. |
| Device pairing | Pairing codes are short-lived and single-use. The gateway stores a hash of each issued device token; the paired client keeps its token. Mobile uses platform secure storage (`SecureStore`). The MCP CLI writes its token to a local credential file and applies `0600` permissions on POSIX systems. Revoke lost or unused devices in Settings. |
| Backups, exports, and imports | Files are written to the local directories or destinations selected by the user or operation. They may contain sensitive database data and are not guaranteed to be encrypted by AiDB. Access control, secure transfer, retention, and deletion are user responsibilities. |
| External integrations | Web search, pipelines, notifications, bots, remote MCP servers, skills, and other configured endpoints can receive the input needed for the action you approve or run. Review endpoints, credentials, and payloads before enabling them. |

## Telemetry

At this baseline, the repository does not implement a first-party product-analytics or crash-report upload. Token usage, latency, and health counters shown in the product are operational statistics computed from local activity. This statement does not cover model-provider logs, database logs, web servers, proxies, operating-system diagnostics, package/update services, or third-party integrations you configure.

## Retention and deletion

Local retention is controlled through app settings, deletion actions, and uninstall/removal of the data directory. Revoking a device invalidates its gateway token but does not automatically delete data already sent to a provider, database, notification endpoint, exported file, or backup. Uninstalling a client does not guarantee deletion of those external copies. You are responsible for retention schedules and secure deletion where required.

## User responsibilities

- Have authorization and a lawful basis for the data you query, copy, or send.
- Minimize sensitive data in prompts, memories, attachments, logs, and exports; review agent approvals and generated statements.
- Protect the host, master secret, database accounts, provider keys, pairing tokens, and backup media.
- Use TLS, network restrictions, read-only database privileges, and device revocation appropriate to the deployment.
- Review configured model, embedding, search, MCP, notification, and pipeline providers and their terms.
- Test changes and maintain recoverable backups before write, DDL, restore, or bulk operations.

Maintainers do not control user-selected third parties and do not promise their data practices. Policy changes are made in this repository; check the version and history for the release you use.
