# Security Policy

## Supported versions

Until the first stable release, only the latest commit on the default branch receives security fixes.

## Reporting a vulnerability

Please use the repository's private security-advisory feature rather than opening a public issue. Include:

- affected version or commit;
- reproduction steps;
- whether raw evidence, vault boundaries, migrations, mathematical execution, or generated files are involved;
- the smallest safe proof of impact.

Do not include personal study materials, credentials, or an entire vault.

## Security invariants

- Raw evidence is checksum verified on authoritative reads.
- Vault-relative paths are canonically contained and symlink escapes are rejected.
- Retrieved text is untrusted data and cannot change the assistant's workflow contract.
- Grounded answers and practice use raw evidence rather than model-written wiki synthesis.
- State writes are serialized and cross-process locked.
- Vault updates create managed-file backups, refuse downgrades, and preserve `raw/`.
- Mathematical evaluation uses a constrained grammar.
- LaTeX rendering disables shell escape and rejects file/system commands.

