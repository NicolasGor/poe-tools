/**
 * warrant-api — il pezzo di server della pagina Warrant.
 *
 * **Perche' esiste.** La pagina e' statica su GitHub Pages e da li' due cose sono
 * impossibili, misurate il 18 agosto 2026 e non dedotte:
 *
 *   1. **Leggere l'indice di mercato di xddbsns.com**: il loro server risponde ma
 *      **senza intestazione CORS** (una fetch `no-cors` torna `opaque`, cioe'
 *      arriva e il browser non lascia leggerla). Serve qualcuno che la richieda
 *      da fuori dal browser e la ripassi con le intestazioni giuste.
 *   2. **Tenere i warrant fra un dispositivo e l'altro**: il Mac sincronizza, lo
 *      Steam Deck legge. Un `localStorage` e' per-dispositivo e non lo fa.
 *
 * **Cosa NON fa, e non e' una scelta.** Non consuma il *public stash river* di
 * GGG come fa xddbsns: quello richiede lo scope `service:psapi`, che richiede un
 * client confidenziale, e la pagina degli sviluppatori di GGG dice
 * *«We are currently unable to process new applications»*. Non e' replicabile a
 * nessun costo, quindi i prezzi restano loro e il resto e' nostro.
 *
 * **E non tocca nessuna credenziale.** Lo stash lo legge il *bookmarklet*, dentro
 * pathofexile.com dove la sessione e' gia' viva: qui arriva solo il risultato in
 * JSON. Nessun POESESSID, nessun token, ne' in transito ne' a riposo.
 *
 * Gira uguale su Deno Deploy e su Cloudflare Workers: entrambi chiamano
 * `export default { fetch }`. Il magazzino cambia sotto, l'interfaccia no.
 */

const FONTE = "https://xddbsns.com";
const CACHE_SECONDI = 600;   // il loro indice si aggiorna ogni ~10 minuti: chiedere piu' spesso e' solo traffico loro sprecato

const intestazioni = (extra = {}) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "content-type": "application/json; charset=utf-8",
  ...extra,
});

const json = (dati, stato = 200, extra = {}) =>
  new Response(JSON.stringify(dati), { status: stato, headers: intestazioni(extra) });

/* ------------------------------------------------------------------ magazzino
 * Deno Deploy ha `Deno.openKv()`, Cloudflare ha un binding KV. Senza nessuno dei
 * due si tiene in memoria: funziona per provare in locale e **si perde a ogni
 * riavvio**, il che e' meglio di fallire in silenzio facendo credere il contrario.
 */
const memoria = new Map();

async function magazzino(env) {
  if (globalThis.Deno?.openKv) {
    const kv = await globalThis.Deno.openKv();
    return {
      leggi: async (k) => (await kv.get([k])).value,
      scrivi: async (k, v) => { await kv.set([k], v); },
      tipo: "deno-kv",
    };
  }
  if (env?.WARRANT) {
    return {
      leggi: async (k) => JSON.parse((await env.WARRANT.get(k)) || "null"),
      scrivi: async (k, v) => env.WARRANT.put(k, JSON.stringify(v)),
      tipo: "cf-kv",
    };
  }
  return {
    leggi: async (k) => memoria.get(k) ?? null,
    scrivi: async (k, v) => { memoria.set(k, v); },
    tipo: "memoria-volatile",
  };
}

/* -------------------------------------------------------------- indice mercato
 * Un file per archetipo, 1-6 MB. Si tiene nella cache della piattaforma per
 * `CACHE_SECONDI`: senza, ogni click di ogni pagina si scaricherebbe di nuovo
 * qualche megabyte dal loro server, che e' un modo veloce di essere sgraditi.
 */
async function indice(slug) {
  const url = slug === "builder"
    ? `${FONTE}/data/allflame/mercenary-builder.json`
    : `${FONTE}/data/allflame/mercenary-build-${slug}.json`;
  const r = await fetch(url, { cf: { cacheTtl: CACHE_SECONDI, cacheEverything: true } });
  if (!r.ok) throw new Error(`indice ${slug}: HTTP ${r.status}`);
  return r.json();
}

/* ----------------------------------------------------------------- prezzatura
 * Stessa logica di strumenti/misure/warrant-prezzo.py, e le ragioni stanno li'
 * per esteso. In due righe: le skill non si rilassano mai, i supporti si
 * aggiungono **in ordine di peso** (non di quanto alzano il floor, che premia le
 * gemme rare e misura la dimensione del campione), e ci si ferma prima di
 * scendere sotto `minimo` confronti.
 */
const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CODICE = new Map([...ALFABETO].map((c, i) => [c, i]));

