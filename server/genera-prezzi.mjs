/**
 * genera-prezzi — prezza i warrant di Nicolas fuori dal server.
 *
 * **Perche' non lo fa piu' il Worker.** Misurato il 19 agosto 2026 su 39 warrant
 * in 28 archetipi: `/prezzo` costa **2.774 ms di CPU** e `/dettaglio` **206 ms in
 * media**, contro i **10 ms per invocazione** del piano gratuito di Cloudflare
 * Workers — che valgono anche per i Cron Trigger, non solo per le richieste HTTP.
 * Non e' un limite che si aggira scrivendo meglio: e' due ordini di grandezza.
 *
 * Il conto si sposta quindi su una GitHub Action, dove non c'e' limite di CPU, e
 * al Worker resta di **servire il risultato dal KV** (~1 ms). La stessa mossa gia'
 * fatta per il panorama pubblico, applicata alla meta' privata.
 *
 * ⚠️ **Gira solo quando Nicolas clicca**, non a orologio: e' lui che ha chiesto di
 * tenere l'aggiornamento a comando. Niente cron significa pochi giri al giorno,
 * quindi qualunque piano gratuito basta e il repo puo' restare privato.
 *
 * **Niente di privato passa da git.** La lista dei warrant si legge dal KV di
 * Cloudflare, dove la scrive il segnalibro, e il risultato ci torna: il
 * repository non la vede mai.
 *
 *   node --max-old-space-size=4096 server/genera-prezzi.mjs --stash <file.json> --uscita <file.json>
 *   node --max-old-space-size=4096 server/genera-prezzi.mjs           # stash dal KV, risultato nel KV
 */
import mod from "./warrant-api.js";
import { writeFileSync, readFileSync } from "node:fs";

const arg = (nome, difetto) => {
  const i = process.argv.indexOf(nome);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : difetto;
};

const MIN = Number(arg("--min", 30));

/* ------------------------------------------------------------------ magazzino
 * Non si parla col KV di Cloudflare direttamente ma **attraverso il Worker**.
 * 💡 Scrivere nel KV avrebbe richiesto un token API di Cloudflare in piu' da
 * creare e custodire; passando dal Worker basta la `CHIAVE` che gia' esiste.
 * E lo stash si **legge senza credenziali**, perche' le letture sono aperte.
 */
const API = (process.env.WARRANT_API || "https://api.poewarrant.workers.dev").replace(/\/$/, "");
const CHIAVE = process.env.WARRANT_CHIAVE || "";

/* --------------------------------------------------- i warrant gia' in vendita
 * 🔴 **Il problema che risolve.** Un item affidato allo scambio **non sta piu' in
 * una tab**, quindi esce dalla lettura dello stash e sparisce dalla pagina: dalla
 * tabella, dal totale e dal «da buttare», senza che niente lo dica. Il 27 agosto
 * il totale e' passato a 208 d **con i quattro pezzi piu' cari fuori** — sembrava
 * cresciuto, aveva cambiato significato. E da quella sparizione avevo dedotto
 * quattro vendite mai avvenute.
 *
 * ✅ **Perche' puo' farlo la Action e non la pagina.** La ricerca per account
 * risponde **senza autenticazione** — a differenza della lettura dello stash
 * (403 da sloggati) e delle query sui mercenari (rifiutate per complessita'). Ma
 * dal browser e' impossibile: `www.pathofexile.com/api/trade` **non manda gli
 * header CORS**, e una fetch dalla pagina pubblicata muore in `Failed to fetch`
 * (provato il 27 agosto). Qui invece non c'e' browser, quindi non c'e' CORS.
 *
 * ⚠️ **Serve uno User-Agent vero**: GGG rifiuta quello di default. E i dettagli
 * si chiedono a **lotti da 10**.
 *
 * ⚠️ **Se non arriva, non e' un errore fatale**: i prezzi valgono comunque, e la
 * pagina mostra la riga solo quando c'e' qualcosa. */
const ACCOUNT = process.env.WARRANT_ACCOUNT || "";
const UA = "poe-tools/1.0 (+https://nicolasgor.github.io/poe-tools/) warrant-in-vendita";

