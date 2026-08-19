/**
 * genera-panorama — calcola una volta sola cio' che la pagina Warrant mostra a
 * tutti, e lo deposita come file statico.
 *
 * **Perche' esiste.** La griglia degli archetipi, le combinazioni che pagano e i
 * pesi delle gemme sono **uguali per chiunque apra la pagina**: non dipendono da
 * cosa ha Nicolas in stash. Farli ricalcolare a un server a ogni visita
 * significava scaricare da xddbsns ~35 indici da 1-6 MB per rispondere sempre la
 * stessa cosa — ed e' il traffico che il 19 agosto 2026 ha esaurito il tetto del
 * piano gratuito di Deno e sospeso il servizio con `503 USAGE_EXCEEDED`.
 *
 * Qui il conto lo fa una GitHub Action, che committa `warrant/panorama.json`
 * (~180 KB). La pagina lo legge **dalla stessa origine** di GitHub Pages, quindi
 * senza CORS e senza server: la meta' pubblica dello strumento non ha piu' un
 * limite di consumo da sfondare.
 *
 * Riusa `warrant-api.js` chiamandone la rotta `/panorama`, invece di ricopiarne
 * la matematica: una seconda copia dei pesi e delle combinazioni sarebbe una
 * seconda cosa da tenere allineata, e prima o poi direbbero due numeri diversi.
 *
 *   node --max-old-space-size=4096 server/genera-panorama.mjs [--fetta N] [--uscita PATH]
 */
import mod from "./warrant-api.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const arg = (nome, difetto) => {
  const i = process.argv.indexOf(nome);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : difetto;
};

/* A fette perche' `/panorama` tiene in memoria l'indice parsato dell'archetipo
 * in corso: su Manyshot sono 149.000 inserzioni. La LRU del server ne trattiene
 * tre, ma chiedere 35 archetipi in una richiesta sola vuol dire tenerne aperti
 * altrettanti nello stack della risposta. Sei per volta e' passato in prova. */
const FETTA = Number(arg("--fetta", 6));
const USCITA = resolve(process.cwd(), arg("--uscita", "warrant/panorama.json"));

const chiedi = async (da, a) => {
  const r = await mod.fetch(new Request(`http://locale/panorama?da=${da}&a=${a}`));
  const d = await r.json();
  if (!r.ok || d.errore) throw new Error(`fetta ${da}-${a}: ${d.errore || "HTTP " + r.status}`);
  return d;
};

const t0 = Date.now();
const testa = await chiedi(0, 0);          // costa solo il builder.json (4,5 KB): dice quanti sono
const totale = testa.totale;
console.log(`archetipi da calcolare: ${totale}`);

const archetipi = [];
for (let da = 0; da < totale; da += FETTA) {
  const a = Math.min(da + FETTA, totale);
  const d = await chiedi(da, a);
  archetipi.push(...d.archetipi);
  console.log(`  ${da}-${a}: ${d.archetipi.length} calcolati (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

/* 🔴 `/panorama` salta in silenzio gli archetipi il cui indice non si scarica
 * (`catch { continue }`). Senza questo confronto un file a meta' sarebbe
 * indistinguibile da uno intero, ed e' il tipo di errore che non si vede finche'
 * qualcuno non cerca l'archetipo mancante. Se ne manca qualcuno lo si dice, e la
 * Action fallisce invece di committare un buco. */
const mancanti = totale - archetipi.length;
if (mancanti > 0) {
  console.error(`\n🔴 ${mancanti} archetipi su ${totale} non hanno risposto: non committo un panorama parziale.`);
  console.error(`   presenti: ${archetipi.map((a) => a.slug).join(", ")}`);
  process.exit(1);
}

const fuori = {
  generato: new Date().toISOString(),
  fonte: "https://xddbsns.com/data/allflame/",
  totale,
  archetipi,
};

mkdirSync(dirname(USCITA), { recursive: true });
writeFileSync(USCITA, JSON.stringify(fuori));
const peso = JSON.stringify(fuori).length;
console.log(`\n✅ ${archetipi.length} archetipi in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${USCITA} (${(peso / 1024).toFixed(0)} KB)`);
