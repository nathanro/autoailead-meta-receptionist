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
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2563eb"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-weight="800" font-size="28">AI</text></svg>';

export function createAppServer(options = {}) {
  const guardrails = new SpendGuardrails(options);
  const client = new MetaPipelineClient(guardrails);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    const sendJson = (status, payload) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(payload, null, 2));
    };

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(FAVICON_SVG);
    }

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
      const generateHero = body.generateHero !== false;
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

      // Step 4: Muse Image 1.0 (Hero Visual Generation — supports customHeroPrompt)
      const heroPromptToUse = body.customHeroPrompt?.trim() || business.heroPrompt;
      const hero = generateHero
        ? await client.generateHeroVisual({
            prompt: heroPromptToUse,
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

    if (req.method === 'POST' && url.pathname === '/api/closer/objection') {
      const body = await readJsonBody();
      const businessId = body.businessId || 'smile-dental-miami';
      const lang = body.lang === 'es' ? 'es' : 'en';
      const customObjection = (body.customObjection || '').trim();
      const business = DEMO_BUSINESSES[businessId] || DEMO_BUSINESSES['smile-dental-miami'];
      const preset = business.presets[lang] || business.presets.en;
      const isDental = businessId === 'smile-dental-miami';

      const objectionText =
        customObjection ||
        (lang === 'es'
          ? isDental
            ? '¿Tienen alguna opción más económica o financiamiento sin intereses para hoy?'
            : 'El cargo de diagnóstico se me hace caro, ¿me lo pueden bonificar?'
          : isDental
          ? 'Is there a cheaper option or 0% financing if I lock the appointment today?'
          : 'That dispatch fee is high—another HVAC company offered a free estimate.');

      const rebuttalReply =
        lang === 'es'
          ? isDental
            ? '¡Por supuesto! Si apartas tu lugar prioritario hoy mismo con solo $49 USD de depósito, te bonificamos el 100% de la consulta de urgencia y radiografía digital ($95 USD ahorrados) y activamos 12 meses sin intereses. ¡Haz clic abajo para asegurar tu cita!'
            : '¡Claro que sí! Para que no pierdas tiempo con el calor, te bonificamos el 100% del cargo de diagnóstico ($89 USD ahorrados) al autorizar tu reparación hoy, y además te aplicamos un bono de $500 USD en equipo nuevo. ¡Apártalo con $49 USD aquí abajo!'
          : isDental
          ? 'Absolutely! When you lock your priority emergency slot right now with a $49 deposit, we waive the $95 emergency exam & X-ray fee 100% toward your crown and unlock 0% CareCredit financing. Click below to lock your 9:30 AM chair!'
          : 'I completely understand! Because your AC is out in 94°F heat, I just applied our Fast-Action Bundle: we waive the $89 dispatch fee 100% into your repair and prioritize our South Congress senior tech for 2:00 PM today. Lock it in now with a $49 deposit below!';

      const toolTrace = [
        {
          tool: 'evaluate_objection_and_offer',
          args: { business_id: business.id, objection: objectionText, margin_floor_check: true },
          output: {
            status: 'approved_fast_action_bundle',
            waived_fee_usd: isDental ? 95 : 89,
            deposit_due_today_usd: 49,
            bundle_price_usd: preset.qualification.estimated_value_usd,
          },
        },
        {
          tool: 'create_instant_checkout',
          args: { business_id: business.id, deposit_usd: 49, slot: preset.qualification.preferred_slot },
          output: {
            checkout_id: 'chk_live_' + Date.now().toString(36),
            status: 'ready_for_1click_payment',
            deposit_usd: 49,
          },
        },
      ];

      return sendJson(200, {
        ok: true,
        businessId,
        lang,
        objectionText,
        rebuttalReply,
        toolTrace,
        checkoutOffer: {
          offerId: 'chk_' + Date.now().toString(36),
          title:
            lang === 'es'
              ? isDental
                ? 'Bono $95 Consulta/Rayos-X Gratis + Cita Prioritaria'
                : 'Cargo de Diagnóstico $89 Bonificado + Prioridad Hoy'
              : isDental
              ? 'Waived $95 Exam/X-Ray Fee + Priority Chair Lock'
              : 'Waived $89 Dispatch Fee + Today 2:00 PM Priority Lock',
          listPriceUSD: Number(preset.qualification.estimated_value_usd) + (isDental ? 95 : 89),
          bundlePriceUSD: Number(preset.qualification.estimated_value_usd),
          depositDueTodayUSD: 49,
          slot: preset.qualification.preferred_slot,
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/closer/checkout') {
      const body = await readJsonBody();
      const businessId = body.businessId || 'smile-dental-miami';
      const lang = body.lang === 'es' ? 'es' : 'en';
      const business = DEMO_BUSINESSES[businessId] || DEMO_BUSINESSES['smile-dental-miami'];
      const preset = business.presets[lang] || business.presets.en;
      const receiptId = 'rcpt_' + Date.now().toString(36);

      return sendJson(200, {
        ok: true,
        status: 'DEPOSIT_PAID_AND_SLOT_LOCKED',
        receiptId,
        depositPaidUSD: 49,
        totalValueUSD: preset.qualification.estimated_value_usd,
        slot: preset.qualification.preferred_slot,
        ownerWhatsappAlert:
          lang === 'es'
            ? `💰 [AutoAI Lead AI Closer] ¡VENTA CERRADA Y DEPÓSITO PAGADO! ${preset.qualification.caller_name} pagó $49 USD de depósito instantáneo para bloquear la cita (${preset.qualification.preferred_slot}). Ticket asegurado: $${preset.qualification.estimated_value_usd} USD. Recibo #${receiptId}`
            : `💰 [AutoAI Lead AI Closer] DEAL CLOSED & DEPOSIT PAID! ${preset.qualification.caller_name} just paid $49 USD instant deposit to lock ${preset.qualification.preferred_slot} (${business.name}). Secured ticket value: $${preset.qualification.estimated_value_usd} USD. Receipt #${receiptId}`,
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/site/')) {
      const bizSlug = url.pathname.replace('/site/', '').replace(/\/+$/, '') || 'smile-dental-miami';
      const b = DEMO_BUSINESSES[bizSlug] || DEMO_BUSINESSES['smile-dental-miami'];
      const heroImg = bizSlug.includes('hvac') ? '/generated/hero-8ac62160c596.webp' : '/generated/hero-fadc3c117c4e.webp';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${b.name} — AutoAI Lead Live Demo Site</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}.hero{height:340px;background:linear-gradient(rgba(15,23,42,.55),rgba(15,23,42,.75)),url('${heroImg}') center/cover;color:#fff;display:flex;flex-direction:column;justify-content:flex-end;padding:2rem 3rem}.wrap{max-width:960px;margin:2rem auto;padding:0 1.5rem}.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:1.5rem;box-shadow:0 4px 14px rgba(0,0,0,.05);margin-bottom:1.2rem}.btn{display:inline-block;background:#2563eb;color:#fff;padding:.65rem 1.2rem;border-radius:8px;text-decoration:none;font-weight:700}</style></head><body><div class="hero"><div style="font-size:.85rem;font-weight:700;text-transform:uppercase;color:#93c5fd">${b.niche} · ${b.city}</div><h1 style="font-size:2.2rem;margin:.3rem 0">${b.name}</h1><div>⭐ ${b.rating} (${b.reviewCount} Reviews) · 📞 ${b.phone}</div></div><div class="wrap"><div class="card"><h2>24/7 AI Voice Receptionist &amp; Instant Booking Active</h2><p>This standalone local business site was automatically generated by <strong>AutoAI Lead</strong> using Meta <code>muse-image-1.0</code>, <code>sam-3.1</code>, <code>muse-voice-transcribe-1.0</code>, and <code>muse-spark-1.3</code>.</p><a class="btn" href="/">← Return to Interactive 4-Model Split-View Console</a></div></div></body></html>`);
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
