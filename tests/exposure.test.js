import test from 'node:test';
import assert from 'node:assert/strict';
import { exposureSupport, speedSteps, isoSteps, speedLabel, exposureReport } from '../public/exposure.js';
import { markClipping } from '../public/clipping.js';

test('manual exposure is offered only when the camera exposes it', () => {
  assert.deepEqual(exposureSupport({}), { manual: false, time: false, iso: false, compensation: false });
  assert.equal(exposureSupport({ exposureMode: ['continuous'], iso: { min: 50, max: 3200 } }).manual, false);
  const full = exposureSupport({ exposureMode: ['continuous', 'manual'], exposureTime: { min: 1, max: 5000 }, iso: { min: 50, max: 3200 }, exposureCompensation: { min: -2, max: 2, step: .5 } });
  assert.deepEqual(full, { manual: true, time: true, iso: true, compensation: true });
});

test('shutter speeds and ISO snap to photographic stops inside the camera range', () => {
  assert.deepEqual(speedSteps({ min: 10, max: 400 }).map(speedLabel), ['1/1000 s', '1/500 s', '1/250 s', '1/125 s', '1/60 s', '1/30 s', '1/25 s']);
  assert.deepEqual(isoSteps({ min: 64, max: 1000 }), [64, 100, 200, 400, 800, 1000]);
  assert.equal(speedLabel(20000), '2 s');
});

test('clipping marks only pure white red and pure black blue', () => {
  const source = new Uint8ClampedArray([255,255,255,255, 0,0,0,255, 250,250,250,255, 2,2,2,255]), target = new Uint8ClampedArray(16);
  markClipping(source, target);
  assert.deepEqual([...target.slice(0, 4)], [255, 32, 32, 255]);
  assert.deepEqual([...target.slice(4, 8)], [40, 110, 255, 255]);
  assert.equal(target[11], 0); assert.equal(target[15], 0);
});

test('exposureReport summarises what the camera reported', () => {
  assert.equal(exposureReport({ getCapabilities: () => ({}) }), 'modos no, tiempo no, ISO no, compensación no.');
  assert.equal(exposureReport({ getCapabilities: () => ({ exposureMode: ['continuous'], exposureCompensation: { min: -2, max: 2 } }) }), 'modos continuous, tiempo no, ISO no, compensación -2–2.');
  assert.equal(exposureReport({}), 'el navegador no da información de la cámara.');
});
