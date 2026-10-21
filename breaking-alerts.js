#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════
//  BRIEF — BREAKING NEWS ALERTS
//  Checks major news outlets every few minutes. When several different
//  outlets publish the same story close together, the AI rates how big it
//  is, and if it's major you get an alert on Discord and/or your phone.
//
//  Needs Node 18 or newer. No packages to install.
//
//  Settings (set these as environment variables, never paste keys in here):
//    DISCORD_WEBHOOK_URL  Discord channel webhook (optional)
//    NTFY_TOPIC           ntfy topic name for phone alerts (optional)
//    GROQ_API_KEY         Groq key, used to rate importance (recommended)
//    CHECK_EVERY_MIN      minutes between checks when running nonstop (default 5)
//    MIN_OUTLETS          outlets that must cover a story (default 4)
//    WINDOW_MIN           how close together they must publish, in minutes (default 90)
//    MIN_SCORE            AI importance needed to alert, 1-10 (default 7)
//    STATE_FILE           where past alerts are remembered (default breaking-state.json)
//
//  Run:
//    node breaking-alerts.js           keeps running, checks every few minutes
//    node breaking-alerts.js --once    one check, then stops (for GitHub Actions)
//    node breaking-alerts.js --test    sends a test alert so you can check setup
//    node breaking-alerts.js --dry     shows what it would alert, sends nothing
// ══════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const http = require('http');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  groqKey: process.env.GROQ_API_KEY || '',
  everyMin: num(process.env.CHECK_EVERY_MIN, 5),
  minOutlets: num(process.env.MIN_OUTLETS, 4),
  windowMin: num(process.env.WINDOW_MIN, 90),
  minScore: num(process.env.MIN_SCORE, 7),
  stateFile: process.env.STATE_FILE || 'breaking-state.json',
};
const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has('--dry');

