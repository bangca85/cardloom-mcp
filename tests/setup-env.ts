// Runs before every test file (vitest `setupFiles`): a maintainer who exports the telemetry switches in their
// shell must not have `npm test` append to their real telemetry file. Tests that need them set them explicitly.
delete process.env['CARDLOOM_TELEMETRY'];
delete process.env['CARDLOOM_TELEMETRY_SAMPLES'];
delete process.env['CARDLOOM_TELEMETRY_PATH'];
