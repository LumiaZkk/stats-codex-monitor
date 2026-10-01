import { assertCleanEnvironment } from './assert-clean-environment.mts';
await assertCleanEnvironment();
const {serve}=await import('../../tunnel/server.mts');
await serve(process.env.STATS_TUNNEL_RUN_DIR!);
