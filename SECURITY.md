# Security

## Review for version 0.2.2

Reviewed on November 23, 2026 before initial public publication. Scope: extension source, optional enrichment script, tests, dependency lockfile, documentation and release file selection. This is a source review and automated validation, not an independent penetration test or a review of the CRM server.

## Findings addressed

1. Import report CSV export used a separate escaping function that did not neutralize spreadsheet formulas preceded by whitespace. It now uses the existing protected CSV serializer. A UI regression reproduces the vulnerable export before the fix.
2. The development dependency tree contained advisories affecting undici. The lockfile was updated using npm audit fix; the final audit is checked before publication. These dependencies are used for tests and are not bundled into the extension.
3. Packaging previously included every top level file in the extension directory. The release now uses an explicit allowlist and rejects symbolic link inputs, reducing accidental inclusion of local secrets or data.
4. Public documentation omits internal import results and private conversation references. Local contact exports, credentials, caches and administrative artifacts remain outside the Git index and release package.

## Validation results

27 JavaScript tests and 9 Python tests passed. Manifest, syntax and CSP checks passed. npm audit reported zero known vulnerabilities. Gitleaks 8.30.1 reported no secrets in the staged public source or extracted release files. These checks do not prove the absence of all vulnerabilities or private information.

## Controls reviewed

API keys are limited to trusted extension session storage and a selected HTTPS CRM endpoint. Requests omit browser credentials and reject redirects. GraphQL values are escaped or passed through variables. Raw server errors are not echoed into the UI. Privileged extension messages are restricted to the extension page. Imported text is rendered through textContent rather than HTML. CSV exports neutralize spreadsheet formulas. Content Security Policy disables inline and remote scripts. No externally connectable interface or web accessible resources are declared.

The optional enrichment script uses fixed HTTPS endpoints, refuses redirects, checks returned profile identity, requires explicit paid execution and retains batch IDs across interrupted polling.

## Remaining limits

Stored contacts are not encrypted by this extension. Someone with access to the local browser profile or exported files may access them. Use appropriate device and account controls.

CRM API permissions determine the scope of any exposed key. Use the minimum permissions required. An extension cannot enforce server authorization or guarantee duplicate prevention across concurrent clients and different profile aliases.

The extension is configured for Inevitable CRM and its custom objects. Public source does not grant access to the CRM. LinkedIn page changes can interrupt collection; compare counts and preserve incomplete status. Tests do not prove complete collection or live import behavior for another account.

## Reporting

Report sensitive findings through the repository's private vulnerability reporting feature when enabled. Do not include keys or personal contact exports in public issues. If private reporting is unavailable, use a private maintainer contact before sharing exploit details.
