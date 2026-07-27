# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository's private GitHub security advisory flow or the private contact method listed on the repository page.

Include the affected version or commit, impact, reproduction steps, relevant logs, and any suggested mitigation. Please allow maintainers reasonable time to investigate and coordinate a fix before public disclosure.

## Supported versions

Security fixes target the default branch and the latest released version unless the repository documents a narrower support policy.

## Security expectations

- Never commit credentials, tokens, private keys, or sensitive environment files.
- Keep dependencies and GitHub Actions up to date through the repository's configured Dependabot policy.
- Report accidental secret exposure privately and rotate the credential immediately.
