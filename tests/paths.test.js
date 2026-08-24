import { describe, it, expect } from 'vitest';

import { RENDITIONS, RENDITION_ORDER, nodeId, panoFilename, dataUrl } from '../src/lib/paths.js';

/**
 * The filename convention is the contract between the pipeline that writes
 * and the viewer that reads. If this drifts, everything 404s at once — so it
 * is pinned here even though it looks trivial.
 */
describe('paths', () => {
  it('zero-pads node ids', () => {
    expect(nodeId(1)).toBe('01');
    expect(nodeId(43)).toBe('43');
  });

  it('names renditions NN-rendition.jpg', () => {
    for (const rendition of RENDITION_ORDER) {
      expect(panoFilename(7, rendition)).toBe(`07-${rendition}.jpg`);
    }
  });

  it('keeps every rendition equirectangular (2:1)', () => {
    for (const spec of Object.values(RENDITIONS)) {
      expect(spec.width).toBe(spec.height * 2);
    }
  });

  it('builds data urls under the data base', () => {
    // BASE_URL differs between dev and a built bundle; the shape does not.
    expect(dataUrl('nodes')).toMatch(/data\/nodes\.json$/);
  });
});