async function inVendita(lega) {
  if (!ACCOUNT) return null;
  try {
    const r = await fetch(`https://www.pathofexile.com/api/trade/search/${encodeURIComponent(lega)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({
        query: { status: { option: "securable" }, stats: [{ type: "and", filters: [] }],
                 filters: { trade_filters: { filters: { account: { input: ACCOUNT } } } } },
        sort: { price: "asc" },
      }),
    });
    if (!r.ok) return { errore: `ricerca HTTP ${r.status}` };
    const s = await r.json();
    const ids = s.result || [];
    const fuori = [];
    for (let i = 0; i < ids.length; i += 10) {
      const lotto = ids.slice(i, i + 10).join(",");
      const d = await fetch(`https://www.pathofexile.com/api/trade/fetch/${lotto}?query=${s.id}`,
                            { headers: { "user-agent": UA } });
      if (!d.ok) break;
      for (const x of ((await d.json()).result || []).filter(Boolean)) {
        const base = x.item?.baseType || x.item?.typeLine || "";
        if (!/Mercenary Warrant/i.test(base)) continue;   // le mappe e i gioielli non c'entrano
        fuori.push({
          nome: (x.item?.properties || [])[0]?.values?.[0]?.[0] || x.item?.name || "?",
          build: (x.item?.properties || []).find((p) => p.name === "Build")?.values?.[0]?.[0] || null,
          quanto: x.listing?.price?.amount ?? null,
          valuta: x.listing?.price?.currency ?? null,
          indexed: x.listing?.indexed ?? null,
        });
      }
      await new Promise((r) => setTimeout(r, 2000));   // mano leggera, come fra le tab
    }
    return { totale: s.total ?? 0, warrant: fuori, quando: new Date().toISOString() };
  } catch (e) {
    return { errore: String(e).slice(0, 200) };
  }
}

