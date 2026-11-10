import { readBody, requestSignal } from './http';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { LIVE_TEMPLATES, mappedOverlayInput, type BannerText, type LoadedInput, type TemplateMapping } from '../../../packages/content-core/src/live-production';

const parser = new XMLParser({
  ignoreAttributes: false, parseTagValue: false, trimValues: false,
  alwaysCreateTextNode: true, isArray: name => ['input', 'text', 'overlay', 'mix'].includes(name),
});
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const scalar = (value: any): string => String(value?.['#text'] ?? '');

export class NativeStateError extends Error {}

export type VisibilityReason = 'composite' | 'other_overlay' | 'direct_output' | 'additional_mix';
export type NativeState = {
  inputKey: string | null; text: BannerText | null; safe: boolean; visibilityReasons: VisibilityReason[];
  titles: Record<'headline' | 'name_title', BannerText>;
  inputTypes: Record<'headline' | 'name_title', 'GT'>;
};

/** Reject unsupported visibility rather than claim arbitrary vMix presets are safe. */
export function readState(xml: string, mapping: TemplateMapping): NativeState {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid vMix XML');
  const vmix = parser.parse(xml).vmix;
  if (!vmix || !vmix.inputs || !vmix.overlays) throw new Error('Incomplete vMix XML');
  const inputs = array(vmix.inputs.input);
  const overlays = array(vmix.overlays.overlay);
  const routes = (['headline', 'name_title'] as const).map(template => {
    const text = mapping.inputs[template];
    const overlay = mappedOverlayInput(mapping, template);
    if (!text || !overlay) throw new Error('Mapping is not commissioned');
    return { template, text, overlay };
  });
  const nativeInput = (expected: LoadedInput) => {
    const found = inputs.filter(input => input['@_key'] === expected.key);
    if (found.length !== 1 || found[0]['@_number'] !== String(expected.number) || found[0]['@_title'] !== expected.title) {
      throw new Error('Loaded input differs from commissioned mapping');
    }
    return found[0];
  };
  const inputTypes = {} as NativeState['inputTypes'];
  for (const { template, text: expected, overlay } of routes) {
    const input = nativeInput(expected);
    const target = nativeInput(overlay);
    if (overlay.key !== expected.key && array(target.overlay).filter(layer => layer['@_key'] === expected.key).length !== 1) {
      throw new Error('Named overlay must contain exactly one text layer');
    }
    const nativeType = input['@_type'];
    if (nativeType !== 'GT') throw new Error('Mapped input is not a GT title');
    inputTypes[template] = nativeType;
    const fields = array(input.text);
    for (const field of Object.values(LIVE_TEMPLATES[template].fields)) {
      if (fields.filter(text => text['@_name'] === field).length !== 1) throw new Error('Missing or duplicate title field');
    }
  }
  const targets = routes.map(route => route.overlay);
  const managed = [...routes.map(route => route.text), ...targets];
  const references = managed.flatMap(input => [input.key, String(input.number)]);
  if (new Set(inputs.map(input => input['@_key'])).size !== inputs.length ||
      new Set(inputs.map(input => input['@_number'])).size !== inputs.length) throw new Error('Duplicate native input');
  const channel = overlays.filter(overlay => overlay['@_number'] === '1');
  if (channel.length !== 1 || !['1', '2', '3', '4'].every(number =>
    overlays.filter(overlay => overlay['@_number'] === number).length === 1)) throw new Error('Incomplete overlay state');
  const active = scalar(vmix.active);
  if (!/^\d+$/.test(active)) throw new Error('Missing active input');
  // Only the explicitly named overlay -> text edge is commissioned. Never infer nested routes.
  const allowedLayers = new Map(routes.filter(route => route.text.key !== route.overlay.key)
    .map(route => [route.overlay.key, route.text.key]));
  const composite = inputs.some(input => array(input.overlay).some(layer =>
    references.includes(layer['@_key']) && allowedLayers.get(input['@_key']) !== layer['@_key']));
  const otherOverlay = overlays.some(overlay => references.includes(scalar(overlay)) &&
    (overlay['@_number'] !== '1' || !targets.some(target => [target.key, String(target.number)].includes(scalar(overlay)))));
  const visibilityReasons: VisibilityReason[] = [];
  if (composite) visibilityReasons.push('composite');
  if (otherOverlay) visibilityReasons.push('other_overlay');
  if (references.includes(active)) visibilityReasons.push('direct_output');
  if (vmix.mixes || vmix.mix) visibilityReasons.push('additional_mix');
  const safe = visibilityReasons.length === 0;
  const field = (template: 'headline' | 'name_title', name: string) => {
    const input = inputs.find(input => input['@_key'] === mapping.inputs[template]!.key);
    return scalar(array(input.text).find(text => text['@_name'] === name));
  };
  const titles: NativeState['titles'] = {
    headline: { templateId: 'headline', headline: field('headline', 'TextBlock1.Text') },
    name_title: { templateId: 'name_title', name: field('name_title', 'TextBlock1.Text'), title: field('name_title', 'TextBlock2.Text') },
  };
  const visible = scalar(channel[0]);
  if (!visible) return { inputKey: null, text: null, safe, visibilityReasons, titles, inputTypes };
  const input = inputs.find(input => input['@_number'] === visible || input['@_key'] === visible);
  if (!input) throw new Error('Unknown overlay input');
  const template = routes.find(route => route.overlay.key === input['@_key'])?.template;
  const text = template ? titles[template] : null;
  return { inputKey: input['@_key'], text, safe, visibilityReasons, titles, inputTypes };
}

export class VmixClient {
  private endpoint: URL;
  constructor(port: number, private timeoutMs = 1500, private credentials?: { username: string; password: string }, private stop?: AbortSignal) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid vMix port');
    this.endpoint = new URL(`http://127.0.0.1:${port}/api/`);
  }
  private async request(params?: Record<string, string>): Promise<string> {
    const url = new URL(this.endpoint);
    if (params) url.search = new URLSearchParams(params).toString();
    // Credentials are only in memory; URLs and errors are never logged.
    const response = await fetch(url, { redirect: 'error', signal: requestSignal(this.timeoutMs, this.stop),
      headers: this.credentials ? { Authorization: `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}` } : {},
    });
    if (!response.ok) throw new Error('vMix request failed');
    return readBody(response, 2_000_000);
  }
  async read(mapping: TemplateMapping) {
    const xml = await this.request();
    try { return readState(xml, mapping); } catch { throw new NativeStateError('Native state is unknown'); }
  }
  async field(input: string, name: string, value: string): Promise<void> {
    if (!['TextBlock1.Text', 'TextBlock2.Text'].includes(name)) throw new Error('Unmapped text field');
    await this.request({ Function: 'SetText', Input: input, SelectedName: name, Value: value });
  }
  async take(input: string) { await this.request({ Function: 'OverlayInput1In', Input: input }); }
  async clear() { await this.request({ Function: 'OverlayInput1Out' }); }
}
