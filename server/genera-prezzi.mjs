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
 * L'API REST del KV di Cloudflare. Sta qui e non in una libreria perche' sono
 * due chiamate: una dipendenza npm per questo sarebbe piu' codice da fidarsi che
 * codice da scrivere.
 */
const CF = {
  account: process.env.CF_ACCOUNT_ID,
  namespace: process.env.CF_KV_NAMESPACE_ID,
  token: process.env.CF_API_TOKEN,
};
const kvAttivo = !!(CF.account && CF.namespace && CF.token);
const kvUrl = (chiave) =>
  `https://api.cloudflare.com/client/v4/accounts/${CF.account}/storage/kv/namespaces/${CF.namespace}/values/${encodeURIComponent(chiave)}`;

async function kvLeggi(chiave) {
  const r = await fetch(kvUrl(chiave), { headers: { authorization: `Bearer ${CF.token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`KV leggi ${chiave}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function kvScrivi(chiave, valore) {
  const corpo = new FormData();
  corpo.append("value", JSON.stringify(valore));
  corpo.append("metadata", "{}");
  const r = await fetch(kvUrl(chiave), {
    method: "PUT",
    headers: { authorization: `Bearer ${CF.token}` },
    body: corpo,
  });
  if (!r.ok) throw new Error(`KV scrivi ${chiave}: HTTP ${r.status} ${await r.text()}`);
}

/* -------------------------------------------------------------------- lo stash */
const daFile = arg("--stash", null);
let stash;
if (daFile) {
  const letto = JSON.parse(readFileSync(daFile, "utf8"));
  stash = Array.isArray(letto) ? { warrant: letto, quando: null } : letto;
} else {
  if (!kvAttivo) {
    console.error("🔴 Senza --stash servono CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID e CF_API_TOKEN.");
    process.exit(1);
  }
  stash = await kvLeggi("stash");
}
const warrant = stash?.warrant || [];
if (!warrant.length) {
  console.error("🔴 Nessun warrant: lo stash non e' mai stato sincronizzato dal segnalibro.");
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

if (kvAttivo && !daFile) {
  // l'indice per ultimo: finche' non c'e', la pagina serve ancora il giro
  // precedente invece di mostrare meta' aggiornamento
  for (const [id, scheda] of Object.entries(schede)) await kvScrivi(`scheda:${id}`, scheda);
  await kvScrivi("prezzi", { generato, stashDel: stash?.quando ?? null, min_confronti: MIN, ...prezzi, falliti });
  // il riassunto per /stato, che altrimenti dovrebbe riparsare 70 KB a ogni
  // interrogazione — e la pagina la interroga ogni pochi secondi mentre aspetta
  await kvScrivi("stato:prezzi", {
    generato, stashDel: stash?.quando ?? null,
    warrant: prezzi.warrant.length, falliti: falliti.length,
    mancanti: prezzi.mancanti ?? [], lega: prezzi.lega,
  });
  /* 🔴 `chiestoIl` si **conserva**, non si azzera: e' quello su cui il Worker
   * misura i 10 minuti di attesa. Azzerarlo qui vorrebbe dire che appena la Action
   * finisce — 30 secondi — si puo' già richiedere tutto da capo, cioe' proprio la
   * raffica che l'attesa esiste per evitare. Qui si dice solo che e' finita. */
  const attesa = (await kvLeggi("aggiornamento")) || {};
  await kvScrivi("aggiornamento", { ...attesa, stato: "fatto", finitoIl: generato });
  console.log(`   scritte ${Object.keys(schede).length + 3} chiavi nel KV di Cloudflare`);
}
