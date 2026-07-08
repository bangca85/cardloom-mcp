import { describe, it, expect } from 'vitest';
import { generateSlug } from '../../src/utils/slug-generator.js';
import { scanForSecrets } from '../../src/services/secret-scanner.js';
import { SecretDetectedError } from '../../src/types/errors.js';

describe('generateSlug', () => {
  it('converts title to kebab-case slug', () => {
    expect(generateSlug('Google OAuth Setup Guide')).toBe('google-oauth-setup-guide');
  });

  it('removes special characters', () => {
    expect(generateSlug('Hello World! @#$ Test')).toBe('hello-world-test');
  });

  it('collapses multiple hyphens', () => {
    expect(generateSlug('a   b---c')).toBe('a-b-c');
  });

  it('truncates to 100 chars', () => {
    const long = 'a'.repeat(150);
    expect(generateSlug(long).length).toBeLessThanOrEqual(100);
  });

  it('throws on titles that normalize to empty slug', () => {
    expect(() => generateSlug('!!!')).toThrow();
    expect(() => generateSlug('   ')).toThrow();
    expect(() => generateSlug('')).toThrow();
  });

  it('throws on titles with only special characters', () => {
    expect(() => generateSlug('@#$%^&*()')).toThrow();
    expect(() => generateSlug('---')).toThrow();
  });
});

describe('scanForSecrets', () => {
  it('throws on API key pattern', () => {
    expect(() => scanForSecrets('my key is sk-abc123defghijklmnop456')).toThrow(SecretDetectedError);
  });

  it('throws on AWS key pattern', () => {
    expect(() => scanForSecrets('AKIAIOSFODNN7EXAMPLE')).toThrow(SecretDetectedError);
  });

  it('throws on GitHub token', () => {
    expect(() => scanForSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij')).toThrow(SecretDetectedError);
  });

  it('throws on connection string', () => {
    expect(() => scanForSecrets('postgres://user:pass@localhost/db')).toThrow(SecretDetectedError);
  });

  it('does not throw on clean content', () => {
    expect(() => scanForSecrets('# How to setup OAuth\nUse Google Cloud Console...')).not.toThrow();
  });
});
