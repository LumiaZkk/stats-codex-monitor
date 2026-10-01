import { App } from '@modelcontextprotocol/ext-apps';
import { installPanel } from './panel-view.mts';

const app = new App(
  { name: 'stats-tunnel-synthetic-panel', version: '1.0.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
  { autoResize: true, strict: true, allowUnsafeEval: false },
);
// Only same-server tools are called. No conversation-message or model-context API is used.
installPanel(app);
