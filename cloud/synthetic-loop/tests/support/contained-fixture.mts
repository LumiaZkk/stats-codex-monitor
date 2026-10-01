import { assertCleanEnvironment } from './assert-clean-environment.mts';
await assertCleanEnvironment();
process.env.STATS_OFFICIAL_TUNNEL_PROBE='synthetic-only';
await import('./tunnel-fixture.mts');
