# Wayback Archiver

![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/IshizuEitaro/obsidian-wayback-archiver?style=for-the-badge&sort=semver) ![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22wayback-archiver%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=for-the-badge)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ishizue)

[日本語 (Japanese)](./README.ja.md)

This is an Obsidian plugin which automatically archives web links via Wayback Machine and appends archived versions in notes. It supports vault-wide archiving, include/exclude filtering, URL substitution rules, retrying failed archives, profile-based settings, fallback providers, and more.

## Table of Contents

- [Installation](#installation)
- [Core Concepts](#core-concepts)
    - [Archiving Process](#archiving-process)
    - [Archive Links](#archive-links)
    - [Profiles](#profiles)
    - [Filtering](#filtering)
    - [Substitution](#substitution)
    - [Failed Archives](#failed-archives)
- [Commands](#commands)
    - [Archive links in current note](#archive-links-in-current-note)
    - [Archive all links in vault](#archive-all-links-in-vault)
    - [Force re-archive links in current note](#force-re-archive-links-in-current-note)
    - [Force re-archive all links in vault](#force-re-archive-all-links-in-vault)
    - [Retry failed archive attempts](#retry-failed-archive-attempts)
    - [Retry failed archive attempts (Force Replace)](#retry-failed-archive-attempts-force-replace)
    - [Export failed archive log](#export-failed-archive-log)
    - [Clear failed archive log](#clear-failed-archive-log)
    - [archive.today and Web Gyotaku helper commands](#archivetoday-and-web-gyotaku-helper-commands)
- [Settings Guide](#settings-guide)
    - [Global API Keys](#global-api-keys)
    - [Profiles Management](#profiles-management)
    - [Profile Settings](#profile-settings)
        - [General](#general)
        - [Filtering Rules](#filtering-rules)
        - [URL Substitution Rules](#url-substitution-rules)
        - [Archive Providers and Fallbacks](`#archive-providers-and-fallbacks`)
        - [archive.today Pending Queue and Manual Fallback Options](`#archivetoday-pending-queue-and-manual-fallback-options`)
        - [Per-URL Archive Policies](#per-url-archive-policies)
        - [Advanced Settings](#advanced-settings)
        - [SPN API v2 Options](#spn-api-v2-options)
- [Troubleshooting FAQ](#troubleshooting-faq)
- [Limitations](#limitations)
    - [Experimental: archive.today auto-submit](`#experimental-archivetoday-auto-submit`)
- [LICENSE](#license)

## Installation

1.  Install the plugin via the Obsidian Community Plugins browser.
2.  Enable the plugin in your Obsidian settings.
3.  Configure the required API keys in the plugin settings tab (see [Global API Keys](#global-api-keys)).

## Core Concepts

### Archiving Process

The plugin scans your notes (either the current note, selected text, or the entire vault) for Markdown links (`[text](url)` and `![text](url)`), HTML links (`<a href="url">text</a>` and `<img src="url">` ), and plain links (`https://example.com`). For each eligible link, it attempts to save a snapshot using the Archive.org Wayback Machine's SPN API v2.

### Archive Links

If archiving is successful, the plugin inserts a new Markdown (or HTML) archive link immediately after the original link. The format of this link is configurable.

**Example:**
`[Example Site](https://example.com)` becomes
`[Example Site](https://example.com) [(Archived on 2025-04-10)](https://web.archive.org/web/20250410...)`

The plugin avoids adding archive links if one already exists immediately following the original link, unless using a "Force re-archive" command or the existing archive link is older than the configured Archive Freshness threshold.

> [!NOTE]
> **Adjacency Specification:** An existing archive link is considered "adjacent" if it is found within the first **300 characters** (the adjacent search limit) following the original link. This optimizes regular expression performance and prevents matching archive links that belong to different original links further down the document.

### Profiles

You can create multiple settings profiles to manage different configurations. Each profile stores its own set of rules (filtering, substitution, API options, etc.), but the Archive.org API keys are shared globally across all profiles. You can switch between profiles easily in the settings.

### Filtering

You can control which links get archived using several filtering mechanisms:

- **Ignore Patterns:** URLs matching these patterns are always skipped.
- **Include Patterns (Path, Word, URL):** These patterns define which notes and links are _eligible_ for archiving.
- **Path/Word Patterns:** Apply during **vault-wide** commands and **current-note** commands (only when processing the entire note without any text selection). A note must match _both_ a path pattern AND a word pattern (if both are defined) to be processed. If you run a command with selected text, the selection takes precedence, and Path/Word patterns are ignored.
- **URL Patterns:** Apply during **all** commands, filtering links within eligible notes.

### Substitution

Before attempting to archive a URL, you can apply find/replace rules. This is useful for fixing common URL issues, or redirecting to specific site versions (e.g., `reddit.com` -> `old.reddit.com`).

### Failed Archives

If the plugin fails to archive a link (due to API errors, timeouts, rate limits, etc.), the attempt is logged. You can view, export, and retry these failed attempts.

The plugin keeps an internal failed archive list in its plugin data. You can export this list to JSON or CSV for review or retry. Exported log files are separate files; clearing the internal failed list does not delete previously exported log files. Saved log files are stored under your Obsidian configuration folder, usually `.obsidian/plugins/wayback-archiver/failed_logs/`.

To avoid log bloat, repeated failures for the same URL, file, target URL, and failure stage within a short time window are coalesced into one failed entry.

## Commands

The plugin provides several commands accessible via the command palette (Ctrl/Cmd+P):

### Archive links in current note

- **Scope:** Processes links in the currently active note. If text is selected, only processes links within the selection.
- **Logic:**
    - Applies **Ignore URL Patterns** and **Include URL Patterns**.
    - Skips links that already have an adjacent archive link (unless the existing link is older than the `Archive Freshness` setting).
    - Attempts to archive eligible links using the SPN API.
    - If successful, inserts/replaces the archive link.
    - If the API indicates a recent (within the `Archive Freshness` setting) snapshot already exists (or rate limit hit), instead of taking a new snapshot, it tries to search for, fetch, and insert the URL of the latest existing historical snapshot (with a specific timestamp), but only if no adjacent archive link already exists.
- **Note:** Path/Word pattern filtering only applies **when processing the entire note without any text selection**. If you run the command with selected text, the selection takes full precedence and Path/Word patterns are ignored.

### Archive all links in vault

- **Scope:** Processes links in all Markdown files across the entire vault. Requires confirmation.
- **Logic:**
    - Filters notes based on **Include Path Patterns** and **Include Word Patterns** (note must match both if both are defined). Logs skipped files.
    - Filters links within eligible notes based on **Ignore URL Patterns** and **Include URL Patterns**.
    - Applies the same archiving and insertion/replacement logic as "Archive links in current note".
- **Note:** This can take a significant amount of time depending on vault size and number of links.

### Force re-archive links in current note

- **Scope:** Processes links in the currently active note. If text is selected, only processes links within the selection.
- **Logic:**
    - Applies **Ignore URL Patterns** and **Include URL Patterns**.
    - Attempts to archive eligible links, **ignoring** the `Archive Freshness` setting and any existing adjacent archive links.
    - If successful, **replaces** any existing adjacent archive link or inserts a new one if none exists.
    - If archiving fails or hits a rate limit, **no link is inserted or replaced**. The existing link (if any) is kept.
- **Note:** Path/Word pattern filtering only applies **when processing the entire note without any text selection**. If you run the command with selected text, the selection takes full precedence and Path/Word patterns are ignored.

### Force re-archive all links in vault

- **Scope:** Processes links in all Markdown files across the entire vault. Requires confirmation.
- **Logic:**
    - Filters notes based on **Include Path Patterns** and **Include Word Patterns**. Logs skipped files.
    - Filters links within eligible notes based on **Ignore URL Patterns** and **Include URL Patterns**.
    - Applies the same archiving and replacement logic as "Force re-archive links in current note".
- **Note:** This can take a significant amount of time.

### Retry failed archive attempts

- **Action:** Prompts you to select a failed log file (`.json` or `.csv`) from the failed log folder, usually `.obsidian/plugins/wayback-archiver/failed_logs/`.
- **Logic:** Attempts to archive each URL listed in the selected file.
    - On success, removes the entry from the log file and inserts the archive link in the original note **only if no adjacent archive link already exists**.
    - If all entries succeed, the log file is deleted.
    - Prompts before clearing the internal failed list unless `Auto Clear Failed Logs` is enabled.

### Retry failed archive attempts (Force Replace)

- **Action:** Same as the standard retry, but uses force logic.
- **Logic:** Attempts to archive each URL listed in the selected file.
    - On success, removes the entry from the log file and **replaces** any existing adjacent archive link in the original note (or inserts if none exists).
    - If all entries succeed, the log file is deleted.
    - Prompts before clearing the internal failed list unless `Auto Clear Failed Logs` is enabled.

### Export failed archive log

- **Action:** Exports the current list of failed archive attempts to a new file.
- **Logic:**
    - Prompts you to choose either CSV or JSON format.
    - Saves the log to a timestamped file (e.g., `wayback-archiver-failed-log-YYYYMMDDHHMMSS.json`) inside the failed log folder, usually `.obsidian/plugins/wayback-archiver/failed_logs/`.
    - Prompts if you want to clear the internal failed log list after successful export.

### Clear failed archive log

- **Action:** Clears the internal list of failed archive attempts after confirmation.
- **Note:** This does _not_ delete exported log files.

### archive.today and Web Gyotaku helper commands

These commands allow you to interact with alternative providers directly or manage the background pending queue.

- **Submit current note links to archive.today**:
    - **Scope:** Processes links in the currently active note. If text is selected, only processes links within the selection.
    - **Logic:** Starts archive.today background submissions for all eligible links in the note/selection and adds them to the pending queue when a final snapshot URL is not immediately available.
    - **Note:** This command still depends on archive.today's unofficial submit flow and may fail due to rate limits, CAPTCHA, anti-bot checks, or site changes.
- **Insert latest archive.today snapshot in current note**:
    - **Scope:** Processes links in the current note. If text is selected, only processes links within the selection.
    - **Logic:** Queries archive.today for the latest existing snapshot of target URLs and inserts them immediately, without triggering a new save.
- **Insert latest Web Gyotaku snapshot in current note**:
    - **Scope:** Processes links in the current note. If text is selected, only processes links within the selection.
    - **Logic:** Queries Web Gyotaku (Megalodon.jp) for the latest existing snapshot of target URLs and inserts them immediately, without triggering a new save.
- **Check pending archive.today snapshots now**:
    - **Action:** Forces an immediate background poll cycle of all pending archive.today background submission requests.
- **Open next failed URLs in archive.today**:
    - **Action:** Opens the next batch of failed archive URLs in your default web browser for manual handling on archive.today.
    - **Note:** This is useful when CAPTCHA, rate limits, or anti-bot checks prevent background submission.
- **Open next failed URLs in Web Gyotaku**:
    - **Action:** Opens the next batch of failed archive URLs in your default web browser for manual handling on Web Gyotaku (Megalodon.jp).
    - **Note:** The plugin does not automatically submit URLs to Web Gyotaku. Any save action must be completed manually in the browser.

## Settings Guide

Access the settings via Obsidian's Settings -> Community Plugins -> Wayback Archiver.

### Global API Keys

These keys are required to use the Archive.org SPN API v2 and are shared across all profiles.

- **Archive.org SPN Access Key:** Your S3-like Access Key.
- **Archive.org SPN Secret Key:** Your S3-like Secret Key.
- **Get Keys:** You can generate API keys from your Archive.org account settings: [https://archive.org/account/s3.php](https://archive.org/account/s3.php)

### Profiles Management

Manage different sets of configurations.

- **Active Profile:** Dropdown to select the profile whose settings are currently active and being edited below.
- **Create Profile:** Creates a new profile (based on default settings) and activates it. You'll be prompted for a name.
- **Rename Profile:** Renames the currently active profile (cannot rename "default").
- **Delete Profile:** Deletes the currently active profile after confirmation (cannot delete "default"). Switches back to the "default" profile.

### Profile Settings

These settings apply only to the **currently active profile**.

#### General

- **Date Format:** Define the format for the `{date}` placeholder in the archive link text. Uses `date-fns` format tokens (e.g., `yyyy-MM-dd`, `dd MMM yyyy`). Default: `yyyy-MM-dd`.
- **Archive Link Text:** The template for the inserted archive link. Placeholders available:
    - `{date}`: replaced with the formatted archive date.
    - `{provider}`: replaced with the name of the archive provider (e.g., `Wayback Machine`, `archive.today`, `Web Gyotaku (Megalodon.jp)`).
    - **Default:** `(Archived on {date})`.

#### Filtering Rules

Control which notes and links are processed.

- **Ignore URL Patterns:** URLs matching these patterns (one per line, supports simple text or Regex) will be skipped during archiving. `web.archive.org` is ignored by default.
- **URL Patterns:** (All commands) Only process links whose URL matches one of these patterns (one per line, simple text or Regex). Leave empty to process links with any URL (respecting Ignore Patterns).
- **Path Patterns:** (Vault-wide commands and selection-free current-note commands) Only process notes whose file path matches one of these patterns (one per line, simple text or Regex). Leave empty to process notes in any path.
- **Word/Phrase Patterns:** (Vault-wide commands and selection-free current-note commands) Only process notes containing at least one of these words or phrases (one per line, simple text match). Leave empty to process notes regardless of content.
- **Logic:** For eligible commands (vault-wide, or current-note without selection), if Path and Word patterns are both defined, a note must match **both** to be included. URL patterns then filter links _within_ those included notes.

#### URL Substitution Rules

Apply find/replace rules to URLs _before_ they are sent for archiving.

- Click "Add Substitution Rule" to add a new row.
- **Find:** Enter the text or regular expression to find.
- **Replace with:** Enter the text to replace the found pattern with. Leave empty to remove the found pattern.
- **Regex?:** Check this box if the "Find" pattern should be treated as a regular expression (global flag `g` is applied automatically).
- **Remove:** Deletes the rule row.
- Rules are applied in the order they appear.

#### Archive Providers and Fallbacks

Configure fallback providers and provider order for cases where Wayback Machine fails or where a per-URL policy routes specific URLs to another provider.

- **Use archive.today fallback:** Resolve and insert existing archive.today snapshots if Wayback Machine fails to save. This does not submit a new archive.today save by itself.
- **Use Web Gyotaku fallback:** Resolve and insert existing Web Gyotaku (Megalodon.jp) snapshots if earlier providers fail. This is resolve-only; no automatic save is performed.
- **Background archive.today auto-submit:** Experimental and disabled by default. If enabled, the plugin submits the URL to archive.today via background HTTP requests before attempting to resolve snapshots, rather than only looking up existing snapshots.

#### archive.today Pending Queue and Manual Fallback Options

Fine-tune the experimental background submission and verification queue for archive.today.

- **archive.today submit delay between requests (ms):** Minimum delay between consecutive automated submit requests to reduce rate-limit risk. Range: 1,000ms - 10,000ms. Default: 5,000ms.
- **archive.today pending poll interval (ms):** How often the background scheduler checks pending archive.today submissions. Range: 15,000ms - 300,000ms. Default: 60,000ms.
- **archive.today pending poll batch size:** How many pending entries are verified in each status-check poll cycle. Range: 1 - 10. Default: 3.
- **archive.today pending max wait (ms):** Maximum time a pending submission is kept in the queue before timing out and moving to the failed list. Range: 60,000ms - 1,200,000ms. Default: 600,000ms.
- **archive.today max pending count:** Maximum number of archive.today pending entries retained locally. This does not directly control request rate; submit delay, poll interval, and poll batch size do. When this limit is reached, new background submissions are not queued until existing pending entries are resolved, failed, or cleared. Range: 1 - 100. Default: 30.
- **Manual save batch size:** Number of failed URLs to open simultaneously in browser tabs when running manual fallback browser opening commands. Range: 1 - 5. Default: 5.

#### Per-URL Archive Policies

Specify custom archiving providers based on regular expression patterns matched against target URLs.

- **Format:** Enter one policy per line using `pattern => providers`.
- **Supported Providers:**
    - `wayback`: Archive.org Wayback Machine (saves and resolves)
    - `archiveToday`: resolve existing archive.today snapshots only; does not submit a new save.
    - `archiveToday:auto`: attempts experimental background submission, then resolves the resulting snapshot later if available. See [Experimental: archive.today auto-submit](`#experimental-archivetoday-auto-submit`) before enabling this.
    - `megalodon`: Web Gyotaku (Megalodon.jp) (resolves existing snapshots only, no auto-submit)

- **Example:**
    ```text
    ^https://x\.com/ => archiveToday:auto
    example\.com => wayback, archiveToday
    ```

#### Advanced Settings

Fine-tune performance and behavior.

- **API Request Delay (ms):** Minimum time (in milliseconds) to wait between consecutive API calls (e.g., initiating capture, checking status, processing the next link). Helps avoid rate limiting. Default: 2000ms (2 seconds).
- **Max Status Check Retries:** How many times the plugin should check the status of a pending archive job before giving up and marking it as failed (Timeout). Default: 3.
- **Archive Freshness (Days):** (Standard archive commands only) If an adjacent archive link exists and its timestamp is within this many days, the plugin skips the link. If the adjacent archive is older or cannot be dated, the plugin may request a new archive and replace it. Set to 0 to treat existing adjacent archive links as stale unless using other skip logic. Default: 0.
- **Auto Clear Failed Logs:** If enabled, successfully retried entries will be removed from the internal failed log without asking for confirmation. Default: false.

#### SPN API v2 Options

Control specific features of the Archive.org SPN API v2 capture process. Please read [API docs](https://docs.google.com/document/d/1Nsv52MvSjbLb2PCpHlat0gkzw0EvtSgpKHu4mk0MnrA/edit) for details.

- **Capture Screenshot:** Request a screenshot (`capture_screenshot=1`). Default: false.
- **Capture All Resources (capture_all=1):** Attempt to capture more embedded resources (JS, CSS, etc.) and handle errors better (`capture_all=1`). May increase capture time. Default: false.
- **JS Behavior Timeout (ms):** Maximum time (in milliseconds) to allow JavaScript execution during capture. 0 uses the API default (`js_behavior_timeout`). Default: 0.
- **Force GET Request (force_get=1):** Force the archiver to use an HTTP GET request (`force_get=1`). Default: false.
- **Capture Outlinks (capture_outlinks=1):** Attempt to capture pages linked _from_ the target URL (`capture_outlinks=1`). Use with caution, can be slow and consume more resources. Default: false.

## Troubleshooting FAQ

**Q: Why are my API keys not working? / Getting "Configuration Error".**

**A:**

1.  Ensure you have copied the **Access Key** and **Secret Key** correctly from [https://archive.org/account/s3.php](https://archive.org/account/s3.php) into the **Global API Keys** section of the plugin settings.
2.  Make sure there are no leading/trailing spaces.
3.  Remember these keys are global; they don't need to be set per profile.

**Q: Archiving fails frequently or I get rate limit errors (like HTTP 429).**

**A:**

1.  The Archive.org API has usage limits. Try increasing the **API Request Delay** in Advanced Settings (e.g., to 3000ms or 5000ms).
2.  You might be hitting daily capture limits imposed by Archive.org. The plugin attempts to handle this by fetching the latest available snapshot URL when a 429 or similar "too many captures" response is received during standard archiving.
3.  Check the **Failed Archive Log** (using the Export or Retry commands) for specific error messages.

**Q: Certain links are not being archived. Why?**

**A:** Check the following:

1.  **Ignore Patterns:** Does the URL match any pattern in the "Ignore URL Patterns" setting for the active profile?
2.  **Include Patterns:**
    - (Vault-wide, or current-note without selection) Does the note's path match your "Path Patterns"?
    - (Vault-wide, or current-note without selection) Does the note's content match your "Word/Phrase Patterns"?
    - (All commands) Does the link's URL match your "URL Patterns"? Remember the filtering logic described in the settings guide.
3.  **Adjacent Archive Link:** Is there already an archive link immediately following the original link? Standard archive commands will skip unless the existing link is older than the "Archive Freshness" setting. Force commands should still process it.
4.  **Non-HTTP(S):** The plugin only archives `http://` and `https://` links. Other protocols (like `ftp://`, `mailto:`) are ignored.
5.  **API Errors:** The link might be failing to archive on the Archive.org side. Check the Failed Archive Log.

**Q: I used "Force Re-archive", but an old archive link wasn't replaced.**

**A:** Force re-archive only replaces an existing link if the _new_ archive attempt is **successful**. If the attempt fails or hits a rate limit, the plugin will _not_ modify the note, leaving the old link intact (or inserting nothing if no old link existed).

**Q: How do I manage links that consistently fail to archive?**

**A:**

1.  Use the **Export failed archive log** command to get a list (CSV or JSON) of failed URLs and their errors.
2.  Investigate why they might be failing (e.g., website blocking archivers, temporary site issues).
3.  Use the **Retry failed archive attempts** command periodically to try again.
4.  If a URL will never be archivable, consider adding it to your **Ignore URL Patterns**.
5.  Use the **Clear failed archive log** command to remove persistent failures if you no longer wish to track them.

**Q: My Substitution Rules aren't working correctly.**

**A:**

1.  If using Regex, ensure the **Regex?** box is checked and your pattern syntax is correct. Remember the `g` flag is added automatically.
2.  Check the order of rules; they are applied sequentially.
3.  Ensure the "Find" pattern accurately matches the part of the URL you intend to replace. Simple text matching is case-sensitive.

**Q: How do Path/Word patterns apply when archiving the current note?**

**A:** Path and Word patterns **do apply** when running a "current note" command, but **only if you do not have any active text selection** (i.e., when processing the entire file). If the active note does not match your configured path patterns or contains none of your word patterns, the archiving process will be skipped for that note.
However, if you run a command with an **active text selection**, the selection takes full precedence. In this case, the file-level Path/Word filtering is ignored, and the plugin will always process any links found within your selected text. URL patterns, on the other hand, apply to individual links across all commands regardless of selection.

**Q: archive.today auto-submit does not create a snapshot. Why?**

**A:** archive.today auto-submit is experimental and best-effort. archive.today does not provide a stable public saving API, and requests may be blocked by rate limits, CAPTCHA, anti-bot checks, regional/network differences, or site changes. Try using **Open next failed URLs in archive.today** to complete the save manually in your browser, then run **Check pending archive.today snapshots now** or **Insert latest archive.today snapshot for selected links**.

## Supporting the Project & Providers

If you find this plugin useful, please consider supporting both the development of this project and the incredible archiving services that make it possible:

### Support the Developer

- **Ko-fi**: You can support the plugin creator directly via [Ko-fi](https://ko-fi.com/ishizue).

### Support Archive Providers

- **Wayback Machine (Archive.org)**: Support their mission to digitize and preserve history by [donating to Internet Archive](https://archive.org/donate/).
- **archive.today**: This free preservation service is funded privately and accepts donations. You can find their Monero donation link at the top of the [archive.today / archive.md homepage](https://archive.md/).
- **Web Gyotaku (Megalodon.jp)**: They offer paid user features/plans. Learn more on their [introduction page](https://megalodon.jp/pc/user/introduction).

## Limitations

- **Wayback Machine:** Captures may fail, time out, or be rate-limited. If a capture limit is reached, the plugin may try to insert the latest available snapshot instead of creating a new one.
- **archive.today:** Existing snapshots can be resolved, and experimental auto-submit is available. However, archive.today does not provide a stable public saving API, so auto-submit is best-effort and may stop working at any time.
- **Web Gyotaku (Megalodon.jp):** This plugin supports resolving existing snapshots only. It does not automatically save or submit new URLs to Web Gyotaku.
- **Adjacent archive detection:** Existing archive links are detected only within the adjacent search limit after the original link.
- **Duplicate URLs:** When the same URL appears multiple times in a note, the plugin chooses the occurrence closest to the original position observed during scanning. This is robust for normal edits but remains best-effort if the note is heavily edited while archiving is in progress.

### Experimental: archive.today auto-submit

`archive.today auto-submit` is an experimental fallback feature. When configured, the plugin may try to submit URLs to archive.today automatically, usually after Wayback Machine fails or when an archive policy routes matching URLs to archive.today.

Because archive.today does not provide a stable public API for automated saves, this feature is best-effort only. It may fail or behave inconsistently due to:

- changes in archive.today's website structure or submit flow
- IP rate limits, temporary blocks, CAPTCHA, or other anti-bot checks
- regional/network differences
- temporary archive.today availability issues
- delayed snapshot creation after submission

When a submitted URL does not immediately produce a fixed snapshot URL, the plugin may keep it in a pending queue and check again later. If no snapshot is resolved before the configured timeout, the entry is moved to the failed log.

This option is disabled by default. Enable it only if you understand that it may stop working at any time. For more predictable handling, use the manual archive.today commands and review pending/failed entries after processing.

> [!WARNING]
> Even when auto-submit appears to succeed, the plugin cannot guarantee that archive.today will create a snapshot or expose a final snapshot URL.

## LICENSE

MIT (Archive Box icon is by b farias from <a href="https://thenounproject.com/browse/icons/term/archive-box/" target="_blank" title="Archive Box Icons">Noun Project</a> (CC BY 3.0))