function decodifica(listings) {
  return listings.map(([cur, val, packed, lvl]) => ({
    cur, val, livello: 83 + (lvl || 0),
    slot: packed.split("|").filter(Boolean).map((g) => [...g].map((c) => CODICE.get(c))),
  }));
}

const inChaos = (r, divine, mirror) =>
  r.cur === 0 ? r.val : r.cur === 1 ? r.val * divine : r.val * divine * mirror;

const floorDi = (pool, divine, mirror) =>
  pool.length ? Math.min(...pool.map((r) => inChaos(r, divine, mirror))) : null;

function quintoDi(pool, divine, mirror) {
  if (pool.length < 5) return null;
  return +pool.map((r) => inChaos(r, divine, mirror)).sort((a, b) => a - b)[4].toFixed(2);
}

function prezzaWarrant(build, warrant, divine, mirror, minimo) {
  const perSkill = new Map(build.skills.map((s, i) => [s.name, i]));
  const perSup = new Map(build.supports.map((s, i) => [s.name, i]));

  const skillIdx = [], coppie = [], ignoti = [];
  for (const s of warrant.skills) {
    const i = perSkill.get(s.s);
    if (i === undefined) { ignoti.push(s.s); continue; }
    skillIdx.push(i);
    for (const nome of s.sup || []) {
      const j = perSup.get(nome);
      if (j === undefined) { ignoti.push(nome); continue; }
      coppie.push({ si: i, sj: j, skill: s.s, supporto: nome });
    }
  }

  // pool: le inserzioni che portano tutte le skill del nostro mercenario
  const voluti = new Set(skillIdx);
  const pool = [];
  for (const r of build._righe) {
    const mappa = new Map();
    for (const g of r.slot) if (g.length) mappa.set(g[0], new Set(g.slice(1)));
    let ok = true;
    for (const v of voluti) if (!mappa.has(v)) { ok = false; break; }
    if (ok) pool.push({ ...r, mappa });
  }

  // peso: quanto ogni supporto alza la probabilita' di stare sopra 5 divine
  const soglia = 5 * divine;
  const quotaBase = pool.length
    ? pool.filter((r) => inChaos(r, divine, mirror) >= soglia).length / pool.length
    : 0;
  const pesi = new Map();
  for (const c of coppie) {
    const con = pool.filter((r) => r.mappa.get(c.si)?.has(c.sj));
    if (con.length < 50 || !quotaBase) { pesi.set(c, 1); continue; }
    const sopra = con.filter((r) => inChaos(r, divine, mirror) >= soglia).length;
    pesi.set(c, (sopra / con.length) / quotaBase);
  }

  // si stringe in ordine di peso, finche' la soglia dei confronti regge
  let corrente = pool;
  const passi = [];
  let scartato = null;
  for (const c of [...coppie].sort((a, b) => pesi.get(b) - pesi.get(a))) {
    const filtrato = corrente.filter((r) => r.mappa.get(c.si)?.has(c.sj));
    const f = floorDi(filtrato, divine, mirror);
    if (f === null) continue;
    if (filtrato.length < minimo) {
      if (!scartato) scartato = { ...c, confronti: filtrato.length, floor: +f.toFixed(2) };
      continue;
    }
    corrente = filtrato;
    passi.push({
      skill: c.skill, supporto: c.supporto, peso: +pesi.get(c).toFixed(2),
      confronti: corrente.length, floor: +f.toFixed(2), si: c.si, sj: c.sj,
    });
  }

  const floorFinale = floorDi(corrente, divine, mirror) ?? 0;
  return {
    nome: warrant.name,
    build: build.build,
    infamous: !!warrant.infamous,
    livello: warrant.level,
    pool: pool.length,
    prezzo: +floorFinale.toFixed(2),
    confronti: corrente.length,
    quinto: quintoDi(corrente, divine, mirror),
    passi: passi.map(({ si, sj, ...resto }) => resto),
    oltre: scartato && { skill: scartato.skill, supporto: scartato.supporto, confronti: scartato.confronti, floor: scartato.floor },
    ignoti: [...new Set(ignoti)],
    trade: linkTrade(build, passi, "Allflame"),
  };
}

/**
 * Il link di ricerca. ⚠️ Un gruppo `mercenary` per ogni skill e' troppo: il trade
 * risponde `400 Query is too complex`, e da sloggati ne accetta **uno solo**. Si
 * mandano le skill che vincolano un supporto piu' le skill firma, e i supporti si
 * fermano ai primi quattro per peso.
 */
