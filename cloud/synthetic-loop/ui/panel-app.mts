import { App } from '@modelcontextprotocol/ext-apps';
import { installDiagnosticPanel } from './real-panel-view.mts';

const app = new App(
  { name: 'stats-global-diagnostic-panel', version: '2.0.0' },
  { availableDisplayModes: ['inline', 'fullscreen'] },
  { autoResize: true, strict: true, allowUnsafeEval: false },
);
// Only same-server tools are called. No conversation-message or model-context API is used.
installDiagnosticPanel(app);
