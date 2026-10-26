# AutoAI Lead — 24/7 Bilingual AI Receptionist & Visual Demo Engine

Built for the **Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026 · Startup Track · Theme: Build for Your World)**.

AutoAI Lead (`https://autoailead.com`) helps small agencies sign local businesses by automatically generating a live mobile demo site from Google Places data. This service adds the **24/7 Bilingual AI Receptionist & Visual Demo Engine** powered by four Meta Model API models (`https://api.meta.ai/v1`).

## Meta Model API Pipeline (`https://api.meta.ai/v1`)

1. **`muse-voice-transcribe-1.0` (`/v1/asr/transcribe` & `wss://api.meta.ai/v1/asr/realtime`)**:
   - Transcribes incoming customer calls/voice notes in English, Spanish, or code-switched Spanglish (`ENDPOINTING` mode with `languageBias: ["English", "Spanish"]` and domain `keywords`).
   - Cost: **$0.18 / hour** ($0.003 / minute, rounded down to whole seconds).
2. **`muse-spark-1.3` (`/v1/chat/completions`)**:
   - Executes developer-defined tools (`check_calendar_slots`, `book_appointment`) with `tool_choice: "auto"` and `parallel_tool_calls: false`.
   - Returns schema-constrained JSON via `response_format: { type: "json_schema", json_schema: { name: "LeadQualification", strict: true } }` with caller urgency, booked slot, bilingual response, and WhatsApp owner alert.
   - Cost: **$1.25 / 1M input tokens** ($0.15 / 1M cached), **$4.25 / 1M output tokens** (or **$0.10 / $0.20** in Contributor mode `muse-spark-1.3-contributor`).
3. **`sam-3.1` (`/v1/responses`)**:
   - Segments key visual objects (`dental chair`, `air conditioner unit`, `storefront`) from the local business's photos (`mask_encoding: "one_bit"`).
   - Cost: **$2.50 / 1,000 images** ($0.0025 per image).
4. **`muse-image-1.0` (`/v1/images/generations`)**:
   - Generates clean, on-brand hero visuals for the business's demo site (`reasoning_strength: "low"`, `output_format: "webp"`).
   - Cost: **$0.01 / image** flat rate.

## Strict Spend Guardrails (Zero Overcharge Protection)

Because Meta Model API's dashboard "Spend Limit" is an email alert rather than a hard billing cap, this repository enforces a **hard code-level spend guardrail (`src/guardrails.js`)**:
- **Content-Addressed SQLite + JSON Cache (`data/guardrails.sqlite`)**: Every request (prompt, audio SHA-256, image URL) is cached on disk. Repeating QA runs or judge demos costs **$0.00**.
- **Hard Total Cap (`MAX_TOTAL_SPEND_USD=5.00`)**: Blocks live network calls once $5.00 USD of the $150.00 credit is reached.
- **Hard Per-Session Cap (`MAX_SESSION_SPEND_USD=0.50`, `MAX_CALLS_PER_SESSION=15`)**: Prevents runaway loops.
- **Zero-Error Bilingual Fallback**: If `META_API_KEY` is absent or a cap is reached, the pipeline returns pre-computed EN/ES responses with `fallback: true` so the live demo never displays an error.

## Quickstart

```bash
cp .env.example .env
# Add META_API_KEY=LLM_...
npm test
npm start
```
