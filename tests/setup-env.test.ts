import { describe, expect, it } from 'vitest';

describe('vitest setup (tests/setup-env.ts)', () => {
  it('clears the telemetry switches even when the runner was started with them set', () => {
    expect(process.env['CARDLOOM_TELEMETRY']).toBeUndefined();
    expect(process.env['CARDLOOM_TELEMETRY_SAMPLES']).toBeUndefined();
    expect(process.env['CARDLOOM_TELEMETRY_PATH']).toBeUndefined();
  });
});
