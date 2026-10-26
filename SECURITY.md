# Security

BetterSync's threat model is in [docs/DESIGN.md](docs/DESIGN.md#security): one shared bearer token over TLS (terminated by your nginx), the server bound to localhost, no end-to-end encryption, notes stored in plaintext on a host with full-disk encryption.

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (the **Security** tab → **Report a vulnerability**), not in a public issue. Useful reports include anything that lets a client without the token read or write the vault, write outside the vault folder, or make a device silently lose an edit.

There is no release yet, so fixes land on `main`.
