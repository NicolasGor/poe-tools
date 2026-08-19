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
 * Un file per archetipo, 1-6 MB.
 *
 * 🔴 **La prima versione non aveva nessuna cache, e non se ne accorgeva.**
 * Passavo a `fetch` l'opzione `cf: { cacheTtl }`, che e' **di Cloudflare**: su
 * Deno Deploy viene semplicemente ignorata. Risultato: ogni `/prezzo` riscaricava
 * i ~23 indici degli archetipi in tab, cioe' **decine di megabyte a click** — 1,5
 * GiB in entrata in un giorno, e una mail di Deno sul tetto del piano gratuito.
 * Ed era anche scortese verso il sito che ce li regala.
 *
 * Adesso la cache e' vera e a due livelli: la **Cache API** della piattaforma
 * (sopravvive ai riavvii dell'isolate) e una **mappa in memoria** davanti, che
 * evita anche di riparsare il JSON — che su Manyshot sono 5,6 MB.
 */
/* ⚠️ **Solo gli ultimi tre**, e non e' pigrizia: tenere in memoria i 23 indici
 * degli archetipi in tab significa centinaia di megabyte di JSON parsato contro i
 * 768 MiB dell'isolate, che infatti moriva con un 500 della piattaforma — non un
 * errore nostro, proprio il processo ucciso. La copia integrale sta nella Cache
 * API, che vive fuori dalla memoria; qui davanti restano i piu' recenti. */
const TIENI_IN_MEMORIA = 3;
const inMemoria = new Map();   // slug -> { quando, dati }
const spia = { scaricati: 0, dallaCache: 0, cacheApi: null, scritture: 0, erroriScrittura: null, letture: 0 };

function ricorda(slug, dati) {
  inMemoria.set(slug, { quando: Date.now(), dati });
  while (inMemoria.size > TIENI_IN_MEMORIA) inMemoria.delete(inMemoria.keys().next().value);
}

async function indice(slug) {
  const adesso = Date.now();
  const caldo = inMemoria.get(slug);
  if (caldo && adesso - caldo.quando < CACHE_SECONDI * 1000) return caldo.dati;

  const url = slug === "builder"
    ? `${FONTE}/data/allflame/mercenary-builder.json`
    : `${FONTE}/data/allflame/mercenary-build-${slug}.json`;

  let magazzinoCache = null;
  try { magazzinoCache = await caches.open("mercato"); spia.cacheApi = true; }
  catch (e) { spia.cacheApi = "assente: " + e.message; }

  if (magazzinoCache) {
    spia.letture++;
    const salvata = await magazzinoCache.match(url).catch((e) => { spia.erroriScrittura = "match: " + e.message; return null; });
    if (salvata) {
      const quando = Number(salvata.headers.get("x-preso-il") || 0);
      if (adesso - quando < CACHE_SECONDI * 1000) {
        const dati = await salvata.json();
        spia.dallaCache++;
        ricorda(slug, dati);
        return dati;
      }
    }
  }

  spia.scaricati++;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`indice ${slug}: HTTP ${r.status}`);
  const testo = await r.text();
  if (magazzinoCache) {
    try {
      await magazzinoCache.put(url, new Response(testo, {
        headers: { "content-type": "application/json", "x-preso-il": String(adesso) },
      }));
      spia.scritture++;
    } catch (e) { spia.erroriScrittura = "put: " + e.message; }
  }
  const dati = JSON.parse(testo);
  ricorda(slug, dati);
  return dati;
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

/**
 * Il mercenario tradotto negli indici del mercato, piu' il suo gruppo di
 * confronto. Sta a parte perche' lo usano in due: la prezzatura automatica e la
 * scheda con le spunte, che devono partire dagli stessi numeri o direbbero due
 * cose diverse sullo stesso pezzo.
 */
function contesto(build, warrant) {
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
  return { skillIdx, coppie, ignoti, pool };
}

function prezzaWarrant(build, warrant, divine, mirror, minimo) {
  const { skillIdx, coppie, ignoti, pool } = contesto(build, warrant);

  // peso: quanto ogni supporto alza la probabilita' di stare sopra 5 divine
  const soglia = 5 * divine;
  const quotaBase = pool.length
    ? pool.filter((r) => inChaos(r, divine, mirror) >= soglia).length / pool.length
    : 0;
  const pesi = new Map(), quanti = new Map();
  for (const c of coppie) {
    const con = pool.filter((r) => r.mappa.get(c.si)?.has(c.sj));
    quanti.set(c, con.length);
    if (con.length < 50 || !quotaBase) { pesi.set(c, 1); continue; }
    const sopra = con.filter((r) => inChaos(r, divine, mirror) >= soglia).length;
    pesi.set(c, (sopra / con.length) / quotaBase);
  }

  // 🔴 **A parita' di peso vince chi lascia piu' confronti.** Prima l'ordine fra
  // pesi indistinguibili (1,01 contro 1,01) lo decideva l'ordine di elenco, cioe'
  // il caso: entrava una gemma e le altre tre restavano fuori solo perche'
  // arrivavano dopo che la soglia era gia' stata consumata. Il peso si confronta
  // arrotondato a due decimali proprio per ammettere che sotto quella cifra la
  // differenza e' rumore.
  // 🔴 **Prima le gemme sul colpo principale.** Rilievo di Nicolas: spuntare una
  // gemma per skill non ha senso, perche' nessuno compra un mercenario per la sua
  // `Altar of Chaos`. Il peso da solo non lo sapeva: guardava la gemma senza
  // chiedersi su cosa stesse. Adesso le skill su cui il mercato mette gemme sul
  // serio vengono prima, e solo dopo le altre.
  const gemme = gemmePerSkill(build);
  const principale = (c) => (gemme[c.si] >= SOGLIA_PRINCIPALE ? 1 : 0);
  const arrotonda = (c) => Math.round(pesi.get(c) * 100);
  let corrente = pool;
  const passi = [];
  let scartato = null;
  for (const c of [...coppie].sort((a, b) =>
        principale(b) - principale(a) || arrotonda(b) - arrotonda(a) || quanti.get(b) - quanti.get(a))) {
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
    // l'id dello stash viaggia col prezzo: e' la chiave con cui il Worker pesca
    // la scheda gia' calcolata dal KV (`scheda:<id>`), senza ricostruire nulla
    id: warrant.id ?? null,
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
    // 🔴 Le gemme tornano indietro **tutte**, anche le skill senza supporti.
    // Filtrarle sembrava innocuo e non lo e': le skill sono cio' che definisce il
    // gruppo di confronto, quindi togliere Flame Dash e Smoke Mine allargava il
    // pool della scheda a 27.000 inserzioni contro le 2.500 della riga — due
    // numeri diversi sullo stesso mercenario, nella stessa pagina.
    gemme: warrant.skills,
    trade: linkTrade(build, skillIdx, passi, "Allflame"),
    chiave: chiaveCombinazione(linkTrade(build, skillIdx, passi, "Allflame")),
  };
}

/**
 * Quante gemme il mercato mette su ogni skill dell'archetipo, in media.
 *
 * 🔴 Separa il **colpo principale** dalle skill di servizio, ed e' il pezzo che
 * mancava al criterio del peso: quello guardava la gemma senza chiedersi su cosa
 * stesse, e finiva per spendere le spunte su `Bane` o `Altar of Chaos`. Misurato
 * il 19 agosto: sulle skill che portano il danno il mercato mette **4,6-4,7**
 * gemme, su quelle di servizio **2**, sulle aure **0** — separazione netta,
 * quindi la soglia sta comoda in mezzo.
 */
function gemmePerSkill(build) {
  if (build._gemme) return build._gemme;
  const somma = new Array(build.skills.length).fill(0);
  const viste = new Array(build.skills.length).fill(0);
  for (const r of build._righe) {
    for (const g of r.slot) {
      if (!g.length) continue;
      viste[g[0]]++; somma[g[0]] += g.length - 1;
    }
  }
  build._gemme = somma.map((n, i) => (viste[i] ? n / viste[i] : 0));
  return build._gemme;
}

const SOGLIA_PRINCIPALE = 3.5;

/** Quanto e' comune ogni skill nell'archetipo. Calcolata una volta e tenuta sul
 *  build: serve al link, dove una skill che ce l'hanno tutti costa un gruppo e
 *  non esclude nessuno. */
function diffusione(build) {
  if (build._diff) return build._diff;
  const conta = new Array(build.skills.length).fill(0);
  for (const r of build._righe) for (const g of r.slot) if (g.length) conta[g[0]]++;
  build._diff = conta.map((n) => n / build._righe.length);
  return build._diff;
}

/**
 * Il link di ricerca — stessa regola della pagina, e le misure che la giustificano:
 *
 * ⚠️ Il limite del trade **non e' lineare**: 6 gruppi con 3 gemme danno
 * `400 Query is too complex`, 6 gruppi con 1 gemma passano, 5 con 6 passano.
 * Tetto prudente: **5 gruppi**.
 *
 * 🔴 E i gruppi vanno spesi sulle skill **rare**: su Withertouch, `Bane` e
 * `Temporal Chains` stanno sul 100% delle inserzioni — due gruppi buttati.
 * Togliendoli e tenendo le rare, la ricerca torna mercenari con le stesse sei
 * skill invece di roba a 1 chaos con Blight al posto di Greater Soulrend.
 */
function linkTrade(build, skillIdx, passi, lega) {
  const MAX_GRUPPI = 5, MAX_GEMME = 6;
  const diff = diffusione(build);
  const conSupporto = new Set(passi.map((p) => p.si));

  const dentro = [];
  for (const i of [...skillIdx].sort((a, b) => diff[a] - diff[b])) {
    if (dentro.length >= MAX_GRUPPI) break;
    if (diff[i] >= 0.97 && !conSupporto.has(i)) continue;
    dentro.push(i);
  }
  if (dentro.length < 2) {
    for (const h of build.signature || []) {
      const i = build.skills.findIndex((x) => x.hash === h);
      if (i >= 0 && !dentro.includes(i) && dentro.length < MAX_GRUPPI) dentro.push(i);
    }
  }

  const perSkill = new Map(dentro.map((i) => [i, []]));
  let spazio = MAX_GEMME;
  for (const p of passi) {
    if (spazio <= 0) break;
    if (!perSkill.has(p.si)) continue;
    perSkill.get(p.si).push(p.sj);
    spazio--;
  }

  const stats = [...perSkill].map(([i, sups]) => ({
    type: "mercenary",
    filters: [{ id: `mercenary.skill_${build.skills[i].hash}` },
              ...sups.map((j) => ({ id: `mercenary.support_${build.supports[j].hash}` }))],
  }));
  const q = {
    query: {
      status: { option: "securable" },
      // 💡 **Il link nasce gia' filtrato sulle ultime 24 ore.** Idea di Nicolas, e
      // risolve a costo zero cio' che avevo provato a misurare bruciando il rate
      // limit del suo account: il filtro lo applica il trade quando si apre il
      // link, non noi in anticipo su 58 warrant.
      //
      // ⚠️ Serve perche' «31 inserzioni simili» conta anche chi e' fermo da
      // giorni: la mediana dell'eta' di quelle inserzioni e' **165 ore**, e su
      // 694 misurate solo 101 erano del giorno prima — il **15%**.
      //
      // 🔴 Ed e' anche il segnale: se aprendo il link i risultati sono pochi o
      // nessuno, quel mercenario non ha un mercato **adesso**. Sul trade il menu
      // «Listed» resta a portata di click, quindi allargare a tre giorni o a
      // «Any Time» costa un gesto — la scelta preimpostata non chiude niente.
      filters: { trade_filters: { filters: { indexed: { option: "1day" } } } },
      stats,
    },
    sort: { price: "asc" },
  };
  return `https://www.pathofexile.com/trade/search/${lega}?q=${encodeURIComponent(JSON.stringify(q))}`;
}

/**
 * La chiave di una combinazione: gli id dei filtri del suo link, ordinati.
 * Serve al campionatore, e deve essere **della combinazione, non del warrant**:
 * se vendi questo mercenario e ne trovi un altro uguale, la storia continua
 * invece di ricominciare.
 */
function chiaveCombinazione(urlTrade) {
  const q = JSON.parse(decodeURIComponent(urlTrade.split("?q=")[1]));
  const ids = q.query.stats.flatMap((g) => g.filters.map((f) => f.id)).sort();
  let h = 0;
  for (const c of ids.join("|")) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Il link per una combinazione di archetipo: le skill che portano le gemme
 * chieste, piu' le skill firma se resta spazio (tetto di 5 gruppi, misurato).
 */
function linkArchetipo(build, coppie, lega) {
  const perSkill = new Map();
  for (const [si, sj] of coppie) {
    if (si < 0 || sj < 0) continue;
    if (!perSkill.has(si)) perSkill.set(si, []);
    perSkill.get(si).push(sj);
  }
  for (const h of build.signature || []) {
    const i = build.skills.findIndex((x) => x.hash === h);
    if (i >= 0 && !perSkill.has(i) && perSkill.size < 5) perSkill.set(i, []);
  }
  const stats = [...perSkill].map(([i, sups]) => ({
    type: "mercenary",
    filters: [{ id: `mercenary.skill_${build.skills[i].hash}` },
              ...sups.map((j) => ({ id: `mercenary.support_${build.supports[j].hash}` }))],
  }));
  const q = {
    query: {
      status: { option: "securable" },
      // 💡 **Il link nasce gia' filtrato sulle ultime 24 ore.** Idea di Nicolas, e
      // risolve a costo zero cio' che avevo provato a misurare bruciando il rate
      // limit del suo account: il filtro lo applica il trade quando si apre il
      // link, non noi in anticipo su 58 warrant.
      //
      // ⚠️ Serve perche' «31 inserzioni simili» conta anche chi e' fermo da
      // giorni: la mediana dell'eta' di quelle inserzioni e' **165 ore**, e su
      // 694 misurate solo 101 erano del giorno prima — il **15%**.
      //
      // 🔴 Ed e' anche il segnale: se aprendo il link i risultati sono pochi o
      // nessuno, quel mercenario non ha un mercato **adesso**. Sul trade il menu
      // «Listed» resta a portata di click, quindi allargare a tre giorni o a
      // «Any Time» costa un gesto — la scelta preimpostata non chiude niente.
      filters: { trade_filters: { filters: { indexed: { option: "1day" } } } },
      stats,
    },
    sort: { price: "asc" },
  };
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
        // `chiave` e' un booleano di proposito: dice se il server ne ha una, non
        // quale sia. Senza, un "chiave sbagliata" e' indistinguibile da un
        // "variabile d'ambiente mai arrivata", e si tira a indovinare.
        return json({ ok: true, magazzino: m.tipo, warrant: s?.warrant?.length ?? 0,
                      sincronizzato: s?.quando ?? null, chiave: !!chiave, indici: { ...spia } });
      }

      // ⚠️ `/mercato/<archetipo>` serviva alla variante "calcola nel browser",
      // che non usiamo: rispondeva con l'indice intero, **megabyte a chiamata**.
      // Resta solo la testa, per chi vuole sapere quanto pesa senza scaricarlo.
      if (url.pathname.startsWith("/mercato/")) {
        const slug = url.pathname.slice("/mercato/".length);
        const b = await indice(slug);
        return json({ archetipo: b.build, inserzioni: b.listings.length,
                      skill: b.skills.length, supporti: b.supports.length,
                      nota: "l'indice intero non si serve piu': era traffico in uscita a megabyte" });
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

        /* 🔴 **La cache che conta e' questa.** Prima ogni click su «Aggiorna
         * prezzi» rifaceva il giro completo: ~23 indici scaricati e riparsati,
         * decine di megabyte. Qui il **risultato** — 77 KB di JSON — viene tenuto
         * compresso per `CACHE_SECONDI`, che e' anche il ritmo con cui la fonte
         * rigenera i suoi dati: premere due volte in dieci minuti non puo' dare
         * un numero diverso, quindi non ha senso pagarlo due volte.
         * ⚠️ Compresso perche' un valore KV sta sotto i 64 KiB: gzip lo porta a
         * ~15 KB, e senza compressione la scrittura fallirebbe in silenzio. */
        const chiaveCache = `prezzo:${minimo}:${(await m.leggi("stash"))?.quando || "-"}`;
        if (!corpo.warrant?.length && !corpo.forza) {
          const salvato = await m.leggi(chiaveCache);
          if (salvato && Date.now() - salvato.quando < CACHE_SECONDI * 1000) {
            const bytes = Uint8Array.from(atob(salvato.gz), (c) => c.charCodeAt(0));
            const testo = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
            return json({ ...JSON.parse(testo), dallaCache: true });
          }
        }
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
        const risposta = {
          lega: builder.league, generato_il: builder.generated_at,
          divine_in_chaos: +divine.toFixed(2), min_confronti: minimo,
          fonte: "https://xddbsns.com/mercenary-price-check.html",
          mancanti, warrant: fuori,
        };
        if (!corpo.warrant?.length) {
          try {
            const gz = await new Response(new Blob([JSON.stringify(risposta)]).stream()
              .pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
            await m.scrivi(chiaveCache, { quando: Date.now(), gz: btoa(String.fromCharCode(...new Uint8Array(gz))) });
          } catch (e) { /* se non entra nel KV si continua: e' una cache, non un dato */ }
        }
        return json(risposta);
      }

      // la scheda con le spunte: il pool di UN mercenario, ridotto all'osso
      // perche' il browser possa rifare il conto a ogni click senza tornare qui
      if (url.pathname === "/dettaglio" && req.method === "POST") {
        const corpo = await req.json();
        const w = corpo.warrant;
        if (!w || !w.build) return json({ errore: "manca warrant" }, 400);

        const builder = await indice("builder");
        const divine = builder.divineRate;
        const mirror = Number(corpo.mirror || 884);
        const build = await indice(slugDi(w.build));
        build._righe = decodifica(build.listings);

        // 🔴 Il pool della scheda parte piu' largo di quello del prezzo: contiene
        // le inserzioni che hanno le **skill principali** del mercenario, non
        // tutte. Serve a poter *togliere* una skill dalla ricerca e vedere il
        // prezzo che ne consegue — con il pool stretto si potrebbe solo
        // aggiungere, e la pagina direbbe un numero mentre il trade ne mostra un
        // altro. Le skill di servizio restano richieste di default: si rilassano
        // con un click, non per distrazione.
        const gemmeSkill = gemmePerSkill(build);
        const perNomeSkill = new Map(build.skills.map((x, i) => [x.name, i]));
        const skillIdxW = w.skills.map((g) => perNomeSkill.get(g.s)).filter((i) => i !== undefined);
        const principali = skillIdxW.filter((i) => gemmeSkill[i] >= SOGLIA_PRINCIPALE);
        const base = principali.length ? principali : skillIdxW;

        const { coppie } = contesto(build, w);
        let pool = [];
        for (const r of build._righe) {
          const mappa = new Map();
          for (const g of r.slot) if (g.length) mappa.set(g[0], new Set(g.slice(1)));
          let ok = true;
          for (const i of base) if (!mappa.has(i)) { ok = false; break; }
          if (ok) pool.push({ ...r, mappa });
        }
        // ⚠️ Un tetto c'e', e quando scatta lo si dice: oltre, il pool andrebbe
        // spedito a megabyte e la scheda diventerebbe lenta proprio sul Deck,
        // dove serve leggera.
        const TETTO = 30000;
        let rilassabili = true;
        if (pool.length > TETTO) {
          rilassabili = false;
          pool = pool.filter((r) => skillIdxW.every((i) => r.mappa.has(i)));
        }
        // ⚠️ Una maschera a 31 bit: un mercenario ne ha al massimo 30 (sei skill
        // per cinque supporti), ma se un giorno ne avesse di piu' il taglio va
        // detto, non subito in silenzio.
        const usate = coppie.slice(0, 31);
        const tagliate = coppie.length - usate.length;

        const soglia = 5 * divine;
        const quotaBase = pool.length
          ? pool.filter((r) => inChaos(r, divine, mirror) >= soglia).length / pool.length
          : 0;

        const supporti = usate.map((c, i) => {
          const con = pool.filter((r) => r.mappa.get(c.si)?.has(c.sj));
          const sopra = con.filter((r) => inChaos(r, divine, mirror) >= soglia).length;
          return {
            i, skill: c.skill, supporto: c.supporto,
            peso: (con.length < 50 || !quotaBase) ? 1 : +((sopra / con.length) / quotaBase).toFixed(2),
            skillHash: build.skills[c.si].hash, supHash: build.supports[c.sj].hash,
          };
        });

        // Ogni inserzione diventa [prezzo, maschera]: quali dei SUOI supporti ha.
        // Tutto il resto del mercato non serve a questa scheda, e mandarlo
        // significherebbe spedire megabyte per farci un filtro da nulla.
        const righe = pool.map((r) => {
          let m = 0, ms = 0;
          usate.forEach((c, i) => { if (r.mappa.get(c.si)?.has(c.sj)) m |= (1 << i); });
          skillIdxW.forEach((i, n) => { if (r.mappa.has(i)) ms |= (1 << n); });
          return [+inChaos(r, divine, mirror).toFixed(2), m, ms];
        });

        // Quanto ogni skill del mercenario e' comune su TUTTO l'archetipo. Serve
        // al link di ricerca: il trade ha un budget di complessita' stretto, e
        // chiedere una skill che ce l'hanno tutti spreca un gruppo senza
        // restringere niente. Le skill rare invece sono quelle che dicono «e' un
        // mercenario come il mio».
        const skillWarrant = [];
        for (const g of w.skills) {
          const i = build.skills.findIndex((x) => x.name === g.s);
          if (i < 0) continue;
          let quante = 0;
          for (const r of build._righe) if (r.slot.some((x) => x.length && x[0] === i)) quante++;
          // Quante gemme il mercato mette su questa skill, in media, fra le
          // inserzioni che ce l'hanno. E' il segnale che separa il **colpo
          // principale** dalle skill di servizio: su una skill di movimento
          // nessuno spende supporti, sul danno sì.
          let gemme = 0, viste = 0;
          for (const r of build._righe) {
            const slot = r.slot.find((x) => x.length && x[0] === i);
            if (!slot) continue;
            viste++; gemme += slot.length - 1;
          }
          skillWarrant.push({ nome: g.s, hash: build.skills[i].hash,
                              bit: skillIdxW.indexOf(i),
                              principale: gemmeSkill[i] >= SOGLIA_PRINCIPALE,
                              diffusione: +(quante / build._righe.length).toFixed(3),
                              gemmeMedie: viste ? +(gemme / viste).toFixed(2) : 0,
                              gemmeSue: (g.sup || []).length });
        }

        return json({
          nome: w.name, build: build.build, divine: +divine.toFixed(2),
          lega: builder.league, signature: build.signature || [],
          tradeTypes: build.tradeTypes || [], skill: skillWarrant,
          supporti, righe, tagliate, rilassabili,
        });
      }

      /* ------------------------------------------------------- campionatore
       * 🔴 **Perche' non lo fa il server da solo.** Da sloggati il trade accetta
       * **un solo gruppo** `mercenary` per query: le nostre ne hanno quattro o
       * cinque, quindi qui arriverebbero solo 400. Le ricerche le esegue il
       * segnalibro, dentro pathofexile.com, dove la sessione e' viva — e con la
       * stessa mano leggera dello stash: qualche query, distanziate.
       *
       * ⚠️ **Cosa misura davvero.** Non le vendite: le **sparizioni**. Una
       * inserzione che non c'e' piu' e' stata comprata, tolta o riprezzata, e le
       * tre cose non si distinguono. E' comunque l'unico segnale di movimento che
       * un libro di inserzioni concede — l'eta' (`indexed`) dice solo da quanto
       * qualcosa e' fermo.
       */
      if (url.pathname === "/campione/piano") {
        if (!chiave || url.searchParams.get("k") !== chiave) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const m = await magazzino(env);
        const s = (await m.leggi("stash")) || { warrant: [] };
        const quanti = Math.min(Number(url.searchParams.get("quanti") || 8), 20);

        const builder = await indice("builder");
        const divine = builder.divineRate, mirror = 884;
        const perSlug = new Map();
        for (const w of s.warrant) {
          const sl = slugDi(w.build || "");
          if (!perSlug.has(sl)) perSlug.set(sl, []);
          perSlug.get(sl).push(w);
        }
        const prezzati = [];
        for (const [sl, gruppo] of perSlug) {
          let build;
          try { build = await indice(sl); } catch { continue; }
          build._righe = decodifica(build.listings);
          for (const w of gruppo) prezzati.push(prezzaWarrant(build, w, divine, mirror, 30));
        }
        /* 🔴 **Prima quelle gia' fotografate.** Il piano sceglieva gli otto piu'
         * preziosi del momento: ma il valore cambia a ogni giro, quindi cambiavano
         * le combinazioni e ogni fotografia restava la prima — la storia non si
         * accumulava mai. Ora la continuita' viene prima del valore: si rifotografa
         * cio' che si sta gia' seguendo, e si riempie con i piu' preziosi rimasti. */
        prezzati.sort((a, b) => b.prezzo - a.prezzo);
        const seguite = (await m.leggi("campioni:elenco")) || [];
        const giaSeguite = prezzati.filter((w) => seguite.includes(w.chiave));
        const nuove = prezzati.filter((w) => !seguite.includes(w.chiave));
        const piano = [...giaSeguite, ...nuove].slice(0, quanti);
        return json({ piano: piano.map((w) => ({
          chiave: w.chiave, nome: w.nome, build: w.build, valore: w.prezzo, trade: w.trade,
        })) });
      }

      if (url.pathname === "/campione" && req.method === "POST") {
        if (!chiave || url.searchParams.get("k") !== chiave) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const m = await magazzino(env);
        const corpo = await req.json();
        const adesso = new Date().toISOString();
        const esito = [];
        for (const c of corpo.campioni || []) {
          if (!c.chiave || !Array.isArray(c.inserzioni)) continue;
          const vecchio = await m.leggi("campione:" + c.chiave);
          const ids = c.inserzioni.map((x) => x.id);
          let sparite = null, ore = null;
          if (vecchio) {
            const prima = new Set(vecchio.ids);
            sparite = vecchio.ids.filter((x) => !ids.includes(x)).length;
            ore = +((new Date(adesso) - new Date(vecchio.quando)) / 3600000).toFixed(1);
          }
          const storia = [...(vecchio?.storia || []), ...(sparite === null ? [] : [{ quando: adesso, ore, sparite, viste: vecchio.ids.length }])].slice(-12);
          await m.scrivi("campione:" + c.chiave, {
            chiave: c.chiave, nome: c.nome, build: c.build, quando: adesso,
            totale: c.totale ?? null, ids, prezzi: c.inserzioni.map((x) => x.prezzo), storia,
          });
          esito.push({ chiave: c.chiave, nome: c.nome, viste: ids.length, sparite, ore });
        }
        // l'elenco serve al piano per rifotografare le stesse combinazioni: senza,
        // ogni giro ricomincerebbe da capo e la storia non crescerebbe mai
        const elenco = (await m.leggi("campioni:elenco")) || [];
        for (const c of esito) if (!elenco.includes(c.chiave)) elenco.push(c.chiave);
        await m.scrivi("campioni:elenco", elenco.slice(-40));
        return json({ ok: true, campioni: esito });
      }

      if (url.pathname === "/liquidita") {
        const m = await magazzino(env);
        const s = (await m.leggi("stash")) || { warrant: [] };
        // niente elenco completo del KV: si chiede per chiave, che la pagina ha gia'
        const chiavi = (url.searchParams.get("chiavi") || "").split(",").filter(Boolean).slice(0, 40);
        const fuori = {};
        for (const k of chiavi) {
          const v = await m.leggi("campione:" + k);
          if (!v) continue;
          const storia = v.storia || [];
          const totOre = storia.reduce((n, x) => n + (x.ore || 0), 0);
          const totSparite = storia.reduce((n, x) => n + (x.sparite || 0), 0);
          fuori[k] = { nome: v.nome, quando: v.quando, viste: v.ids.length, storia,
                       spariteOra: totOre ? +(totSparite / totOre * 24).toFixed(1) : null };
        }
        return json({ campioni: fuori, warrantInStash: s.warrant.length });
      }

      /* ----------------------------------------------------------- panorama
       * Quali archetipi hanno davvero un mercato caro, e con quali gemme.
       * Nasce da una domanda di Nicolas — *«ci sono solo queste combinazioni?»* —
       * a cui la griglia della wiki non puo' rispondere: viene da **una** fonte,
       * e gli archetipi sono **35**. Qui invece si guarda il libro delle
       * inserzioni, uno per uno.
       *
       * Si chiede a fette (`?da=&a=`) perche' scaricare 35 indici in una volta
       * significa decine di megabyte e qualche minuto: meglio dieci per volta e
       * poter vedere il risultato mentre arriva.
       */
      if (url.pathname === "/panorama") {
        const builder = await indice("builder");
        const divine = builder.divineRate, mirror = 884;
        const da = Number(url.searchParams.get("da") || 0);
        const a = Number(url.searchParams.get("a") || 6);
        const fuori = [];
        for (const b of builder.builds.slice(da, a)) {
          let build;
          try { build = await indice(b.slug); } catch { continue; }
          const righe = decodifica(build.listings);
          const prezzi = righe.map((r) => inChaos(r, divine, mirror));
          const sopra1 = prezzi.filter((p) => p >= divine).length;
          const sopra5 = prezzi.filter((p) => p >= 5 * divine).length;
          const sopra20 = prezzi.filter((p) => p >= 20 * divine).length;

          // Le gemme che il mercato paga su questo archetipo: quante volte chi
          // ce l'ha finisce sopra 5 divine, rispetto alla media.
          // ⚠️ In **un passaggio solo**: la prima versione rifaceva la scansione
          // per ogni gemma — 147.000 inserzioni per 34 supporti su Manyshot — e
          // la richiesta non tornava piu'.
          const quota = sopra5 / righe.length;
          const con = new Array(build.supports.length).fill(0);
          const caro = new Array(build.supports.length).fill(0);
          const soglia5 = 5 * divine;
          for (let i = 0; i < righe.length; i++) {
            const visti = new Set();
            for (const g of righe[i].slot) for (let k = 1; k < g.length; k++) visti.add(g[k]);
            const su = prezzi[i] >= soglia5;
            for (const j of visti) { con[j]++; if (su) caro[j]++; }
          }
          const pesi = [];
          if (quota) {
            for (let j = 0; j < con.length; j++) {
              if (con[j] >= 200) pesi.push({ gemma: build.supports[j].name, viste: con[j], peso: +((caro[j] / con[j]) / quota).toFixed(2) });
            }
          }
          pesi.sort((x, y) => y.peso - x.peso);

          /* **Le combinazioni che pagano.** Non una sola coppia: tutte quelle
           * fra le sei gemme piu' pesanti, ordinate per quanto chiedono.
           *
           * Il conto sta in un passaggio: a ogni inserzione si associa una
           * maschera di sei bit (quali di quelle gemme ha) e il prezzo finisce nel
           * secchio di quella maschera. Da 64 secchi si ricava qualunque coppia
           * senza rileggere le 147.000 righe una volta per combinazione.
           *
           * ⚠️ Ogni gemma porta con se' **la skill su cui sta piu' spesso**: un
           * supporto sul trade si puo' chiedere solo dentro al gruppo della sua
           * skill, e attaccarlo a quella sbagliata darebbe una ricerca vuota.
           */
          const cima = pesi.slice(0, 6);
          const bit = cima.map((g) => build.supports.findIndex((x) => x.name === g.gemma));
          const skillDi = bit.map((j) => {
            const conta = new Map();
            for (const r of righe) for (const g of r.slot) {
              if (!g.length) continue;
              for (let k = 1; k < g.length; k++) if (g[k] === j) conta.set(g[0], (conta.get(g[0]) || 0) + 1);
            }
            let top = -1, quanti = 0;
            for (const [sk, n] of conta) if (n > quanti) { quanti = n; top = sk; }
            return top;
          });

          const secchi = new Map();
          for (let i = 0; i < righe.length; i++) {
            let m = 0;
            for (const g of righe[i].slot) for (let k = 1; k < g.length; k++) {
              const n = bit.indexOf(g[k]);
              if (n >= 0) m |= (1 << n);
            }
            if (!secchi.has(m)) secchi.set(m, []);
            secchi.get(m).push(prezzi[i]);
          }

          const combinazioni = [];
          for (let a1 = 0; a1 < cima.length; a1++) {
            for (let a2 = a1 + 1; a2 < cima.length; a2++) {
              const voluto = (1 << a1) | (1 << a2);
              const dentro = [];
              for (const [m, lista] of secchi) if ((m & voluto) === voluto) dentro.push(...lista);
              if (dentro.length < 30) continue;
              dentro.sort((x, y) => x - y);
              combinazioni.push({
                gemme: [cima[a1].gemma, cima[a2].gemma],
                skill: [build.skills[skillDi[a1]]?.name, build.skills[skillDi[a2]]?.name],
                inserzioni: dentro.length,
                // 🔴 Il **piu' economico** serve quanto la mediana, e vanno detti
                // insieme: su questo mercato la distribuzione e' sfondata — la
                // stessa combinazione ha il primo a 50 chaos e la meta' del libro
                // sopra 50 divine. Dare solo la mediana faceva sembrare la pagina
                // in disaccordo col trade, che ordina per prezzo crescente.
                floor: Math.round(dentro[0]),
                mediana: Math.round(dentro[Math.floor(dentro.length / 2)]),
                alto: Math.round(dentro[Math.floor(dentro.length * 0.9)]),
                trade: linkArchetipo(build, [[skillDi[a1], bit[a1]], [skillDi[a2], bit[a2]]], builder.league),
              });
            }
          }
          combinazioni.sort((x, y) => y.mediana - x.mediana);
          const buono = combinazioni[0] || null;

          fuori.push({
            archetipo: build.build, slug: b.slug, inserzioni: righe.length,
            sopra1d: +(100 * sopra1 / righe.length).toFixed(1),
            sopra5d: +(100 * sopra5 / righe.length).toFixed(1),
            sopra20d: +(100 * sopra20 / righe.length).toFixed(1),
            // ⚠️ Niente `Math.max(...prezzi)`: con 147.000 valori lo spread
            // sfonda lo stack e la rotta risponde "Maximum call stack size
            // exceeded" invece del dato.
            massimo: Math.round(prezzi.reduce((m, x) => (x > m ? x : m), 0)),
            gemmeChePagano: pesi.slice(0, 5), buono, combinazioni: combinazioni.slice(0, 5),
          });
        }
        return json({ da, a, totale: builder.builds.length, archetipi: fuori });
      }

      return json({ errore: "rotta sconosciuta", rotte: ["/stato", "/mercato/<archetipo>", "/stash", "/prezzo", "/dettaglio", "/campione/piano", "/campione", "/liquidita"] }, 404);
    } catch (e) {
      return json({ errore: String(e && e.message || e) }, 502);
    }
  },
};
