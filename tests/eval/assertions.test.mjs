import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluate} from '../../evals/assert.mjs';
import {observe as good} from '../../references/good.mjs';
import {observe as broken} from '../../references/broken.mjs';

const workload = JSON.parse(readFileSync(new URL('../../fixtures/workload.json', import.meta.url), 'utf8'));
const requirements = () => ({maxRequestsPerSecond: 50, cacheTtlMs: 30000, forbiddenLogFragments: ['clinicalPayload', 'diagnosis', 'glucose']});
const call = (customerCode, atMs) => ({customerCode, atMs});
const observation = (overrides = {}) => ({
  requests: [call('CUS-A', 0)],
  upstreamCalls: [call('CUS-A', 0)],
  responses: [{customerCode: 'CUS-A', status: 'pending'}],
  logs: ['request batch completed'],
  requirements: requirements(),
  ...overrides,
});
const failsWith = (result, id) => {
  assert.equal(result.pass, false);
  assert.ok(result.violations.some(v => v.startsWith(id)), `expected a ${id} violation, got ${JSON.stringify(result.violations)}`);
};

test('result has exactly pass and violations', () => {
  for (const result of [evaluate(good(workload)), evaluate(broken(workload))]) {
    assert.deepEqual(Object.keys(result).sort(), ['pass', 'violations']);
    assert.equal(typeof result.pass, 'boolean');
    assert.ok(result.violations.every(v => typeof v === 'string' && v !== ''));
    assert.equal(result.pass, result.violations.length === 0);
  }
});

// Valid behaviour and valid refactors
test('good reference passes on the workload', () => {
  assert.deepEqual(evaluate(good(workload)), {pass: true, violations: []});
});

test('valid refactor: different harmless log text passes', () => {
  const run = good(workload);
  run.logs = ['all requests completed successfully with version 2', 'cache hit ratio 59/60'];
  assert.deepEqual(evaluate(run), {pass: true, violations: []});
});

test('valid refactor: other customer codes, unordered upstream calls and extra response fields pass', () => {
  const run = observation({
    requests: [call('ACME-9', 0), call('ZED-1', 5), call('ACME-9', 10)],
    upstreamCalls: [call('ZED-1', 5), call('ACME-9', 0)],
    responses: [{customerCode: 'ACME-9', status: 'ok', cached: false}, {customerCode: 'ZED-1', status: 'ok'}, {customerCode: 'ACME-9', status: 'ok', cached: true}],
  });
  assert.equal(evaluate(run).pass, true);
});

test('CACHE-1 boundary: a refresh exactly cacheTtlMs later passes', () => {
  const run = observation({requests: [call('CUS-A', 0), call('CUS-A', 30000)], upstreamCalls: [call('CUS-A', 0), call('CUS-A', 30000)]});
  assert.equal(evaluate(run).pass, true);
});

test('CACHE-1 is per customer: different customers may call at the same time', () => {
  const calls = Array.from({length: 50}, (_, i) => call(`CUS-${i}`, 0));
  assert.equal(evaluate(observation({requests: calls, upstreamCalls: calls})).pass, true);
});

test('RATE-1 counts upstream calls, not requests', () => {
  const requests = Array.from({length: 200}, (_, i) => call('CUS-A', i));
  assert.equal(evaluate(observation({requests, upstreamCalls: [call('CUS-A', 0)]})).pass, true);
});

test('RATE-1 boundary: 50 calls in one second pass', () => {
  const calls = Array.from({length: 50}, (_, i) => call(`CUS-${i}`, i * 10));
  assert.equal(evaluate(observation({requests: calls, upstreamCalls: calls})).pass, true);
});

test('RATE-1 window is rolling: 50 calls per second, sustained, passes', () => {
  const calls = Array.from({length: 150}, (_, i) => call(`CUS-${i}`, i * 20));
  assert.equal(evaluate(observation({requests: calls, upstreamCalls: calls})).pass, true);
});

// Failure variants
test('missing cache: broken reference fails', () => {
  const result = evaluate(broken(workload));
  failsWith(result, 'CACHE-1');
  failsWith(result, 'RATE-1');
});

test('missing cache: a second call for one customer within the TTL fails', () => {
  const run = observation({requests: [call('CUS-A', 0), call('CUS-A', 29999)], upstreamCalls: [call('CUS-A', 0), call('CUS-A', 29999)]});
  failsWith(evaluate(run), 'CACHE-1');
});

test('rate-limit breach: 51 distinct-customer calls within one second fail', () => {
  const calls = Array.from({length: 51}, (_, i) => call(`CUS-${i}`, i * 19));
  const result = evaluate(observation({requests: calls, upstreamCalls: calls}));
  failsWith(result, 'RATE-1');
  assert.ok(!result.violations.some(v => v.startsWith('CACHE-1')));
});

test('rate-limit breach: burst in the middle of a quiet run is caught by the rolling window', () => {
  const calls = [...Array.from({length: 30}, (_, i) => call(`A-${i}`, 600 + i)), ...Array.from({length: 30}, (_, i) => call(`B-${i}`, 1100 + i))];
  failsWith(evaluate(observation({requests: calls, upstreamCalls: calls})), 'RATE-1');
});

test('payload logging: each forbidden fragment inside a log line fails', () => {
  for (const line of ['status for CUS-A clinicalPayload={...}', 'customer diagnosis: E11', 'upstream body glucose=7.2']) {
    const run = good(workload);
    run.logs = ['request batch completed', line];
    failsWith(evaluate(run), 'PRIVACY-1');
  }
});

test('payload logging: fragment match ignores case', () => {
  failsWith(evaluate(observation({logs: ['Diagnosis attached']})), 'PRIVACY-1');
});

// Malformed or insufficient evidence
test('empty, malformed or requirement-less observations fail with a violation', () => {
  const {requirements: _, ...noRequirements} = observation();
  const cases = [undefined, null, {}, [], 'observation', noRequirements,
    observation({requests: []}),
    observation({upstreamCalls: 'none'}),
    observation({logs: [42]}),
    observation({upstreamCalls: [{customerCode: 'CUS-A'}]}),
    observation({requirements: {...requirements(), forbiddenLogFragments: []}})];
  for (const input of cases) {
    const result = evaluate(input);
    assert.equal(result.pass, false, JSON.stringify(input));
    assert.ok(result.violations.length > 0 && result.violations.every(v => v !== ''));
  }
});

test('evaluate does not change the observation', () => {
  const run = observation({upstreamCalls: [call('B', 50000), call('A', 0)]});
  const before = JSON.stringify(run);
  evaluate(run);
  assert.equal(JSON.stringify(run), before);
});
