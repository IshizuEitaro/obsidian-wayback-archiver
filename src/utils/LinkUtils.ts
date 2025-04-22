/**
 * Regex to find various link types: Markdown, HTML A/Img, Plain URL
 * - Group 0: The primary link structure (Markdown, HTML A, HTML Img, or Plain URL)
 * - Group 1: URL from Markdown `(![...](URL) or [...](URL))`
 * - Group 2: URL from HTML `<a href="URL">`
 * - Group 3: URL from HTML `<img src="URL">`
 * - Group 4: Plain HTTP/HTTPS URL
 * Markdown URL/Img Regex: !?\[[^\[\]]*\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)$
 * HTML A/Img Regex: <a\b(?=[^>]*href=["'])[^>]*href="((?:https?:\/\/|www\.)[^"]+)"[^>]*>.*?<\/a>|<img\b(?=[^>]*src=["'])[^>]*src="((?:https?:\/\/|www\.)[^"]+)"[^>]*>
 * Raw URL Regex: ^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$
 * Combined Regex: !?\[[^\[\]]*\]\((https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\)$|<a\b(?=[^>]*href=["'])[^>]*href="((?:https?:\/\/|www\.)[^"]+)"[^>]*>.*?<\/a>|<img\b(?=[^>]*src=["'])[^>]*src="((?:https?:\/\/|www\.)[^"]+)"[^>]*>|^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$
 * Thank you https://regex101.com/ and zolrath for auto link title 
 */
export const LINK_REGEX = new RegExp('!?\\[[^\\[\\]]*\\]\\((https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|www\\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9]+\\.[^\\s]{2,}|www\\.[a-zA-Z0-9]+\\.[^\\s]{2,})\\)$|<a\\b(?=[^>]*href=["\'])[^>]*href="((?:https?:\\\/\\\/|www\\.)[^"]+)"[^>]*>.*?<\\\/a>|<img\\b(?=[^>]*src=["\'])[^>]*src="((?:https?:\\\/\\\/|www\\.)[^"]+)"[^>]*>|^(https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|www\\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\\.[^\\s]{2,}|https?:\\\/\\\/(?:www\\.|(?!www))[a-zA-Z0-9]+\\.[^\\s]{2,}|www\\.[a-zA-Z0-9]+\\.[^\\s]{2,})$', 'img')

export const getUrlFromMatch = (match: RegExpMatchArray) => match[1] || match[2] || match[3] || match[4] || '';

// Regex to match both markdown and HTML adjacent archive links
export const ADJACENT_ARCHIVE_LINK_REGEX = new RegExp(
	// Markdown: [text](https://web.archive.org/web/123456789/http...)
	String.raw`^\s*\n*\s*(\[.*?\]\(https?:\/\/web\.archive\.org\/web\/(\d+|\*)\/.+?\))` +
	// OR HTML: <a href="https://web.archive.org/web/123456789/http...">text</a>
	String.raw`|(\s*\n*\s*<a [^>]*href=\\?"https?:\/\/web\.archive\.org\/web\/(\d+|\*)\/.+?\\?"[^>]*>.*?<\/a>)`,
	's'
);

export function isFollowedByArchiveLink(textFollowingLink: string): boolean {
    return ADJACENT_ARCHIVE_LINK_REGEX.test(textFollowingLink);
}

/**
 * Checks if a string matches any of the provided patterns using case-insensitive regex
 * with a fallback to string inclusion if the pattern is invalid regex.
 *
 * @param text The string to test (e.g., URL, file path).
 * @param patterns An array of pattern strings.
 * @returns True if the text matches at least one pattern, false otherwise.
 *          Returns false if the patterns array is null or empty.
 */
export function matchesAnyPattern(text: string, patterns: string[] | null | undefined): boolean {
    if (!patterns || patterns.length === 0) {
        return false;
    }

    return patterns.some(pattern => {
        if (!pattern || pattern.trim() === '') {
            return false;
        }

        try {
            return new RegExp(pattern, 'iu').test(text);
        } catch (e) {
            console.warn(`Invalid regex pattern: "${pattern}". Falling back to string inclusion check.`);
            return text.includes(pattern);
        }
    });
}

export function applySubstitutionRules(url: string, rules: { find: string; replace: string; regex?: boolean }[]): string {
	let result = url;
	for (const rule of rules) {
		if (!rule.find) continue;
		try {
			if (rule.regex) {
				const regex = new RegExp(rule.find, 'g');
				result = result.replace(regex, rule.replace || '');
			} else {
				result = result.split(rule.find).join(rule.replace || '');
			}
		} catch (e: any) {
			console.warn(`Error applying substitution rule: Find="${rule.find}", Regex=${rule.regex}. Error: ${e.message}`);
		}
	}
	return result;
}