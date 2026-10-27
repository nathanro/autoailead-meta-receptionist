import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeTokenCostUSD,
  computeAudioCostUSD,
  computeSamCostUSD,
  computeImageCostUSD,
  hashRequestKey,
} from './guardrails.js';
import { DEMO_BUSINESSES, FALLBACK_SAM_OUTPUT } from './fallbackData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const GENERATED_DIR = path.join(PUBLIC_DIR, 'generated');
const AUDIO_DIR = path.join(PUBLIC_DIR, 'audio');

const DEFAULT_BASE_URL = 'https://api.meta.ai/v1';

export function getMetaApiKey() {
  return (process.env.META_API_KEY || process.env.MODEL_API_KEY || '').trim();
}

export function getMetaBaseUrl() {
  return (process.env.META_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Parses SAM 3.1 special-token output grammar:
 * <0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>
 */
export function parseSamSegmentationText(rawText = '') {
  const objects = [];
  const lines = String(rawText)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const frameMatch = line.match(/^<(\d+)f>(.*)$/);
    const frameIndex = frameMatch ? Number(frameMatch[1]) : 0;
    const body = frameMatch ? frameMatch[2] : line;

    const recordRegex = /(\d+)<\|box;([^|]+)\|><\|mask;([^|]+)\|>/g;
    let match;
    while ((match = recordRegex.exec(body)) !== null) {
      const objectId = Number(match[1]);
      const boxFields = Object.fromEntries(
        match[2].split(';').map((kv) => {
          const [k, v] = kv.split('=');
          return [k, Number(v)];
        })
      );
      const maskParts = match[3].split(';');
      let maskRows = 0;
      let maskCols = 0;
      let encoding = 'lossless';
      for (const part of maskParts) {
        if (part.startsWith('data=')) {
          const rawData = part.slice(5);
          const m = rawData.match(/^(\d+),(\d+),([~!])/);
          if (m) {
            maskRows = Number(m[1]);
            maskCols = Number(m[2]);
            encoding = m[3] === '!' ? 'one_bit' : 'lossless';
          }
        }
      }
      objects.push({
        frameIndex,
        objectId,
        box: {
          x1: boxFields.x1 ?? 0,
          y1: boxFields.y1 ?? 0,
          x2: boxFields.x2 ?? 0,
          y2: boxFields.y2 ?? 0,
          width: boxFields.w ?? 0,
          height: boxFields.h ?? 0,
          confidence: boxFields.c ?? null,
        },
        mask: {
          rows: maskRows,
          cols: maskCols,
          encoding,
        },
      });
    }
  }
  return objects;
}

export const LEAD_QUALIFICATION_JSON_SCHEMA = {
  name: 'LeadQualification',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      caller_name: { type: 'string' },
      detected_language: { type: 'string', enum: ['en', 'es'] },
      urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
      service_requested: { type: 'string' },
      preferred_slot: { type: 'string' },
      estimated_value_usd: { type: 'number' },
      receptionist_reply: { type: 'string' },
      owner_whatsapp_summary: { type: 'string' },
    },
    required: [
      'caller_name',
      'detected_language',
      'urgency',
      'service_requested',
      'preferred_slot',
      'estimated_value_usd',
      'receptionist_reply',
      'owner_whatsapp_summary',
    ],
    additionalProperties: false,
  },
};

export const RECEPTIONIST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'check_calendar_slots',
      description: 'Check open appointment slots for the local business.',
      parameters: {
        type: 'object',
        properties: {
          business_id: { type: 'string' },
          urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['business_id', 'urgency'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Reserve a slot in the AutoAI Lead CRM and notify the business owner.',
      parameters: {
        type: 'object',
        properties: {
          business_id: { type: 'string' },
          caller_name: { type: 'string' },
          slot: { type: 'string' },
          service: { type: 'string' },
        },
        required: ['business_id', 'caller_name', 'slot', 'service'],
        additionalProperties: false,
      },
    },
  },
];

