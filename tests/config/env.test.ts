import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../../src/config/env.js';

describe('config graph env getters', () => {
  afterEach(() => {
    delete process.env['GRAPH_GENERIC_STACK_TAGS'];
    delete process.env['MAX_SHARED_STACK_GROUP_SIZE'];
    delete process.env['MAX_SHARED_STACK_EDGES'];
  });

  describe('graphGenericStackTags', () => {
    it('defaults to an empty array when unset', () => {
      expect(config.graphGenericStackTags).toEqual([]);
    });

    it('parses a comma-separated list, trimmed and lowercased', () => {
      process.env['GRAPH_GENERIC_STACK_TAGS'] = ' TypeScript, javascript ,, node ';
      expect(config.graphGenericStackTags).toEqual(['typescript', 'javascript', 'node']);
    });
  });

  describe('maxSharedStackGroupSize', () => {
    it('defaults to 50 when unset', () => {
      expect(config.maxSharedStackGroupSize).toBe(50);
    });

    it('accepts a valid positive integer', () => {
      process.env['MAX_SHARED_STACK_GROUP_SIZE'] = '10';
      expect(config.maxSharedStackGroupSize).toBe(10);
    });

    it.each(['Infinity', '-5', '0', '3.5', 'not-a-number'])(
      'falls back to default for invalid value %s',
      (invalid) => {
        process.env['MAX_SHARED_STACK_GROUP_SIZE'] = invalid;
        expect(config.maxSharedStackGroupSize).toBe(50);
      }
    );
  });

  describe('maxSharedStackEdges', () => {
    it('defaults to 5000 when unset', () => {
      expect(config.maxSharedStackEdges).toBe(5000);
    });

    it('accepts a valid positive integer', () => {
      process.env['MAX_SHARED_STACK_EDGES'] = '100';
      expect(config.maxSharedStackEdges).toBe(100);
    });

    it.each(['Infinity', '-1', '0', '2.2', 'nope'])(
      'falls back to default for invalid value %s',
      (invalid) => {
        process.env['MAX_SHARED_STACK_EDGES'] = invalid;
        expect(config.maxSharedStackEdges).toBe(5000);
      }
    );
  });
});
