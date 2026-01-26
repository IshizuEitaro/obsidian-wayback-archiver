import { describe, it, expect } from 'vitest';
import { LINK_REGEX, getUrlFromMatch, isFollowedByArchiveLink } from './LinkUtils';

describe('Link Detection (Balanced Parentheses & Edge Cases)', () => {
    const getMatches = (text: string) => {
        return Array.from(text.matchAll(LINK_REGEX)).map(m => getUrlFromMatch(m));
    };

    describe('Markdown Links & Images', () => {
        it('should handle nested parentheses in Wikipedia links', () => {
            const text = '[Erica](https://en.wikipedia.org/wiki/Erica_(plant))';
            expect(getMatches(text)).toContain('https://en.wikipedia.org/wiki/Erica_(plant)');
        });

        it('should handle complex nested parentheses in RHS links', () => {
            const text = '[Viola](https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details)';
            expect(getMatches(text)).toContain('https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details');
        });

        it('should handle markdown images', () => {
            const text = '![Alt](https://site.com/img.png)';
            expect(getMatches(text)).toContain('https://site.com/img.png');
        });
    });

    describe('HTML Tags', () => {
        it('should handle standard anchor tags', () => {
            const text = '<a href="https://example.com">Link</a>';
            expect(getMatches(text)).toContain('https://example.com');
        });

        it('should handle single quoted href', () => {
            const text = "<a href='https://example.com'>Link</a>";
            expect(getMatches(text)).toContain('https://example.com');
        });

        it('should handle image tags', () => {
            const text = '<img src="https://example.com/pic.jpg">';
            expect(getMatches(text)).toContain('https://example.com/pic.jpg');
        });
    });

    describe('Plain URLs (Balanced punctuation)', () => {
        it('should match a plain URL in the middle of text', () => {
            const text = 'Visit https://example.com for more info.';
            expect(getMatches(text)).toContain('https://example.com');
        });

        it('should NOT include trailing parenthesis in plain URLs', () => {
            const text = '(See https://example.com)';
            expect(getMatches(text)).toContain('https://example.com');
        });

        it('should include trailing parenthesis if it is balanced', () => {
            const text = 'Check out https://en.wikipedia.org/wiki/Erica_(plant)';
            expect(getMatches(text)).toContain('https://en.wikipedia.org/wiki/Erica_(plant)');
        });
    });

    describe('Adjacent Archive Link Detection', () => {
        it('should correctly detect archive links with parentheses', () => {
            const nextText = ' [(Archived on 2026-01-25)](https://web.archive.org/web/20260125095621/https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details)';
            expect(isFollowedByArchiveLink(nextText)).toBe(true);
        });

        it('should handle HTML archive links with parentheses', () => {
            const nextText = ' <a href="https://web.archive.org/web/20260125095621/https://www.rhs.org.uk/plants/68664/i-viola-i-belmont-blue-(c)/details">Archive</a>';
            expect(isFollowedByArchiveLink(nextText)).toBe(true);
        });
    });
});
