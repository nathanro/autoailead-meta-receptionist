import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpendGuardrails, META_PRICING } from './guardrails.js';
import { MetaPipelineClient, getMetaApiKey } from './metaClient.js';
import { DEMO_BUSINESSES } from './fallbackData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function createAppServer(options = {}) {
  const guardrails = new SpendGuardrails(options);
  const client = new MetaPipelineClient(guardrails);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    const sendJson = (status, payload) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(payload, null, 2));
    };

    const readJsonBody = () =>
      new Promise((resolve) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > 8_000_000) req.destroy();
        });
        req.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch (_) {
            resolve({});
          }
        });
      });

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      return sendJson(200, {
        status: 'ok',
        service: 'autoailead-meta-receptionist',
        metaApiConfigured: Boolean(getMetaApiKey()),
        pricing: META_PRICING,
        budget: guardrails.getSummary(sessionId),
        businesses: Object.values(DEMO_BUSINESSES).map((b) => ({
          id: b.id,
          name: b.name,
          niche: b.niche,
          city: b.city,
          rating: b.rating,
          reviewCount: b.reviewCount,
          phone: b.phone,
          samplePhotoUrl: b.samplePhotoUrl,
          samTargetConcept: b.samTargetConcept,
          heroPrompt: b.heroPrompt,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/pipeline/run') {
      const body = await readJsonBody();
      const businessId = body.businessId || 'smile-dental-miami';
      const lang = body.lang === 'es' ? 'es' : 'en';
      const sessionId = body.sessionId || 'demo-session';
      const generateHero = body.generateHero !== false; // default true (hits cache at $0.00)
      const business = DEMO_BUSINESSES[businessId] || DEMO_BUSINESSES['smile-dental-miami'];

      // Step 1: Muse Voice Transcribe 1.0 (ASR)
      const asr = await client.transcribeAudio({
        wavBuffer: body.audioBase64 ? Buffer.from(body.audioBase64, 'base64') : null,
        businessId,
        lang,
        sessionId,
      });

      // Step 2: Muse Spark 1.3 (Tool Calling + Structured Output Qualification)
      const transcriptToUse = body.customTranscript?.trim() || asr.transcript;
      const reception = await client.qualifyAndBookLead({
        transcript: transcriptToUse,
        businessId,
        lang,
        sessionId,
      });

      // Step 3: SAM 3.1 (Media Segmentation on business photo)
      const sam = await client.segmentBusinessPhoto({
        imageUrl: business.samplePhotoUrl,
        concept: business.samTargetConcept,
        sessionId,
      });

      // Step 4: Muse Image 1.0 (Hero Visual Generation)
      const hero = generateHero
        ? await client.generateHeroVisual({
            prompt: business.heroPrompt,
            sessionId,
          })
        : null;

      return sendJson(200, {
        business: {
          id: business.id,
          name: business.name,
          niche: business.niche,
          city: business.city,
          rating: business.rating,
          reviewCount: business.reviewCount,
          phone: business.phone,
          samplePhotoUrl: business.samplePhotoUrl,
          samTargetConcept: business.samTargetConcept,
        },
        steps: {
          asr,
          reception,
          sam,
          hero,
        },
        budget: guardrails.getSummary(sessionId),
      });
    }

    // Serve static files from PUBLIC_DIR (/index.html, /audio/*, /photos/*, /generated/*)
    if (req.method === 'GET') {
      const safeRelPath = path
        .normalize(url.pathname === '/' ? '/index.html' : url.pathname)
        .replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(PUBLIC_DIR, safeRelPath);
      if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        return fs.createReadStream(fullPath).pipe(res);
      }
    }

    return sendJson(404, { error: 'Not found' });
  });

  return { server, guardrails, client };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3080);
  const { server } = createAppServer();
  server.listen(port, () => {
    console.log(
      `[autoailead-meta-receptionist] listening on http://localhost:${port} (META_API_KEY configured: ${Boolean(
        getMetaApiKey()
      )})`
    );
  });
}