// Free news feeds (RSS). A feed that stops working is skipped and logged, so
// the rest keep going. Add or remove outlets here.
const FEEDS = [
  ['BBC News', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['BBC News', 'https://feeds.bbci.co.uk/news/rss.xml'],
  ['NPR', 'https://feeds.npr.org/1001/rss.xml'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['The Guardian', 'https://www.theguardian.com/world/rss'],
  ['The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
  ['The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'],
  ['The Washington Post', 'https://feeds.washingtonpost.com/rss/world'],
  ['CBS News', 'https://www.cbsnews.com/latest/rss/main'],
  ['ABC News', 'https://feeds.abcnews.com/abcnews/topstories'],
  ['Fox News', 'https://moxie.foxnews.com/google-publisher/latest.xml'],
  ['PBS NewsHour', 'https://www.pbs.org/newshour/feeds/rss/headlines'],
  ['CNBC', 'https://www.cnbc.com/id/100727362/device/rss/rss.html'],
  ['Sky News', 'https://feeds.skynews.com/feeds/rss/world.xml'],
  ['DW', 'https://rss.dw.com/rdf/rss-en-all'],
  ['France 24', 'https://www.france24.com/en/rss'],
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const MIN = 60 * 1000, HOUR = 60 * MIN;

// ── Reading the feeds ─────────────────────────────────────────────
function clean(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? clean(m[1]) : '';
}
function parseFeed(xml, outlet) {
  const items = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const title = tag(b, 'title');
    let link = tag(b, 'link');
    if (!/^https?:/i.test(link)) { const lm = b.match(/<link[^>]*href="([^"]+)"/i); link = lm ? lm[1] : ''; }
    const when = Date.parse(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated'));
    const desc = tag(b, 'description') || tag(b, 'summary');
    if (title && /^https?:/i.test(link)) items.push({ outlet, title, link, desc: desc.slice(0, 300), time: Number.isFinite(when) ? when : null });
  }
  return items;
}
async function fetchFeed([outlet, url]) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BriefBreakingAlerts/1.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parseFeed(await r.text(), outlet);
  } catch (e) {
    log(`skipped ${outlet} (${url}): ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    return [];
  } finally { clearTimeout(t); }
}

// ── Spotting the same story across outlets ────────────────────────
const STOP = new Set(('the a an and or but of to in on at for with from by as is are was were be been has have had will would could should can may might after before over under into about amid says say said new its it this that these those than more most up down out who what when where why how not no against during while just also his her their they them its our your you we us he she him first last year years day days week time two three one live updates update breaking latest news report reports video watch photos people says get gets set sets make makes take takes').split(' '));
const SYN = { quake: 'earthquake', quakes: 'earthquake', earthquakes: 'earthquake', dead: 'kill', deaths: 'kill', death: 'kill', killed: 'kill', kills: 'kill', killing: 'kill', dies: 'kill', died: 'kill', polls: 'election', vote: 'election', voters: 'election', strikes: 'strike', struck: 'strike', attacks: 'attack', attacked: 'attack' };
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);
function tokens(text) {
  const out = new Set();
  String(text).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach(w => {
    if (w.length <= 2 || STOP.has(w)) return;
    out.add(SYN[w] || stem(w));
  });
  return out;
}
const shared = (a, b) => { let n = 0; a.forEach(x => { if (b.has(x)) n++; }); return n; };
function sameStory(a, b) {
  const st = shared(a.tt, b.tt);
  const cross = Math.max(shared(a.tt, b.ft), shared(b.tt, a.ft));
  const smaller = Math.max(1, Math.min(a.tt.size, b.tt.size));
  return st >= 3 || (st >= 2 && cross >= 4) || (cross >= 3 && cross / smaller >= 0.6);
}
function cluster(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (items[i].outlet !== items[j].outlet && sameStory(items[i], items[j])) parent[find(i)] = find(j);
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); });
  return [...groups.values()];
}

// ── Remembering what was already sent ─────────────────────────────
function loadState() {
  try { return { ...JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')), _loaded: true }; }
  catch (_) { return { alerted: {}, checked: {}, firstSeen: {}, _loaded: false }; }
}
function saveState(state) {
  const cutoff = Date.now() - 24 * HOUR;
  for (const k of ['alerted', 'firstSeen']) for (const [l, t] of Object.entries(state[k] || {})) if (t < cutoff) delete state[k][l];
  for (const [l, v] of Object.entries(state.checked || {})) if (!v || v.ts < cutoff) delete state.checked[l];
  const { _loaded, ...save } = state;
  try { fs.writeFileSync(CONFIG.stateFile, JSON.stringify(save)); } catch (e) { log('could not save state:', e.message); }
}

// ── AI importance check (Groq) ────────────────────────────────────
async function aiRate(group) {
  if (!CONFIG.groqKey) return null;
  const lines = group.slice(0, 12).map((it, i) => `${i + 1}. [${it.outlet}] ${it.title}${it.desc ? ' | ' + it.desc.slice(0, 160) : ''}`).join('\n');
  const prompt = `These headlines were published by different news outlets within the last ${CONFIG.windowMin} minutes:
${lines}

Answer with JSON only:
{"same_event": true or false (are most of them about the same specific event?),
 "importance": 1-10 (how big is this for a world news app for teenagers? 9-10 = major world event such as a war starting, a huge disaster, a world leader dying, a historic election result; 7-8 = big national or international story; 1-6 = routine news),
 "headline": "clear, neutral headline, max 90 characters, using only facts from the headlines",
 "summary": "one or two plain sentences on what happened, using only facts from the headlines",
 "hook": "opening line for a short news video, max 12 words, accurate, no clickbait"}`;
  for (const model of ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.groqKey}` },
        body: JSON.stringify({ model, temperature: 0.1, max_tokens: 600, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await r.json();
      if (d.error) { log(`AI (${model}) error: ${d.error.message}`); continue; }
      const txt = String(d.choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
      const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      return { same: j.same_event !== false, score: Number(j.importance) || 0, headline: String(j.headline || ''), summary: String(j.summary || ''), hook: String(j.hook || '') };
    } catch (e) { log(`AI (${model}) failed: ${e.message}`); }
  }
  return null;
}

// ── Sending alerts ────────────────────────────────────────────────
function pickLinks(group) {
  const seen = new Set(), out = [];
  for (const it of group) { if (seen.has(it.outlet)) continue; seen.add(it.outlet); out.push(it); }
  return out;
}
async function sendAlert(a) {
  const links = pickLinks(a.items);
  const outlets = links.map(l => l.outlet);
  const lines = [
    a.summary,
    '',
    `Covered by ${outlets.length} outlets: ${outlets.join(', ')}`,
    a.hook ? `Video hook idea: ${a.hook}` : '',
    a.score ? `Importance: ${a.score}/10` : 'Not AI-checked (no Groq key or the AI was down)',
  ].filter(x => x !== null);
  if (DRY) { log('[DRY RUN] would alert:', a.headline, '\n' + lines.join('\n')); return; }
  const jobs = [];
  if (CONFIG.discordWebhook) {
    jobs.push(fetch(CONFIG.discordWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Brief Breaking',
        embeds: [{
          title: ('🚨 ' + a.headline).slice(0, 256), url: links[0].link, color: 0xCC0000,
          description: lines.join('\n').slice(0, 3500),
          fields: [{ name: 'Sources', value: links.slice(0, 6).map(l => `[${l.outlet}](${l.link})`).join('\n').slice(0, 1024) }],
          footer: { text: 'Check the facts against the sources before posting.' },
          timestamp: new Date().toISOString(),
        }],
      }),
    }).then(r => { if (!r.ok) throw new Error('Discord said ' + r.status); }));
  }
  if (CONFIG.ntfyTopic) {
    jobs.push(fetch('https://ntfy.sh/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: CONFIG.ntfyTopic, title: ('Breaking: ' + a.headline).slice(0, 250),
        message: lines.join('\n').slice(0, 3500), priority: a.score >= 9 ? 5 : 4,
        tags: ['rotating_light'], click: links[0].link,
      }),
    }).then(r => { if (!r.ok) throw new Error('ntfy said ' + r.status); }));
  }
  if (!jobs.length) { log('No DISCORD_WEBHOOK_URL or NTFY_TOPIC set, so nowhere to send:', a.headline); return; }
  const results = await Promise.allSettled(jobs);
  results.forEach(r => { if (r.status === 'rejected') log('alert failed:', r.reason.message); });
  log('ALERT SENT:', a.headline);
}

