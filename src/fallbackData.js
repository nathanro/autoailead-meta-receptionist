export const DEMO_BUSINESSES = {
  'smile-dental-miami': {
    id: 'smile-dental-miami',
    name: 'Smile Dental Clinic Brickell',
    niche: 'Emergency & Cosmetic Dentistry',
    city: 'Miami, FL',
    rating: 4.9,
    reviewCount: 214,
    phone: '+1 (305) 555-0194',
    languages: ['English', 'Spanish'],
    samplePhotoUrl: '/photos/smile-dental-miami.jpg',
    samTargetConcept: 'dental chair',
    heroPrompt: 'Modern bright dental clinic reception in Brickell Miami, warm sunlight, minimalist luxury interior, photorealistic',
    presets: {
      en: {
        audioLabel: 'Caller (EN): Broken crown emergency before Friday trip',
        transcript:
          "Hi, I cracked my front dental crown eating lunch in Brickell and I am flying out Friday morning. Do you have any emergency slot tomorrow at 9 30?",
        qualification: {
          caller_name: 'Marcus Vance',
          detected_language: 'en',
          urgency: 'high',
          service_requested: 'Emergency Crown Repair & Exam',
          preferred_slot: 'Tomorrow 09:30 AM EDT',
          estimated_value_usd: 850,
          receptionist_reply:
            'Hi Marcus! We can get you in tomorrow at 9:30 AM at Smile Dental Brickell for an emergency crown repair before your Friday flight. The emergency exam + X-ray is $95, applied toward your crown. I just reserved 9:30 AM and texted Dr. Morales.',
          owner_whatsapp_summary:
            '🚨 [AutoAI Lead] High-Urgency Dental Lead: Marcus Vance — Broken front crown (flying Friday). Booked: Tomorrow 9:30 AM. Est. value: $850.',
        },
      },
      es: {
        audioLabel: 'Llamada (ES): Dolor de muela urgente hoy en la tarde',
        transcript:
          'Hola buenas tardes, tengo un dolor fuerte en una muela desde ayer y busco dentista que hable español aquí en Miami. ¿Tienen espacio hoy a las cuatro y media?',
        qualification: {
          caller_name: 'Valeria Gómez',
          detected_language: 'es',
          urgency: 'high',
          service_requested: 'Consulta de Urgencia Endodoncia / Dolor Molar',
          preferred_slot: 'Hoy 16:30 PM EDT',
          estimated_value_usd: 620,
          receptionist_reply:
            '¡Hola Valeria! Claro que sí, toda nuestra clínica en Brickell atiende en español. Te acabo de apartar hoy a las 4:30 PM con la Dra. Morales para revisarte la muela de inmediato y quitarte el dolor. Te envié la ubicación por WhatsApp.',
          owner_whatsapp_summary:
            '🚨 [AutoAI Lead] Lead Urgente (ES): Valeria Gómez — Dolor agudo molar. Cita agendada: Hoy 4:30 PM. Valor est.: $620 USD.',
        },
      },
    },
  },
  'lone-star-hvac-austin': {
    id: 'lone-star-hvac-austin',
    name: 'Lone Star AC & Heating',
    niche: '24/7 HVAC Repair & Installation',
    city: 'Austin, TX',
    rating: 4.8,
    reviewCount: 168,
    phone: '+1 (512) 555-0148',
    languages: ['English', 'Spanish'],
    samplePhotoUrl: '/photos/lone-star-hvac-austin.jpg',
    samTargetConcept: 'technician',
    heroPrompt: 'Clean modern residential HVAC service van parked in front of an Austin Texas home at golden hour, crisp commercial photography',
    presets: {
      en: {
        audioLabel: 'Caller (EN): AC blowing warm air, 94°F in Austin',
        transcript:
          'Hey, our upstairs AC unit stopped cooling and it is 94 degrees inside with two kids. Can a technician come out to South Congress this afternoon at 2 PM?',
        qualification: {
          caller_name: 'Devon Brooks',
          detected_language: 'en',
          urgency: 'high',
          service_requested: 'Emergency AC Diagnostic & Capacitor/Refrigerant Repair',
          preferred_slot: 'Today 02:00 PM CDT',
          estimated_value_usd: 480,
          receptionist_reply:
            'Hi Devon, we have a senior HVAC technician near South Congress right now. I booked your emergency diagnostic for today at 2:00 PM ($79 dispatch fee, waived with repair) and alerted our lead tech.',
          owner_whatsapp_summary:
            '🔥 [AutoAI Lead] Emergency HVAC Dispatch: Devon Brooks (South Congress) — AC blowing warm, kids at home. Booked Today 2:00 PM. Est. ticket: $480.',
        },
      },
      es: {
        audioLabel: 'Llamada (ES): Cotización de reemplazo de aire central',
        transcript:
          'Hola, tenemos un restaurante pequeño en Austin y el aire central hace hace mucho ruido. ¿Me pueden dar cita mañana a las ocho y media para revisar el equipo?',
        qualification: {
          caller_name: 'Carlos Méndez',
          detected_language: 'es',
          urgency: 'medium',
          service_requested: 'Cotización Comercial Reemplazo HVAC',
          preferred_slot: 'Mañana 08:30 AM CDT',
          estimated_value_usd: 6500,
          receptionist_reply:
            '¡Hola Carlos! Con gusto. Agendé a nuestro especialista comercial mañana a las 8:30 AM en tu restaurante para revisar el tonelaje y darte la cotización sin costo.',
          owner_whatsapp_summary:
            '💼 [AutoAI Lead] Lead Comercial HVAC (ES): Carlos Méndez — Reemplazo unidad de restaurante. Cita: Mañana 8:30 AM. Valor est.: $6,500 USD.',
        },
      },
    },
  },
};

export const FALLBACK_SAM_OUTPUT = {
  rawStreamText:
    '<0f>0<|box;x1=142;y1=118;x2=710;y2=540;w=900;h=600;c=0.972|><|mask;x=0;y=0;c=0.972;data=422,568,!0c[0o91w?q1!pIH4pPRVp2B3|>',
  objects: [
    {
      frameIndex: 0,
      objectId: 0,
      box: { x1: 142, y1: 118, x2: 710, y2: 540, width: 900, height: 600, confidence: 0.972 },
      mask: { rows: 422, cols: 568, encoding: 'one_bit' },
    },
  ],
};
