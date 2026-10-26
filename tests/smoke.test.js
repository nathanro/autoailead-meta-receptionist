import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SpendGuardrails,
  computeTokenCostUSD,
  computeAudioCostUSD,
  computeSamCostUSD,
  computeImageCostUSD,
} from '../src/guardrails.js';
import { parseSamSegmentationText, MetaPipelineClient } from '../src/metaClient.js';

test('Meta Model API pricing calculations match official docs', () => {
  // muse-spark-1.3: $1.25/1M input, $0.15/1M cached input, $4.25/1M output
  const sparkCost = computeTokenCostUSD('muse-spark-1.3', {
    input_tokens: 2000,
    input_tokens_details: { cached_tokens: 1000 },
    output_tokens: 1000,
  });
  // 1000 uncached ($0.00125) + 1000 cached ($0.00015) + 1000 output ($0.00425) = $0.00565
  assert.equal(sparkCost, 0.00565);

  // muse-voice-transcribe-1.0: $0.18/hour = $0.00005/sec, rounded down to whole seconds
  const audioCost = computeAudioCostUSD(30_400); // 30 seconds -> 30 * 0.00005 = 0.0015
  assert.equal(audioCost, 0.0015);

  // sam-3.1: $2.50 / 1,000 images = $0.0025 per image; video min 50 frames at $0.20 / 1,000 frames = $0.01
  assert.equal(computeSamCostUSD({ images: 1 }), 0.0025);
  assert.equal(computeSamCostUSD({ videoFrames: 12 }), 0.01);

  // muse-image-1.0: $0.01 per image
  assert.equal(computeImageCostUSD(1), 0.01);
});

test('SAM 3.1 special-token wire parser extracts boxes and masks accurately', () => {
  const wire =
    '<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561;c=0.95|><|mask;x=0;y=0;c=0.95;data=46,101,!payload|>';
  const parsed = parseSamSegmentationText(wire);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].frameIndex, 0);
  assert.equal(parsed[0].objectId, 0);
  assert.equal(parsed[0].box.x1, 353);
  assert.equal(parsed[0].box.width, 537);
  assert.equal(parsed[0].mask.rows, 46);
  assert.equal(parsed[0].mask.cols, 101);
  assert.equal(parsed[0].mask.encoding, 'one_bit');
});

test('SpendGuardrails enforces hard budget caps and caches repeat calls at $0', async () => {
  const g = new SpendGuardrails({
    maxTotalSpendUSD: 0.05,
    maxSessionSpendUSD: 0.02,
    maxCallsPerSession: 2,
  });
  const sId = 'test-session-' + Date.now();
  g.recordLiveCall({
    cacheKey: 'k1',
    endpoint: '/v1/images/generations',
    model: 'muse-image-1.0',
    costUSD: 0.01,
    value: { ok: true },
    sessionId: sId,
  });
  // Cache hit costs $0
  const hit = g.getCached('k1', sId);
  assert.deepEqual(hit, { ok: true });

  // Exceeding session spend cap is blocked
  const check = g.canSpend(0.015, sId);
  assert.equal(check.allowed, false);
  assert.match(check.reason, /session_budget_cap_reached/);

  // Pipeline client falls back cleanly with zero errors when no API key is set
  const client = new MetaPipelineClient(g);
  const res = await client.qualifyAndBookLead({
    businessId: 'smile-dental-miami',
    lang: 'es',
    sessionId: sId,
  });
  assert.equal(res.qualification.detected_language, 'es');
  assert.equal(res.costUSD, 0);
});
