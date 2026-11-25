import { describe, it, expect } from 'vitest';
import { extractSha, shortSha } from '../../src/utils/sha.js';
import { extractSha as reExported } from '../../src/services/promotion-service.js';

describe('extractSha', () => {
  it('is re-exported by promotion-service', () => {
    expect(reExported).toBe(extractSha);
  });

  it('takes the first mixed hex token, else the first all-digit one, never a word', () => {
    expect(extractSha("'9f1c2ab0 (story 5.26, epic/5)'")).toBe('9f1c2ab0');
    expect(extractSha('1234567 then 0a1b2c3d')).toBe('0a1b2c3d');
    expect(extractSha('1234567 and 12345678')).toBe('1234567');
    expect(extractSha('defaced decade')).toBeNull();
  });
});

describe('shortSha', () => {
  it('shortens a sha to 7 characters and returns null when none is found', () => {
    expect(shortSha('9f1c2ab0 (story 5.26)')).toBe('9f1c2ab');
    expect(shortSha('d33d8a3')).toBe('d33d8a3');
    expect(shortSha('working tree')).toBeNull();
  });
});