async function deposita(nome, valore) {
  const r = await fetch(`${API}/deposita?k=${encodeURIComponent(CHIAVE)}&chiave=${encodeURIComponent(nome)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(valore),
  });
  if (!r.ok) throw new Error(`deposito di ${nome}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function leggiRemoto(rotta) {
  const r = await fetch(`${API}${rotta}`);
  if (!r.ok) throw new Error(`${rotta}: HTTP ${r.status}`);
  return r.json();
}

/* -------------------------------------------------------------------- lo stash */
const daFile = arg("--stash", null);
let stash;
if (daFile) {
  const letto = JSON.parse(readFileSync(daFile, "utf8"));
  stash = Array.isArray(letto) ? { warrant: letto, quando: null } : letto;
} else {
  if (!CHIAVE) {
    console.error("🔴 Senza --stash serve WARRANT_CHIAVE per depositare il risultato.");
    process.exit(1);
  }
  stash = await leggiRemoto("/stash");   // aperto: nessuna credenziale per leggere
}
const warrant = stash?.warrant || [];
if (!warrant.length) {
  console.error("🔴 Lo stash e' vuoto: nessun warrant da prezzare.");
  console.error("   Apri pathofexile.com da loggato e clicca il segnalibro, poi riprova.");
  process.exit(1);
}
console.log(`warrant: ${warrant.length} | archetipi distinti: ${new Set(warrant.map((w) => w.build)).size}`);

const chiedi = async (rotta, corpo) => {
  const r = await mod.fetch(new Request(`http://locale${rotta}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo),
  }));
  const d = await r.json();
  if (!r.ok || d.errore) throw new Error(`${rotta}: ${d.errore || "HTTP " + r.status}`);
  return d;
};

const t0 = Date.now();

/* ------------------------------------------------------------------- i prezzi */
const prezzi = await chiedi("/prezzo", { warrant, min: MIN });
console.log(`prezzi: ${prezzi.warrant.length} calcolati (${((Date.now() - t0) / 1000).toFixed(0)}s)` +
            (prezzi.mancanti?.length ? ` ⚠️ archetipi senza indice: ${prezzi.mancanti.join(", ")}` : ""));

/* ---------------------------------------------------------------- le schede
 * ⚠️ **Una chiave per warrant, non un valore unico** — ed e' una scelta obbligata
 * dal lato del Worker. Tutte insieme le schede fanno **5,9 MB**: per servirne una
 * da 106 KB il Worker dovrebbe parsare l'intero valore, cioe' ~60-100 ms di CPU
 * contro i **10 ms** che il piano gratuito concede. Separate, invece, il Worker
 * puo' rigirare i byte del KV senza mai parsarli: CPU ~0.
 *
 * Il prezzo di questa scelta sono **~41 scritture a giro** contro il tetto di
 * 1.000 al giorno del KV gratuito, cioe' **~24 aggiornamenti al giorno**. Sta
 * larga solo perche' l'aggiornamento e' **a comando**: con un timer ogni 30
 * minuti non ci starebbe. Se un giorno stesse stretta, R2 non ha tetto
 * giornaliero (10 GB e 1M di scritture al mese sul gratuito).
 *
 * 🔴 Una scheda che fallisce non ferma le altre e **viene dichiarata**: se
 * sparisse in silenzio, in pagina si vedrebbe una scheda vuota senza sapere se il
 * mercenario non ha pool o se il calcolo e' andato storto.
 */
const schede = {};
const falliti = [];
for (const w of warrant) {
  try {
    schede[w.id] = await chiedi("/dettaglio", { warrant: w });
  } catch (e) {
    falliti.push({ nome: w.name, build: w.build, errore: e.message });
  }
}
console.log(`schede: ${Object.keys(schede).length}/${warrant.length}` +
            (falliti.length ? ` 🔴 ${falliti.length} fallite` : ""));
for (const f of falliti) console.error(`  🔴 ${f.nome} (${f.build}): ${f.errore}`);

const generato = new Date().toISOString();
const risultato = { generato, stashDel: stash?.quando ?? null, min_confronti: MIN, prezzi, schede, falliti };

const pesoTot = JSON.stringify(risultato).length;
const pesoMax = Math.max(0, ...Object.values(schede).map((s) => JSON.stringify(s).length));
console.log(`\n✅ pronto in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${(pesoTot / 1024 / 1024).toFixed(1)} MB in tutto, scheda piu' grossa ${(pesoMax / 1024).toFixed(0)} KB`);

/* 🔴 Il tetto per valore del KV e' 25 MiB e vale per **ogni chiave**: la scheda
 * piu' grossa misurata e' 477 KB, quindi il margine e' enorme — ma se un
 * archetipo nuovo lo sfondasse la scrittura fallirebbe, e va detto prima. */
if (pesoMax > 24 * 1024 * 1024) {
  console.error("🔴 Una scheda supera i 25 MiB che il KV accetta per valore.");
  process.exit(1);
}

const uscita = arg("--uscita", null);
if (uscita) { writeFileSync(uscita, JSON.stringify(risultato)); console.log(`   scritto in ${uscita}`); }

if (CHIAVE && !daFile) {
  // 🔴 **Le schede prima, il riassunto per ultimo.** La pagina si accorge che
  // l'aggiornamento e' finito guardando `stato:prezzi.generato`: se arrivasse
  // per primo, mostrerebbe "fatto" mentre meta' delle schede non c'e' ancora.
  for (const [id, scheda] of Object.entries(schede)) await deposita(`scheda:${id}`, scheda);
  const vendita = await inVendita(prezzi.lega);
  if (vendita?.warrant) console.log(`in vendita: ${vendita.warrant.length} warrant su ${vendita.totale} inserzioni`);
  else if (vendita?.errore) console.log(`⚠️ in vendita: ${vendita.errore}`);
  await deposita("prezzi", { generato, stashDel: stash?.quando ?? null, min_confronti: MIN,
                             ...prezzi, falliti, inVendita: vendita });
  // il riassunto per /stato, che altrimenti dovrebbe riparsare 70 KB a ogni
  // interrogazione — e la pagina la interroga ogni pochi secondi mentre aspetta
  await deposita("stato:prezzi", {
    generato, stashDel: stash?.quando ?? null,
    warrant: prezzi.warrant.length, falliti: falliti.length,
    mancanti: prezzi.mancanti ?? [], lega: prezzi.lega,
  });
  /* 🔴 `chiestoIl` si **conserva**, non si azzera: e' quello su cui il Worker
   * misura i 10 minuti di attesa. Azzerarlo qui vorrebbe dire che appena la Action
   * finisce — 30 secondi — si puo' già richiedere tutto da capo, cioe' proprio la
   * raffica che l'attesa esiste per evitare. Qui si dice solo che e' finita. */
  const attesa = await leggiRemoto("/stato").then((s) => s.aggiornamento || {}).catch(() => ({}));
  await deposita("aggiornamento", { ...attesa, stato: "fatto", finitoIl: generato });
  console.log(`   depositate ${Object.keys(schede).length + 3} chiavi tramite ${API}`);
}
