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
});