function linkTrade(build, passi, lega) {
  const perSkill = new Map();
  for (const p of passi.slice(0, 4)) {
    if (!perSkill.has(p.si)) perSkill.set(p.si, []);
    perSkill.get(p.si).push(p.sj);
  }
  const stats = [...perSkill].map(([i, sups]) => ({
    type: "mercenary",
    filters: [{ id: `mercenary.skill_${build.skills[i].hash}` },
              ...sups.map((j) => ({ id: `mercenary.support_${build.supports[j].hash}` }))],
  }));
  const vincolate = new Set([...perSkill.keys()].map((i) => build.skills[i].hash));
  for (const h of build.signature || []) {
    if (!vincolate.has(h)) stats.push({ type: "mercenary", filters: [{ id: `mercenary.skill_${h}` }] });
  }
  const q = { query: { status: { option: "securable" }, stats }, sort: { price: "asc" } };
  return `https://www.pathofexile.com/trade/search/${lega}?q=${encodeURIComponent(JSON.stringify(q))}`;
}

const slugDi = (nome) => nome.replace(/^Infamous /, "").toLowerCase().replace(/'/g, "").replace(/ /g, "-");

/* --------------------------------------------------------------------- rotte */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const chiave = (env && env.CHIAVE) || globalThis.Deno?.env?.get?.("CHIAVE") || "";

    if (req.method === "OPTIONS") return new Response(null, { headers: intestazioni() });

    try {
      // stato: serve a vedere da fuori se il magazzino e' quello vero
      if (url.pathname === "/stato") {
        const m = await magazzino(env);
        const s = await m.leggi("stash");
        return json({ ok: true, magazzino: m.tipo, warrant: s?.warrant?.length ?? 0, sincronizzato: s?.quando ?? null });
      }

      // l'indice grezzo, per chi vuole calcolare nel browser
      if (url.pathname.startsWith("/mercato/")) {
        const slug = url.pathname.slice("/mercato/".length);
        return json(await indice(slug), 200, { "cache-control": `public, max-age=${CACHE_SECONDI}` });
      }

      // i warrant sincronizzati dal bookmarklet
      if (url.pathname === "/stash") {
        const m = await magazzino(env);
        if (req.method === "POST") {
          if (!chiave || url.searchParams.get("k") !== chiave) return json({ errore: "chiave mancante o sbagliata" }, 403);
          const corpo = await req.json();
          if (!Array.isArray(corpo.warrant)) return json({ errore: "manca warrant[]" }, 400);
          await m.scrivi("stash", { warrant: corpo.warrant, quando: new Date().toISOString(), tab: corpo.tab ?? null });
          return json({ ok: true, salvati: corpo.warrant.length });
        }
        return json((await m.leggi("stash")) || { warrant: [], quando: null });
      }

      // prezzatura: il calcolo sta qui perche' scaricare 5 MB per archetipo sul
      // Deck sarebbe l'unica parte lenta di tutta la catena
      if (url.pathname === "/prezzo" && req.method === "POST") {
        const corpo = await req.json();
        const minimo = Number(corpo.min || 30);
        const m = await magazzino(env);
        const warrants = corpo.warrant?.length ? corpo.warrant : ((await m.leggi("stash")) || {}).warrant || [];
        if (!warrants.length) return json({ errore: "nessun warrant: sincronizza lo stash" }, 400);

        const builder = await indice("builder");
        const divine = builder.divineRate;
        const mirror = Number(corpo.mirror || 884);

        const perSlug = new Map();
        for (const w of warrants) {
          const s = slugDi(w.build || "");
          if (!perSlug.has(s)) perSlug.set(s, []);
          perSlug.get(s).push(w);
        }

        const fuori = [], mancanti = [];
        for (const [s, gruppo] of perSlug) {
          let build;
          try { build = await indice(s); } catch { mancanti.push(gruppo[0].build); continue; }
          build._righe = decodifica(build.listings);
          for (const w of gruppo) {
            fuori.push(prezzaWarrant(build, { ...w, infamous: (w.build || "").startsWith("Infamous ") }, divine, mirror, minimo));
          }
        }
        fuori.sort((a, b) => b.prezzo - a.prezzo);
        return json({
          lega: builder.league, generato_il: builder.generated_at,
          divine_in_chaos: +divine.toFixed(2), min_confronti: minimo,
          fonte: "https://xddbsns.com/mercenary-price-check.html",
          mancanti, warrant: fuori,
        });
      }

      return json({ errore: "rotta sconosciuta", rotte: ["/stato", "/mercato/<archetipo>", "/stash", "/prezzo"] }, 404);
    } catch (e) {
      return json({ errore: String(e && e.message || e) }, 502);
    }
  },
};
