import { PANEL_HTML, PANEL_URI } from './panel-bundle.mts';
export { PANEL_SCRIPT, PANEL_BUILD_HASH, PANEL_HTML, PANEL_CONTENT_HASH, PANEL_URI } from './panel-bundle.mts';
export const panelResource = () => ({
  uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: PANEL_HTML,
  _meta: {
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] },
    ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
  },
});
