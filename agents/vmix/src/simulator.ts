import { createServer } from 'node:http';
import { once } from 'node:events';
import type { LoadedInput, TemplateMapping } from '../../../packages/content-core/src/live-production';

export const simulatorMapping: TemplateMapping = {
  schemaVersion: 1, sessionId: 'simulation-session', deviceId: 'simulation-device', version: 1, overlay: 1,
  state: 'commissioned', verifiedAtMs: 0,
  inputs: {
    headline: { key: 'simulation-headline', number: 1, title: 'synthetic-headline.gtzip' },
    name_title: { key: 'simulation-name-title', number: 2, title: 'synthetic-name-title.gtzip' },
  },
};

// Independently synthetic layered inputs exercise distinct text and overlay targets.
export const layeredSimulatorMapping: TemplateMapping = {
  ...simulatorMapping,
  inputs: {
    headline: { key: 'simulation-headline', number: 111, title: 'synthetic-headline.gtzip' },
    name_title: { key: 'simulation-name-title', number: 112, title: 'synthetic-name-title.gtzip' },
  },
  overlayInputs: {
    headline: { key: 'simulation-headline-overlay', number: 113, title: 'Synthetic headline overlay' },
    name_title: { key: 'simulation-name-title-overlay', number: 114, title: 'Synthetic name-title overlay' },
  },
};
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** HTTP boundary fake based on the vendor's /api XML example; synthetic data only. */
export async function createVmixSimulator(mapping = simulatorMapping) {
  const titles = Object.values(mapping.inputs) as LoadedInput[];
  const layers = Object.entries(mapping.overlayInputs ?? {}).filter(([template, input]) =>
    input.key !== mapping.inputs[template as keyof typeof mapping.inputs]!.key);
  const targets = [...titles, ...layers.map(([, input]) => input)];
  const texts: Record<string, Record<string, string>> = Object.fromEntries(Object.values(mapping.inputs).map(input =>
    [input!.key, { 'TextBlock1.Text': '', 'TextBlock2.Text': '' }]));
  const state = { overlay: '', otherOverlay: '', active: '3', composite: false, reachable: true, ignoreMutations: false, xmlAvailable: true };
  const calls: Record<string, string>[] = [];
  const xml = () => `<vmix><version>29.0.0.48</version><inputs>${Object.values(mapping.inputs).map(input =>
    `<input key="${escape(input!.key)}" number="${input!.number}" type="GT" title="${escape(input!.title)}">${Object.entries(texts[input!.key]).map(([name, value]) =>
      `<text name="${name}">${escape(value)}</text>`).join('')}</input>`).join('')}
    ${layers.length ? '<input key="simulation-banner" number="110" type="Video" title="Synthetic banner video"/>' : ''}
    ${layers.map(([template, input]) => `<input key="${escape(input.key)}" number="${input.number}" type="Virtual" title="${escape(input.title)}">
      <overlay key="simulation-banner" index="0"/><overlay key="${escape(mapping.inputs[template as keyof typeof mapping.inputs]!.key)}" index="2"/></input>`).join('')}
    <input key="simulation-camera" number="3" type="Capture" title="Camera">${state.composite ? `<overlay key="${mapping.inputs.headline!.key}" index="0"/>` : ''}</input>
    </inputs><overlays><overlay number="1">${escape(state.overlay)}</overlay><overlay number="2">${escape(state.otherOverlay)}</overlay>
    <overlay number="3"/><overlay number="4"/></overlays><active>${escape(state.active)}</active><preview>3</preview></vmix>`;
  const server = createServer((request, response) => {
    if (!state.reachable) { request.socket.destroy(); return; }
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (url.pathname !== '/api/') { response.writeHead(404).end(); return; }
    const params = Object.fromEntries(url.searchParams);
    if (!url.search) { response.setHeader('Content-Type', 'text/xml'); response.end(state.xmlAvailable ? xml() : '<vmix/>'); return; }
    const input = targets.find(input => input.key === params.Input);
    const valid = params.Function === 'OverlayInput1Out' || (input && (params.Function === 'OverlayInput1In' ||
      (params.Function === 'SetText' && texts[params.Input] && ['TextBlock1.Text', 'TextBlock2.Text'].includes(params.SelectedName) && 'Value' in params)));
    if (!valid) { response.writeHead(500).end(); return; }
    calls.push(params);
    if (!state.ignoreMutations) {
      if (params.Function === 'SetText') texts[params.Input][params.SelectedName] = params.Value;
      if (params.Function === 'OverlayInput1In') state.overlay = String(input!.number);
      if (params.Function === 'OverlayInput1Out') state.overlay = '';
    }
    response.end('Function completed successfully.');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { port, state, texts, calls, xml, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