export function executeLocalToolCall(name, args = {}) {
  if (name === 'check_calendar_slots') {
    return {
      business_id: args.business_id,
      available_slots:
        args.urgency === 'high'
          ? ['Today 02:00 PM', 'Today 04:30 PM', 'Tomorrow 09:30 AM']
          : ['Tomorrow 08:30 AM', 'Tomorrow 11:00 AM', 'Thursday 03:00 PM'],
    };
  }
  if (name === 'book_appointment') {
    return {
      status: 'confirmed',
      booking_id: `bk_${Math.random().toString(36).slice(2, 8)}`,
      slot: args.slot,
      crm_synced: true,
      whatsapp_alert_queued: true,
    };
  }
  return { status: 'ok' };
}

export class MetaPipelineClient {
  constructor(guardrails) {
    this.guardrails = guardrails;
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
  }

  /**
   * 1. Speech-to-Text via Muse Voice Transcribe (muse-voice-transcribe-1.0)
   * Endpoint: POST https://api.meta.ai/v1/asr/transcribe
   */
  async transcribeAudio({
    wavBuffer = null,
    businessId = 'smile-dental-miami',
    lang = 'en',
    sessionId = 'default',
  }) {
    const model = 'muse-voice-transcribe-1.0';
    const endpoint = '/v1/asr/transcribe';
    const business = DEMO_BUSINESSES[businessId] || DEMO_BUSINESSES['smile-dental-miami'];
    const preset = business.presets[lang] || business.presets.en;

    let effectiveWav = wavBuffer;
    const defaultWavPath = path.join(AUDIO_DIR, `${businessId}-${lang}.wav`);
    if (!effectiveWav && fs.existsSync(defaultWavPath)) {
      effectiveWav = fs.readFileSync(defaultWavPath);
    }

    const cacheKey = hashRequestKey({
      endpoint,
      model,
      businessId,
      lang,
      audioHash: effectiveWav ? hashRequestKey(effectiveWav.toString('base64')) : 'preset',
    });

    const cached = this.guardrails.getCached(cacheKey, sessionId, { endpoint, model });
    if (cached) {
      return { ...cached, cached: true, fallback: false, costUSD: 0 };
    }

    const apiKey = getMetaApiKey();
    const budgetCheck = this.guardrails.canSpend(0.003, sessionId);

    if (!apiKey || !effectiveWav || !budgetCheck.allowed) {
      return {
        model,
        endpoint,
        transcript: preset.transcript,
        audioDurationMs: 9200,
        latencyMs: 0,
        audioUrl: `/audio/${businessId}-${lang}.wav`,
        turns: [{ turnId: 0, startMs: 0, endMs: 9100, transcript: preset.transcript }],
        cached: false,
        fallback: true,
        fallbackReason: !apiKey
          ? 'no_api_key_configured'
          : !effectiveWav
          ? 'using_demo_audio_preset'
          : budgetCheck.reason,
        costUSD: 0,
      };
    }

    try {
      const t0 = Date.now();
      const form = new FormData();
      const requestPayload = {
        mode: 'ENDPOINTING',
        model,
        audioEncoding: 'WAV',
        languageBias: ['English', 'Spanish'],
        keywords: [
          business.name,
          'Brickell',
          'Miami',
          'AutoAI Lead',
          'crown',
          'muela',
          'emergency',
        ],
      };
      form.append(
        'request',
        new Blob([JSON.stringify(requestPayload)], { type: 'application/json' })
      );
      form.append('audio', new Blob([effectiveWav], { type: 'audio/wav' }), `${businessId}-${lang}.wav`);

      const res = await fetch(
        `${getMetaBaseUrl().replace(/\/v1$/, '')}${endpoint}?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        }
      );

      if (!res.ok) {
        throw new Error(`Meta ASR HTTP ${res.status}`);
      }
      const data = await res.json();
      const latencyMs = Date.now() - t0;
      const costUSD = computeAudioCostUSD(data.audioDurationMs || 9000);
      const result = {
        model,
        endpoint,
        transcript: data.transcript || preset.transcript,
        audioDurationMs: data.audioDurationMs || 9000,
        latencyMs,
        audioUrl: `/audio/${businessId}-${lang}.wav`,
        turns: data.turns || [],
      };
      this.guardrails.recordLiveCall({
        cacheKey,
        endpoint,
        model,
        costUSD,
        value: result,
        sessionId,
      });
      return { ...result, cached: false, fallback: false, costUSD };
    } catch (err) {
      return {
        model,
        endpoint,
        transcript: preset.transcript,
        audioDurationMs: 9200,
        latencyMs: 0,
        audioUrl: `/audio/${businessId}-${lang}.wav`,
        turns: [{ turnId: 0, startMs: 0, endMs: 9100, transcript: preset.transcript }],
        cached: false,
        fallback: true,
        fallbackReason: 'preset_fallback_active',
        costUSD: 0,
      };
    }
  }

  /**
   * 2. Agentic Lead Qualification + Tool Calling + Structured Output via Muse Spark 1.3
   * Endpoint: POST https://api.meta.ai/v1/chat/completions
   */
  async qualifyAndBookLead({
    transcript,
    businessId = 'smile-dental-miami',
    lang = 'en',
    sessionId = 'default',
  }) {
    const model = process.env.META_TEXT_MODEL || 'muse-spark-1.3';
    const endpoint = '/v1/chat/completions';
    const business = DEMO_BUSINESSES[businessId] || DEMO_BUSINESSES['smile-dental-miami'];
    const preset = business.presets[lang] || business.presets.en;
    const cleanTranscript = (transcript || preset.transcript).trim();

    const cacheKey = hashRequestKey({
      endpoint,
      model,
      businessId,
      transcript: cleanTranscript,
    });

    const cached = this.guardrails.getCached(cacheKey, sessionId, { endpoint, model });
    if (cached) {
      return { ...cached, cached: true, fallback: false, costUSD: 0 };
    }

    const apiKey = getMetaApiKey();
    const budgetCheck = this.guardrails.canSpend(0.005, sessionId);

    if (!apiKey || !budgetCheck.allowed) {
      const toolTrace = [
        {
          tool: 'check_calendar_slots',
          output: executeLocalToolCall('check_calendar_slots', {
            business_id: business.id,
            urgency: preset.qualification.urgency,
          }),
        },
        {
          tool: 'book_appointment',
          output: executeLocalToolCall('book_appointment', {
            business_id: business.id,
            caller_name: preset.qualification.caller_name,
            slot: preset.qualification.preferred_slot,
            service: preset.qualification.service_requested,
          }),
        },
      ];
      return {
        model,
        endpoint,
        qualification: preset.qualification,
        toolTrace,
        latencyMs: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cached: false,
        fallback: true,
        fallbackReason: !apiKey ? 'no_api_key_configured' : budgetCheck.reason,
        costUSD: 0,
      };
    }

    try {
      const t0 = Date.now();
      const messages = [
        {
          role: 'system',
          content: `You are the 24/7 bilingual AI Receptionist for ${business.name} (${business.niche} in ${business.city}). Respond in the caller's language (${lang === 'es' ? 'Spanish' : 'English'}). First use check_calendar_slots or book_appointment to reserve their requested slot, then return the structured LeadQualification JSON.`,
        },
        {
          role: 'user',
          content: cleanTranscript,
        },
      ];

      // Turn 1: allow Muse Spark 1.3 to invoke tools (parallel_tool_calls: false, tool_choice: "auto")
      const r1 = await fetch(`${getMetaBaseUrl().replace(/\/v1$/, '')}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools: RECEPTIONIST_TOOLS,
          tool_choice: 'auto',
          parallel_tool_calls: false,
        }),
      });
      if (!r1.ok) throw new Error(`Muse Spark HTTP ${r1.status}`);
      const d1 = await r1.json();
      let totalCostUSD = computeTokenCostUSD(model, d1.usage);
      let promptTokens = Number(d1.usage?.prompt_tokens ?? d1.usage?.input_tokens ?? 0);
      let completionTokens = Number(d1.usage?.completion_tokens ?? d1.usage?.output_tokens ?? 0);
      let cachedTokens = Number(
        d1.usage?.prompt_tokens_details?.cached_tokens ??
          d1.usage?.input_tokens_details?.cached_tokens ??
          0
      );
      const toolTrace = [];

      const msg1 = d1.choices?.[0]?.message;
      if (msg1?.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: msg1.content || '',
          tool_calls: msg1.tool_calls,
        });
        for (const tc of msg1.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(tc.function?.arguments || '{}');
          } catch (_) {}
          const toolResult = executeLocalToolCall(tc.function?.name, parsedArgs);
          toolTrace.push({ tool: tc.function?.name, args: parsedArgs, output: toolResult });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult),
          });
        }
      }

      // Final Turn: Structured Output conforming strictly to LEAD_QUALIFICATION_JSON_SCHEMA
      const r2 = await fetch(`${getMetaBaseUrl().replace(/\/v1$/, '')}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: LEAD_QUALIFICATION_JSON_SCHEMA,
          },
        }),
      });
      if (!r2.ok) throw new Error(`Muse Spark Structured HTTP ${r2.status}`);
      const d2 = await r2.json();
      const latencyMs = Date.now() - t0;
      totalCostUSD = Number((totalCostUSD + computeTokenCostUSD(model, d2.usage)).toFixed(8));
      promptTokens += Number(d2.usage?.prompt_tokens ?? d2.usage?.input_tokens ?? 0);
      completionTokens += Number(d2.usage?.completion_tokens ?? d2.usage?.output_tokens ?? 0);
      cachedTokens += Number(
        d2.usage?.prompt_tokens_details?.cached_tokens ??
          d2.usage?.input_tokens_details?.cached_tokens ??
          0
      );

      const rawContent = d2.choices?.[0]?.message?.content || '{}';
      const qualification = JSON.parse(rawContent);
      const result = {
        model,
        endpoint,
        qualification,
        toolTrace,
        latencyMs,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          cached_tokens: cachedTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
      this.guardrails.recordLiveCall({
        cacheKey,
        endpoint,
        model,
        costUSD: totalCostUSD,
        value: result,
        sessionId,
      });
      return { ...result, cached: false, fallback: false, costUSD: totalCostUSD };
    } catch (err) {
      return {
        model,
        endpoint,
        qualification: preset.qualification,
        toolTrace: [],
        latencyMs: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        cached: false,
        fallback: true,
        fallbackReason: 'preset_fallback_active',
        costUSD: 0,
      };
    }
  }

  /**
   * 3. Media Segmentation via SAM 3.1 (sam-3.1)
   * Endpoint: POST https://api.meta.ai/v1/responses (SSE stream)
   */
  async segmentBusinessPhoto({
    imageUrl,
    concept = 'chair',
    sessionId = 'default',
  }) {
    const model = 'sam-3.1';
    const endpoint = '/v1/responses';
    const cacheKey = hashRequestKey({ endpoint, model, imageUrl, concept });

    const cached = this.guardrails.getCached(cacheKey, sessionId, { endpoint, model });
    if (cached) {
      return { ...cached, cached: true, fallback: false, costUSD: 0 };
    }

    const apiKey = getMetaApiKey();
    const budgetCheck = this.guardrails.canSpend(0.0025, sessionId);

    if (!apiKey || !budgetCheck.allowed) {
      return {
        model,
        endpoint,
        concept,
        imageUrl,
        ...FALLBACK_SAM_OUTPUT,
        latencyMs: 0,
        cached: false,
        fallback: true,
        fallbackReason: !apiKey ? 'no_api_key_configured' : budgetCheck.reason,
        costUSD: 0,
      };
    }

    try {
      const t0 = Date.now();
      const res = await fetch(`${getMetaBaseUrl().replace(/\/v1$/, '')}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: concept },
                {
                  type: 'input_image',
                  image_url: imageUrl.startsWith('/') && fs.existsSync(path.join(PUBLIC_DIR, imageUrl))
                    ? `data:image/jpeg;base64,${fs.readFileSync(path.join(PUBLIC_DIR, imageUrl)).toString('base64')}`
                    : imageUrl,
                },
              ],
            },
          ],
          stream: true,
          metadata: { mask_encoding: 'one_bit' },
        }),
      });
      if (!res.ok) throw new Error(`SAM 3.1 HTTP ${res.status}`);
      const sseText = await res.text();
      const latencyMs = Date.now() - t0;

      let rawStreamText = '';
      for (const line of sseText.split(/\r?\n/)) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === 'response.output_text.delta' && evt.delta) {
            rawStreamText += evt.delta;
          }
        } catch (_) {}
      }

      const objects = parseSamSegmentationText(rawStreamText);
      const costUSD = computeSamCostUSD({ images: 1 });
      const result = {
        model,
        endpoint,
        concept,
        imageUrl,
        rawStreamPreview:
          rawStreamText.length > 260 ? `${rawStreamText.slice(0, 260)}...` : rawStreamText,
        objectsCount: objects.length,
        objects,
        latencyMs,
      };
      this.guardrails.recordLiveCall({
        cacheKey,
        endpoint,
        model,
        costUSD,
        value: result,
        sessionId,
      });
      return { ...result, cached: false, fallback: false, costUSD };
    } catch (err) {
      return {
        model,
        endpoint,
        concept,
        imageUrl,
        ...FALLBACK_SAM_OUTPUT,
        latencyMs: 0,
        cached: false,
        fallback: true,
        fallbackReason: 'preset_fallback_active',
        costUSD: 0,
      };
    }
  }

  /**
   * 4. On-Brand Visual Generation via Muse Image 1.0 (muse-image-1.0)
   * Endpoint: POST https://api.meta.ai/v1/images/generations
   * Flat price: $0.01 per image
   */
  async generateHeroVisual({ prompt, sessionId = 'default' }) {
    const model = 'muse-image-1.0';
    const endpoint = '/v1/images/generations';
    const cacheKey = hashRequestKey({ endpoint, model, prompt });

    const cached = this.guardrails.getCached(cacheKey, sessionId, { endpoint, model });
    if (cached) {
      return { ...cached, cached: true, fallback: false, costUSD: 0 };
    }

    const apiKey = getMetaApiKey();
    const budgetCheck = this.guardrails.canSpend(0.01, sessionId);

    if (!apiKey || !budgetCheck.allowed) {
      return {
        model,
        endpoint,
        prompt,
        imageUrl:
          'https://images.unsplash.com/photo-1629909615184-74f495363b67?auto=format&fit=crop&w=1000&q=80',
        outputFormat: 'webp',
        latencyMs: 0,
        cached: false,
        fallback: true,
        fallbackReason: !apiKey ? 'no_api_key_configured' : budgetCheck.reason,
        costUSD: 0,
      };
    }

    try {
      const t0 = Date.now();
      const res = await fetch(`${getMetaBaseUrl().replace(/\/v1$/, '')}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          n: 1,
          response_format: 'b64_json',
          output_format: 'webp',
          reasoning_strength: 'low',
          tool_enablement: {
            enable_image_search: false,
            enable_web_search: false,
            enable_shell: false,
          },
        }),
      });
      if (!res.ok) throw new Error(`Muse Image HTTP ${res.status}`);
      const data = await res.json();
      const latencyMs = Date.now() - t0;
      const b64 = data.data?.[0]?.b64_json;
      const fileName = `hero-${cacheKey.slice(0, 12)}.webp`;
      if (b64) {
        fs.writeFileSync(path.join(GENERATED_DIR, fileName), Buffer.from(b64, 'base64'));
      }
      const costUSD = computeImageCostUSD(1);
      const result = {
        model,
        endpoint,
        prompt,
        imageUrl: b64 ? `/generated/${fileName}` : null,
        outputFormat: data.output_format || 'webp',
        latencyMs,
        usage: data.usage || null,
      };
      this.guardrails.recordLiveCall({
        cacheKey,
        endpoint,
        model,
        costUSD,
        value: result,
        sessionId,
      });
      return { ...result, cached: false, fallback: false, costUSD };
    } catch (err) {
      return {
        model,
        endpoint,
        prompt,
        imageUrl:
          'https://images.unsplash.com/photo-1629909615184-74f495363b67?auto=format&fit=crop&w=1000&q=80',
        outputFormat: 'webp',
        latencyMs: 0,
        cached: false,
        fallback: true,
        fallbackReason: 'preset_fallback_active',
        costUSD: 0,
      };
    }
  }
}
