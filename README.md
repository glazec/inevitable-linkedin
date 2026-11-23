# Inevitable Connections

A Chrome Manifest V3 extension for collecting your own LinkedIn connections, reviewing existing matches and importing contacts into [Inevitable CRM](https://crm.inevitable.tech).

Version 0.2.2. This is an unpacked extension, not a Chrome Web Store listing.

## Install

1. Download a release ZIP and unzip it, or clone this repository.
2. Open `chrome://extensions` in Google Chrome and enable Developer mode.
3. Click **Load unpacked**. Select the extracted folder containing `manifest.json`, or the `extension` directory in a source checkout.
4. Open **Inevitable Connections** from the Extensions menu.

Keep the installed folder in place. See [QUICKSTART.txt](QUICKSTART.txt) for the testing walkthrough.

## Collect and export

1. Sign into your own LinkedIn account in the same Chrome profile.
2. Click **Collect from LinkedIn** and keep the connections tab open while it scrolls.
3. When collection stops, compare the collected count with the displayed LinkedIn count.
4. Use **Export connections CSV** and **Export summary**. No CRM key is needed.

The collector reads displayed names, headlines, profile URLs and connection dates. It does not open individual profiles or call private LinkedIn endpoints. Unknown layouts, closed tabs, stalled loading and count mismatches remain explicitly unverified. Matching the displayed count does not prove every field is complete.

You can also import LinkedIn's official `Connections.csv`, containing First Name and Last Name columns. The extension's richer exported CSV is intended for review and the enrichment script; it is not the same input format as the official CSV importer.

## CRM setup and import

This build targets a specific Twenty workspace and its custom schema. It is not a generic connector for every Twenty installation. The source contains the two public server addresses it supports; access still requires your own authorized API key.

1. Create your own key in the CRM under **Settings → API & Webhooks**.
2. Open **CRM settings** and select the intended endpoint. The default is the existing Railway API endpoint; the alternative is `crm.inevitable.tech`. The extension does not redirect credentials between hosts.
3. The key needs read access to people and companies and create access to people. Saving connection ownership also requires read and create access to social connections and their participants.
4. Optionally click **Load team** and select yourself. This selector uses people marked `isIosgTeam`. Keep **Contacts only** if you do not want ownership relationships.
5. Click **Prepare preview** and review new contacts, existing matches, excluded rows and company matches. **Export report** includes every row.
6. Click **Import to CRM** to approve writes to the selected live workspace. Initial previews expire after ten minutes. Imports can be paused and resumed.

Existing people are reused without modifying their fields. Matching uses normalized LinkedIn URLs and email addresses, including identities read from secondary CRM fields during preview. Conflicting identities and repeated source rows are excluded. Names alone are not used to establish identity. Aliases, missing identifiers and concurrent creation by another client can still produce duplicates; review uncertain cases before importing.

New people receive only observed source fields. A CSV company links only when exactly one existing company has the same normalized name. Browser headlines are retained in the report rather than guessed into a company or title. Display names are preserved intact rather than guessing surname boundaries.

Selecting an owner saves a LinkedIn social connection and both participants. The source connection date is retained in the report and new relationship summary. It does not imply a strong relationship or personal introduction. Existing relationship metadata is retained.

Created people, relationships and participants use deterministic IDs. Writes are read back. An uncertain response pauses the job; resuming checks for saved records before retrying. This is not a transactional lock across independent clients.

## Optional enrichment

Company history, education, location and career dates are not automatically fetched by the browser extension. The optional Python script uses [Lima](https://limadata.com) and never writes to the CRM.

```sh
python3 scripts/enrich_connections.py connections.csv connections-enriched.csv
```

By default this previews all rows and merges validated cached responses without paid requests. To authorize a limited paid sample, set `LIMA_ENRICH_API_KEY` or `LIMA_API_KEY` in your environment and run:

```sh
python3 scripts/enrich_connections.py connections.csv connections-enriched.csv --run --limit 1
```

The limit bounds new paid submissions, not output rows. All input rows remain in the output. Cached results and saved batch IDs support resuming without resubmission. An uncertain submission must be reconciled before retrying. Keep exports and the local cache private.

Enrichment fills empty source fields and retains provider candidates for review. Roles without an end date can be stale or concurrent. The earliest listed role explicitly labeled full time is not a verified first job. Compare provider results with the original headline. Lists are JSON values inside CSV cells.

## Privacy and security

API keys stay in `chrome.storage.session`, restricted to trusted extension contexts. Restarting Chrome or choosing **Forget API key** clears the key. Contact data and progress stay in `chrome.storage.local` until **Clear local import data** is used. That does not delete CRM records. Local storage is not encrypted by the extension.

The extension sends imported data only to the selected allowlisted CRM endpoint. It has no analytics and no automatic enrichment. The separate Python script sends requested profile URLs to Lima only with explicit execution. No credentials or contact exports are included in this repository or release ZIP.

Permissions support local storage, larger connection lists, background import scheduling and injection on LinkedIn. The extension requests no cookies or browser history permissions. The package has no runtime npm dependencies.

Read [SECURITY.md](SECURITY.md) for the security review, residual risks and reporting guidance.

## Development

Use a Node.js version supported by the pinned jsdom development dependency, npm and Python 3.

```sh
npm ci --ignore-scripts
npm test
python3 -m unittest discover -s test -p 'test_*.py'
npm run check
npm audit
npm run package
```

Packaging writes `inevitable-linkedin.zip` beside the checkout using an explicit file list. Credentials, contact exports, caches, local import artifacts and dependencies are excluded. Tests use synthetic contacts and simulated CRM writes. Passing tests does not establish current LinkedIn layout compatibility or a successful live CRM import.
