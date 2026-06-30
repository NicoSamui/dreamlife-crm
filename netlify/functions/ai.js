// DreamCRM — KI-Proxy (Netlify Function)
// Ruft Claude (Anthropic) serverseitig auf. Der API-Key liegt NUR als
// Netlify-Umgebungsvariable ANTHROPIC_API_KEY vor — niemals im Browser.
// Aufruf aus der App: POST /.netlify/functions/ai
//   { type:'dm'|'next'|'objection', inputs:{...Lead...}, pid:<user_id>, ctx:{name} }

const SUPA = 'https://pkugrquuudreqkwletyv.supabase.co';
const ANON = 'sb_publishable_h9GbkdiHyn8G4S3aoyVjpg_RafiGTS9';
const MODEL = 'claude-haiku-4-5-20251001';
const DAILY_LIMIT = 60; // KI-Aufrufe pro Teilnehmer pro Tag

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function resp(code, obj) {
  return { statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS), body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const type = body.type, inputs = body.inputs || {}, pid = body.pid;
    const ctx = body.ctx || {};

    if (!pid) return resp(400, { error: 'Kein Teilnehmer angemeldet.' });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return resp(503, { error: 'KI ist noch nicht konfiguriert (API-Key fehlt im Backend).' });

    // Tageslimit pro Teilnehmer — fail-open: bei jedem Fehler (z.B. Tabelle fehlt) wird NICHT blockiert
    try {
      const day = new Date().toISOString().slice(0, 10);
      const uq = await fetch(SUPA + '/rest/v1/ai_usage?pid=eq.' + encodeURIComponent(pid) + '&day=eq.' + day + '&select=count', {
        headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }
      });
      if (uq.ok) {
        const urows = await uq.json();
        const used = (Array.isArray(urows) && urows[0] && urows[0].count) ? urows[0].count : 0;
        if (used >= DAILY_LIMIT) return resp(429, { error: 'Dein KI-Tageslimit ist erreicht (' + DAILY_LIMIT + ' pro Tag). Morgen geht es weiter.' });
        await fetch(SUPA + '/rest/v1/ai_usage?on_conflict=pid,day', {
          method: 'POST',
          headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ pid: pid, day: day, count: used + 1 })
        });
      }
    } catch (e) { /* fail open */ }

    const p = buildPrompt(type, inputs, ctx);
    if (!p) return resp(400, { error: 'Unbekannter Generator.' });
    p.system = p.system + VOICE;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: p.system, messages: [{ role: 'user', content: p.user }] })
    });
    const data = await r.json();
    if (!r.ok) return resp(502, { error: (data.error && data.error.message) || 'KI-Fehler.' });
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    return resp(200, { text: text });
  } catch (e) {
    return resp(500, { error: e.message });
  }
};

const VOICE = '\n\nSCHREIB-STIL (immer einhalten):\n- Per Du, nahbar und direkt.\n- Kurze Sätze, Klartext, echt statt poliert.\n- Kein Coaching-Bingo, keine Buzzwords, keine Floskeln.\n- NIEMALS Preise, Tarife oder konkrete Kosten nennen — das passiert nur im persönlichen Erstgespräch.';

function v(x, d) { return (x && ('' + x).trim()) ? ('' + x).trim() : (d || '(offen)'); }

function leadBlock(i) {
  return 'Lead: ' + v(i.name) + (i.company ? ' (' + i.company + ')' : '') +
    '\nBranche/Ort: ' + v(i.industry) + ' / ' + v(i.location) +
    '\nQuelle: ' + v(i.source) +
    '\nAktuelle Phase: ' + v(i.stage) +
    '\nAufhänger: ' + v(i.hook) +
    '\nLetzter Stand / Notiz: ' + v(i.note);
}

function buildPrompt(type, i, ctx) {
  i = i || {};
  if (type === 'dm') return {
    system: 'Du bist ein Top-Sales-Texter für Akquise und Social-Outreach (Instagram-DM, Mail, Telefon). Du schreibst kurze, persönliche, nicht-spammige Nachrichten, die eine Antwort bekommen. Antworte auf Deutsch, per Du.',
    user: 'Schreib die nächste Nachricht an diesen Lead.\n\n' + leadBlock(i) +
      '\n\nGib NUR die fertige Nachricht zum Rauskopieren aus — kurz, locker, mit genau einem klaren, sanften nächsten Schritt (Rückfrage oder Terminvorschlag). Kein Vorwort, keine Erklärung, keine Anführungszeichen.'
  };
  if (type === 'next') return {
    system: 'Du bist ein pragmatischer Sales-Coach. Du sagst klar und konkret, was als Nächstes zu tun ist, damit der Lead vorankommt. Antworte auf Deutsch, per Du.',
    user: 'Was ist der beste nächste Schritt bei diesem Lead?\n\n' + leadBlock(i) +
      '\n\nGib 1–3 konkrete, sofort umsetzbare Schritte als kurze nummerierte Liste. Klartext, kein Geschwafel.'
  };
  if (type === 'objection') {
    const map = { preis: 'Das ist mir zu teuer.', zeit: 'Ich habe gerade keine Zeit.', ueberlegen: 'Ich muss es mir noch überlegen.' };
    const einwand = map[i.objection] || i.objection || 'Skepsis';
    return {
      system: 'Du bist ein ruhiger, souveräner Closer. Du löst Einwände ehrlich und ohne Druck — mit Verständnis, einem Reframe und einer guten Rückfrage. Antworte auf Deutsch, per Du.',
      user: 'Der Lead hat diesen Einwand: "' + einwand + '"\n\n' + leadBlock(i) +
        '\n\nGib eine kurze, schlagfertige Antwort zum Rauskopieren: erst echtes Verständnis, dann ein Reframe (neuer Blickwinkel), dann eine Rückfrage, die das Gespräch weiterbringt. Keine Preise nennen.'
    };
  }
  return null;
}
