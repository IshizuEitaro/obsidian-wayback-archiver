# Wayback Archiver

![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/IshizuEitaro/obsidian-wayback-archiver?style=for-the-badge&sort=semver) ![Obsidian Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22wayback-archiver%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=for-the-badge)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/ishizue)

This is an Obsidian plugin which automatically archives web links via Wayback Machine and appends archived versions in notes. It has a vault-wide archiving, filtering (include/exclude), substitution rule, retrying failed archive, profile based settings, and more.

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
  - [Force Re-archive links in current note](#force-re-archive-links-in-current-note)
  - [Force Re-archive all links in vault](#force-re-archive-all-links-in-vault)
  - [Retry failed archive attempts](#retry-failed-archive-attempts)
  - [Retry failed archive attempts (Force Replace)](#retry-failed-archive-attempts-force-replace)
  - [Export failed archive log](#export-failed-archive-log)
  - [Clear failed archive log](#clear-failed-archive-log)
- [Settings Guide](#settings-guide)
  - [Global API Keys](#global-api-keys)
  - [Profiles Management](#profiles-management)
  - [Profile Settings](#profile-settings)
    - [General](#general)
    - [Filtering Rules](#filtering-rules)
    - [URL Substitution Rules](#url-substitution-rules)
    - [Advanced Settings](#advanced-settings)
    - [SPN API v2 Options](#spn-api-v2-options)
- [Troubleshooting FAQ](#troubleshooting-faq)
- [LICENSE](#license)

## Installation

1.  Install the plugin via the Obsidian Community Plugins browser.
2.  Enable the plugin in your Obsidian settings.
3.  Configure the required API keys in the plugin settings tab (see [Global API Keys](#global-api-keys)).

## Core Concepts

### Archiving Process

The plugin scans your notes (either the current note, selected text, or the entire vault) for markdown links (`[text](url)` and `![text](url)`), HTML links (`<a href="url">text</a>` and `<img src="url">` ), and plain links (https://example.com). For each eligible link, it attempts to save a snapshot using the Archive.org Wayback Machine's SPN API v2.

### Archive Links

If archiving is successful, the plugin inserts a new markdown (or html) archive link immediately after the original link. The format of this link is configurable.

**Example:**
`[Example Site](https://example.com)` becomes
`[Example Site](https://example.com) [(Archived on 2025-04-10)](https://web.archive.org/web/20250410...)`

The plugin avoids adding archive links if one already exists immediately following the original link, unless using a "Force re-archive" command or "freshness" settings.

### Profiles

You can create multiple settings profiles to manage different configurations. Each profile stores its own set of rules (filtering, substitution, API options, etc.), but the Archive.org API keys are shared globally across all profiles. You can switch between profiles easily in the settings.

### Filtering

You can control which links get archived using several filtering mechanisms:

*   **Ignore Patterns:** URLs matching these patterns are always skipped.
*   **Include Patterns (Path, Word, URL):** These patterns define which notes and links are *eligible* for archiving.
*   **Path/Word Patterns:** Only apply during **vault-wide** commands. A note must match *both* a path pattern AND a word pattern (if both are defined) to be processed.
*   **URL Patterns:** Apply during **all** commands, filtering links within eligible notes.

### Substitution

Before attempting to archive a URL, you can apply find/replace rules. This is useful for fixing common URL issues, or redirecting to specific site versions (e.g., `reddit.com` -> `old.reddit.com`).

### Failed Archives

If the plugin fails to archive a link (due to API errors, timeouts, rate limits, etc.), the attempt is logged. You can view, export, and retry these failed attempts. Failed logs are stored in plugin.app.vault.configDir + /plugins/wayback-archiver/failed_logs/` within your vault.

## Commands

The plugin provides several commands accessible via the command palette (Ctrl/Cmd+P):

### Archive links in current note

*   **Scope:** Processes links in the currently active note. If text is selected, only processes links within the selection.
*   **Logic:**
    *   Applies **Ignore URL Patterns** and **Include URL Patterns**.
    *   Skips links that already have an adjacent archive link (unless the existing link is older than the `Archive Freshness` setting).
    *   Attempts to archive eligible links using the SPN API.
    *   If successful, inserts/replaces the archive link.
    *   If the API indicates a recent (within the `Archive Freshness` setting) snapshot already exists (or rate limit hit), it tries to fetch and insert the URL of the *latest specific snapshot*, but only if no adjacent archive link already exists.
*   **Note:** Path and Word patterns are **not** applied.

### Archive all links in vault

*   **Scope:** Processes links in all markdown files across the entire vault. Requires confirmation.
*   **Logic:**
    *   Filters notes based on **Include Path Patterns** and **Include Word Patterns** (note must match both if both are defined). Logs skipped files.
    *   Filters links within eligible notes based on **Ignore URL Patterns** and **Include URL Patterns**.
    *   Applies the same archiving and insertion/replacement logic as "Archive links in current note".
*   **Note:** This can take a significant amount of time depending on vault size and number of links.

### Force Re-archive links in current note

*   **Scope:** Processes links in the currently active note. If text is selected, only processes links within the selection.
*   **Logic:**
    *   Applies **Ignore URL Patterns** and **Include URL Patterns**.
    *   Attempts to archive eligible links, **ignoring** the `Archive Freshness` setting and any existing adjacent archive links.
    *   If successful, **replaces** any existing adjacent archive link or inserts a new one if none exists.
    *   If archiving fails or hits a rate limit, **no link is inserted or replaced**. The existing link (if any) is kept.
*   **Note:** Path and Word patterns are **not** applied.

### Force Re-archive all links in vault

*   **Scope:** Processes links in all markdown files across the entire vault. Requires confirmation.
*   **Logic:**
    *   Filters notes based on **Include Path Patterns** and **Include Word Patterns**. Logs skipped files.
    *   Filters links within eligible notes based on **Ignore URL Patterns** and **Include URL Patterns**.
    *   Applies the same archiving and replacement logic as "Force Re-archive links in current note".
*   **Note:** This can take a significant amount of time.

### Retry failed archive attempts

*   **Action:** Prompts you to select a failed log file (`.json` or `.csv`) from the plugin.app.vault.configDir + /plugins/wayback-archiver/failed_logs/` folder.
*   **Logic:** Attempts to archive each URL listed in the selected file.
    *   On success, removes the entry from the log file and inserts the archive link in the original note **only if no adjacent archive link already exists**.
    *   If all entries succeed, the log file is deleted.
    *   Prompts before clearing the internal failed list unless `Auto Clear Failed Logs` is enabled.

### Retry failed archive attempts (Force Replace)

*   **Action:** Same as the standard retry, but uses force logic.
*   **Logic:** Attempts to archive each URL listed in the selected file.
    *   On success, removes the entry from the log file and **replaces** any existing adjacent archive link in the original note (or inserts if none exists).
    *   If all entries succeed, the log file is deleted.
    *   Prompts before clearing the internal failed list unless `Auto Clear Failed Logs` is enabled.

### Export failed archive log

*   **Action:** Exports the current list of failed archive attempts to a new file.
*   **Logic:**
    *   Prompts you to choose either CSV or JSON format.
    *   Saves the log to a timestamped file (e.g., `wayback-archiver-failed-log-YYYYMMDDHHMMSS.json`) inside the plugin.app.vault.configDir + /plugins/wayback-archiver/failed_logs/` folder.
    *   Prompts if you want to clear the internal failed log list after successful export.

### Clear failed archive log

*   **Action:** Clears the internal list of failed archive attempts after confirmation.
*   **Note:** This does *not* delete exported log files.

## Settings Guide

Access the settings via Obsidian's Settings -> Community Plugins -> Wayback Archiver.

### Global API Keys

These keys are required to use the Archive.org SPN API v2 and are shared across all profiles.

*   **Archive.org SPN Access Key:** Your S3-like Access Key.
*   **Archive.org SPN Secret Key:** Your S3-like Secret Key.
*   **Get Keys:** You can generate API keys from your Archive.org account settings: [https://archive.org/account/s3.php](https://archive.org/account/s3.php)

### Profiles Management

Manage different sets of configurations.

*   **Active Profile:** Dropdown to select the profile whose settings are currently active and being edited below.
*   **Create Profile:** Creates a new profile (based on default settings) and activates it. You'll be prompted for a name.
*   **Rename Profile:** Renames the currently active profile (cannot rename "default").
*   **Delete Profile:** Deletes the currently active profile after confirmation (cannot delete "default"). Switches back to the "default" profile.

### Profile Settings

These settings apply only to the **currently active profile**.

#### General

*   **Date Format:** Define the format for the `{date}` placeholder in the archive link text. Uses `date-fns` format tokens (e.g., `yyyy-MM-dd`, `dd MMM yyyy`). Default: `yyyy-MM-dd`.
*   **Archive Link Text:** The template for the inserted archive link. Use `{date}` where you want the formatted date to appear. Default: `(Archived on {date})`.

#### Filtering Rules

Control which notes and links are processed.

*   **Ignore URL Patterns:** URLs matching these patterns (one per line, supports simple text or Regex) will be skipped during archiving. `web.archive.org` is ignored by default.
*   **URL Patterns:** (All commands) Only process links whose URL matches one of these patterns (one per line, simple text or Regex). Leave empty to process links with any URL (respecting Ignore Patterns).
*   **Path Patterns:** (Vault-wide commands only) Only process notes whose file path matches one of these patterns (one per line, simple text or Regex). Leave empty to process notes in any path.
*   **Word/Phrase Patterns:** (Vault-wide commands only) Only process notes containing at least one of these words or phrases (one per line, simple text match). Leave empty to process notes regardless of content.
*   **Logic:** For vault-wide commands, if Path and Word patterns are both defined, a note must match **both** to be included. URL patterns then filter links *within* those included notes.

#### URL Substitution Rules

Apply find/replace rules to URLs *before* they are sent for archiving.

*   Click "Add Substitution Rule" to add a new row.
*   **Find:** Enter the text or regular expression to find.
*   **Replace with:** Enter the text to replace the found pattern with. Leave empty to remove the found pattern.
*   **Regex?:** Check this box if the "Find" pattern should be treated as a regular expression (global flag `g` is applied automatically).
*   **Remove:** Deletes the rule row.
*   Rules are applied in the order they appear.

#### Advanced Settings

Fine-tune performance and behavior. 

*   **API Request Delay (ms):** Minimum time (in milliseconds) to wait between consecutive API calls (e.g., initiating capture, checking status, processing the next link). Helps avoid rate limiting. Default: 2000ms (2 seconds).
*   **Max Status Check Retries:** How many times the plugin should check the status of a pending archive job before giving up and marking it as failed (Timeout). Default: 3.
*   **Archive Freshness (Days):** (Standard archive commands only) Only request a *new* archive if the URL hasn't been archived within this many days. If a recent enough archive exists, the API might return that instead. Set to 0 to always try and create a new archive if one isn't already adjacent to the link. Default: 0.
*   **Auto Clear Failed Logs:** If enabled, successfully retried entries will be removed from the internal failed log without asking for confirmation. Default: false.

#### SPN API v2 Options

Control specific features of the Archive.org SPN API v2 capture process. Please read [API docs](https://docs.google.com/document/d/1Nsv52MvSjbLb2PCpHlat0gkzw0EvtSgpKHu4mk0MnrA/edit) for details.

*   **Capture Screenshot:** Request a screenshot (`capture_screenshot=1`). Default: false.
*   **Capture All Resources (capture_all=1):** Attempt to capture more embedded resources (JS, CSS, etc.) and handle errors better (`capture_all=1`). May increase capture time. Default: false.
*   **JS Behavior Timeout (ms):** Maximum time (in milliseconds) to allow JavaScript execution during capture. 0 uses the API default (`js_behavior_timeout`). Default: 0.
*   **Force GET Request (force_get=1):** Force the archiver to use an HTTP GET request (`force_get=1`). Default: false.
*   **Capture Outlinks (capture_outlinks=1):** Attempt to capture pages linked *from* the target URL (`capture_outlinks=1`). Use with caution, can be slow and consume more resources. Default: false.

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
    *   (Vault-wide) Does the note's path match your "Path Patterns"?
    *   (Vault-wide) Does the note's content match your "Word/Phrase Patterns"?
    *   (All commands) Does the link's URL match your "URL Patterns"? Remember the filtering logic described in the settings guide.
3.  **Adjacent Archive Link:** Is there already an archive link immediately following the original link? Standard archive commands will skip unless the existing link is older than the "Archive Freshness" setting. Force commands should still process it.
4.  **Non-HTTP(S):** The plugin only archives `http://` and `https://` links. Other protocols (like `ftp://`, `mailto:`) are ignored.
5.  **API Errors:** The link might be failing to archive on the Archive.org side. Check the Failed Archive Log.

**Q: I used "Force Re-archive", but an old archive link wasn't replaced.**

**A:** Force Re-archive only replaces an existing link if the *new* archive attempt is **successful**. If the attempt fails or hits a rate limit, the plugin will *not* modify the note, leaving the old link intact (or inserting nothing if no old link existed).

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

**Q: Filtering by Path/Word patterns doesn't work when archiving the current note.**

**A:** This is expected behavior. Path and Word patterns are designed to filter which *notes* are processed during **vault-wide** operations ("Archive all links in vault", "Force Re-archive all links in vault"). They do not apply when using the "current note" commands. URL patterns, however, apply in all commands.

## Out of Scope and Limitations
[Megalodon](https://megalodon.jp/) and [archive.today](https://archive.is/) won't be supported because they do not provide API.

Wayback Machine often fails to archive pages and there's a rate limit. Please be patient and try them again later.

## LICENSE
MIT (Archive Box icon is by b farias from <a href="https://thenounproject.com/browse/icons/term/archive-box/" target="_blank" title="Archive Box Icons">Noun Project</a> (CC BY 3.0))
