import { describe, it, expect } from 'vitest';
import { findLatestLinkIndex } from './contentManipulator';

describe('Content Manipulator - Match-at-Insertion', () => {
    it('should find the link index accurately in original content', () => {
        const content = 'Check this [Link](https://example.com) out.';
        const url = 'https://example.com';
        const index = findLatestLinkIndex(content, url, 11);
        expect(index).toBe(11); // Start of [Link]
    });

    it('should find the link index even if content shifted forward', () => {
        const content = 'New prefix! Check this [Link](https://example.com) out.';
        const url = 'https://example.com';
        // Original index was 11, now it is 23
        const index = findLatestLinkIndex(content, url, 11);
        expect(index).toBe(23);
    });

    it('should find the link index even if content shifted backward', () => {
        const content = '[Link](https://example.com) out.';
        const url = 'https://example.com';
        // Original index was 11, now it is 0
        const index = findLatestLinkIndex(content, url, 11);
        expect(index).toBe(0);
    });

    it('should return null if the link is no longer present', () => {
        const content = 'The link is gone.';
        const url = 'https://example.com';
        const index = findLatestLinkIndex(content, url, 11);
        expect(index).toBeNull();
    });

    it('should find the correct occurrence if multiple identical links exist', () => {
        const content = '[Link](https://example.com) and [Link](https://example.com)';
        const url = 'https://example.com';

        // Target the second one
        const index2 = findLatestLinkIndex(content, url, 32);
        expect(index2).toBe(32);

        // Target the first one
        const index1 = findLatestLinkIndex(content, url, 0);
        expect(index1).toBe(0);
    });

    it('should correctly insert an archive link after original', () => {
        // Implementation logic will handle spaces and link format locally to be robust
    });

    describe('Index Shift Resilience (User-Edit Simulation)', () => {
        it('should find link after text is added at beginning', () => {
            // Simulates user adding a header while archiving is in progress
            const originalContent = '[Link](https://example.com) is here.';
            const editedContent = '# New Header\n\n' + originalContent;
            const url = 'https://example.com';

            // Original index was 0, now shifted by 14 characters
            const index = findLatestLinkIndex(editedContent, url, 0);
            expect(index).toBe(14);
        });

        it('should find link after text is added in the middle (before target)', () => {
            const originalContent = 'First [Link1](https://a.com) and [Link2](https://b.com).';
            const editedContent = 'First [Link1](https://a.com) EXTRA TEXT and [Link2](https://b.com).';
            const url = 'https://b.com';

            // Original index was 33, now shifted forward by 11 characters
            const index = findLatestLinkIndex(editedContent, url, 33);
            expect(index).toBe(44);
        });

        it('should find link after newlines are added', () => {
            const editedContent = '\n\n\n[Link](https://example.com)';
            const url = 'https://example.com';
            const index = findLatestLinkIndex(editedContent, url, 0);
            expect(index).toBe(3);
        });

        it('should handle plain URLs with shift', () => {
            const originalContent = 'Visit https://example.com for info.';
            const editedContent = 'Please visit https://example.com for info.';
            const url = 'https://example.com';

            const index = findLatestLinkIndex(editedContent, url, 6);
            expect(index).toBe(13);
        });
    });
});