// ── One check ─────────────────────────────────────────────────────
async function checkOnce(state) {
  const now = Date.now();
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const byLink = new Map();
  for (const it of all) if (!byLink.has(it.link)) byLink.set(it.link, it);
  for (const it of byLink.values()) {
    if (!state.firstSeen[it.link]) state.firstSeen[it.link] = now;
    // No date, or a date in the future: use when we first saw it
    if (!it.time || it.time > now + 5 * MIN) it.time = state.firstSeen[it.link];
  }
  const recent = [...byLink.values()].filter(it => it.time >= now - CONFIG.windowMin * MIN);
  recent.forEach(it => { it.tt = tokens(it.title); it.ft = tokens(it.title + ' ' + it.desc); });
  log(`checked ${new Set(all.map(i => i.outlet)).size} outlets, ${recent.length} stories from the last ${CONFIG.windowMin} min`);

  // On a brand-new start, only alert on stories that just became big (not ones from hours ago)
  const maxAge = state._loaded ? 6 * HOUR : 45 * MIN;
  for (const group of cluster(recent)) {
    const outlets = new Set(group.map(i => i.outlet));
    const breaking = group.some(i => /\bbreaking\b/i.test(i.title));
    const needed = Math.max(2, CONFIG.minOutlets - (breaking ? 1 : 0));
    if (outlets.size < needed) continue;
    const links = group.map(i => i.link);
    if (links.some(l => state.alerted[l])) { links.forEach(l => { state.alerted[l] = state.alerted[l] || now; }); continue; }

    // When did this story reach enough outlets?
    group.sort((a, b) => a.time - b.time);
    const seenOutlets = new Set(); let crossedAt = now;
    for (const it of group) { seenOutlets.add(it.outlet); if (seenOutlets.size >= needed) { crossedAt = it.time; break; } }
    if (crossedAt < now - maxAge) { links.forEach(l => { state.alerted[l] = now; }); continue; }

    // Don't ask the AI again about the same story unless 2+ more outlets picked it up
    const prev = Math.max(0, ...links.map(l => (state.checked[l] ? state.checked[l].n : 0)));
    if (prev && outlets.size < prev + 2) continue;

    const ai = await aiRate(group);
    links.forEach(l => { state.checked[l] = { n: outlets.size, ts: now }; });
    if (ai && (!ai.same || ai.score < CONFIG.minScore)) {
      log(`not major enough (${ai.same ? ai.score + '/10' : 'mixed stories'}): ${group[0].title}`);
      continue;
    }
    await sendAlert({
      headline: (ai && ai.headline) || group[0].title,
      summary: (ai && ai.summary) || group[0].desc || '',
      hook: ai ? ai.hook : '',
      score: ai ? ai.score : 0,
      items: group,
    });
    links.forEach(l => { state.alerted[l] = now; });
  }
  state._loaded = true;
  saveState(state);
}

// ── Start ─────────────────────────────────────────────────────────
async function main() {
  if (ARGS.has('--test')) {
    await sendAlert({
      headline: 'Test alert: Brief breaking news alerts are working',
      summary: 'If you can see this, alerts are set up correctly.',
      hook: 'This is what a video hook idea will look like.', score: 10,
      items: [{ outlet: 'Brief', link: 'https://example.com' }],
    });
    return;
  }
  if (!CONFIG.groqKey) log('No GROQ_API_KEY set: alerts will not be rated for importance, so expect more of them.');
  const state = loadState();
  if (ARGS.has('--once') || DRY) { await checkOnce(state); return; }

  // Lets it run on hosts that expect a web server (like a Render web service)
  if (process.env.PORT) http.createServer((_, res) => res.end('Brief breaking alerts: running')).listen(process.env.PORT);
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try { await checkOnce(state); } catch (e) { log('check failed:', e.message); }
    busy = false;
  };
  log(`Running. Checking every ${CONFIG.everyMin} min. Alert when ${CONFIG.minOutlets}+ outlets cover a story within ${CONFIG.windowMin} min.`);
  await tick();
  setInterval(tick, CONFIG.everyMin * MIN);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { parseFeed, tokens, sameStory, cluster, checkOnce };
