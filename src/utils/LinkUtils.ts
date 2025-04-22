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

export function isIgnoredUrl(url: string, ignorePatterns: string[]): boolean {
	return ignorePatterns.some(pattern => {
		if (!pattern || pattern.trim() === '') return false;
		try {
			return new RegExp(pattern, 'i').test(url);
		} catch (e) {
			return url.includes(pattern);
		}
	}) || url.includes('web.archive.org/');
}

export function matchesPathPatterns(filePath: string, pathPatterns: string[]): boolean {
	if (!pathPatterns.length) return true;
	return pathPatterns.some(pattern => {
		if (!pattern || pattern.trim() === '') return false;
		try {
			return new RegExp(pattern, 'i').test(filePath);
		} catch (e) {
			return filePath.includes(pattern);
		}
	});
}

export function matchesWordPatterns(content: string, wordPatterns: string[]): boolean {
	if (!wordPatterns.length) return true;
	return wordPatterns.some(pattern => pattern && pattern.trim() !== '' && content.includes(pattern));
}

export function matchesUrlPatterns(url: string, urlPatterns: string[]): boolean {
	if (!urlPatterns.length) return true;
	return urlPatterns.some(pattern => {
		if (!pattern || pattern.trim() === '') return false;
		try {
			return new RegExp(pattern, 'i').test(url);
		} catch (e) {
			return url.includes(pattern);
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