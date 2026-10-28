// Policy check for one recorded run of the live-status service.
// Reads the observation only; every array it orders is a copy.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCall = value => isObject(value) && typeof value.customerCode === 'string' && value.customerCode !== '' && Number.isFinite(value.atMs);

// EVIDENCE: returns problems that make the observation unusable as evidence.
function checkShape(observation) {
  if (!isObject(observation)) return ['EVIDENCE: observation must be an object'];
  const problems = [];
  for (const field of ['requests', 'upstreamCalls', 'responses', 'logs']) {
    if (!Array.isArray(observation[field])) problems.push(`EVIDENCE: ${field} must be an array`);
  }
  const req = observation.requirements;
  if (!isObject(req)) {
    problems.push('EVIDENCE: requirements are missing');
  } else {
    if (!Number.isFinite(req.maxRequestsPerSecond) || req.maxRequestsPerSecond < 0) problems.push('EVIDENCE: requirements.maxRequestsPerSecond must be a non-negative number');
    if (!Number.isFinite(req.cacheTtlMs) || req.cacheTtlMs < 0) problems.push('EVIDENCE: requirements.cacheTtlMs must be a non-negative number');
    if (!Array.isArray(req.forbiddenLogFragments) || req.forbiddenLogFragments.length === 0 || !req.forbiddenLogFragments.every(f => typeof f === 'string' && f !== '')) {
      problems.push('EVIDENCE: requirements.forbiddenLogFragments must be a non-empty list of non-empty strings');
    }
  }
  if (problems.length) return problems;
  if (observation.requests.length === 0) problems.push('EVIDENCE: no requests were recorded');
  if (!observation.requests.every(isCall)) problems.push('EVIDENCE: every request needs a customerCode and a numeric atMs');
  if (!observation.upstreamCalls.every(isCall)) problems.push('EVIDENCE: every upstream call needs a customerCode and a numeric atMs');
  if (!observation.logs.every(line => typeof line === 'string')) problems.push('EVIDENCE: every log entry must be a string');
  return problems;
}

// CACHE-1: per customer, consecutive upstream calls are at least cacheTtlMs apart.
function checkCache(calls, ttlMs) {
  const timesByCustomer = new Map();
  for (const call of calls) {
    if (!timesByCustomer.has(call.customerCode)) timesByCustomer.set(call.customerCode, []);
    timesByCustomer.get(call.customerCode).push(call.atMs);
  }
  const violations = [];
  for (const [customer, times] of timesByCustomer) {
    times.sort((a, b) => a - b);
    let repeats = 0, first = -1;
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < ttlMs) {
        repeats++;
        if (first < 0) first = i;
      }
    }
    if (repeats) {
      violations.push(`CACHE-1: ${repeats} upstream call(s) for ${customer} came less than ${ttlMs} ms after the previous one (first at ${times[first]} ms, previous at ${times[first - 1]} ms)`);
    }
  }
  return violations;
}

// RATE-1: no rolling window [t, t + 1000 ms) holds more than maxPerSecond upstream calls.
function checkRate(calls, maxPerSecond) {
  const times = calls.map(call => call.atMs).sort((a, b) => a - b);
  let busiest = 0, busiestStart = 0;
  for (let start = 0, end = 0; start < times.length; start++) {
    while (end < times.length && times[end] - times[start] < 1000) end++;
    if (end - start > busiest) {
      busiest = end - start;
      busiestStart = times[start];
    }
  }
  if (busiest > maxPerSecond) {
    return [`RATE-1: ${busiest} upstream calls in the one-second window starting at ${busiestStart} ms (limit ${maxPerSecond})`];
  }
  return [];
}

// PRIVACY-1: no log line contains a forbidden fragment (case-insensitive).
function checkLogs(logs, fragments) {
  const violations = [];
  logs.forEach((line, index) => {
    const lower = line.toLowerCase();
    const found = fragments.filter(fragment => lower.includes(fragment.toLowerCase()));
    if (found.length) violations.push(`PRIVACY-1: log line ${index} contains forbidden fragment(s): ${found.join(', ')}`);
  });
  return violations;
}

export function evaluate(observation) {
  const problems = checkShape(observation);
  if (problems.length) return {pass: false, violations: problems};
  const {upstreamCalls, logs, requirements} = observation;
  const violations = [
    ...checkCache(upstreamCalls, requirements.cacheTtlMs),
    ...checkRate(upstreamCalls, requirements.maxRequestsPerSecond),
    ...checkLogs(logs, requirements.forbiddenLogFragments),
  ];
  return {pass: violations.length === 0, violations};
}
