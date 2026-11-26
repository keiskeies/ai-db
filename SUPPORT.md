# Support Policy

## Versions and runtime

- **Supported release line:** the latest published `0.0.x` release only. The current root application and MCP package baseline is `0.0.11`. Pre-1.0 releases do not have LTS or guaranteed backports.
- **Node.js:** `>=22.13` for the application, standalone Bridge, and MCP package. The minimum is tied to the stable `node:sqlite` API used by the gateway. CI and release builds use Node.js 24; other Node lines are not implied to be tested.
- **Desktop:** released Windows, macOS, and Linux installers use the bundled application runtime. A separately deployed Bridge requires the Node.js minimum above. Engine-specific prerequisites are documented in [docs/09-multi-engine.md](./docs/09-multi-engine.md).
- **Mobile:** Android and iOS support follows the current manifests and release workflow under `apps/mobile`. Mobile/Expo versions are intentionally maintained there rather than duplicated in this policy.

## Engine support is not the same as live-test coverage

AiDB registers multiple database protocols and vendor aliases, but registration does not mean every vendor/version has been verified. The tested-vs-gated matrix in [docs/09-multi-engine.md](./docs/09-multi-engine.md#10-测试与验证矩阵) is authoritative for automated coverage.

The manual `External engine contracts` workflow uses disposable MySQL, PostgreSQL, MongoDB, and Redis Stack services. It is not part of normal PR CI or the release gate. Oracle, DM8, SQL Server, SSH, pgvector/TimescaleDB, and the other listed engine suites remain environment-gated unless a run explicitly enables them. Always check the run for the commit you are using; workflow wiring alone is not a passing result.

## Support channels

- Bugs, reproducible failures, and feature requests: [GitHub Issues](https://github.com/keiskeies/ai-db/issues).
- Security reports: follow [SECURITY.md](./SECURITY.md); do not put sensitive details in a public issue.
- Documentation and troubleshooting: start with `README.md`, `docs/06-delivery-and-verification.md`, and the engine notes in `docs/09-multi-engine.md`.

Issue triage is best effort, with an initial-response goal of 7 calendar days. This is a policy target, not a guaranteed SLA. Commercial or priority support exists only if separately agreed in writing.

## Information to include

Provide the app/package version, OS and architecture, Node.js version for a standalone Bridge, database engine and server version, sanitized connection options, exact steps, expected/actual behavior, and relevant redacted logs. Never include passwords, private keys, device tokens, pairing codes, or production data. For engine-specific issues, include whether the connection is read-only and whether TLS/SSH is enabled.

## User responsibilities

Users are responsible for authorized database access, supported runtimes, current backups, host security, safe model-provider configuration, and review of generated SQL or agent actions. Read-only mode and approvals reduce risk but do not replace database permissions, network controls, or testing. Third-party database, cloud, model, and embedding providers support their own products under their own terms.
