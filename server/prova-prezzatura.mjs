/** Banco di prova della prezzatura: **vecchio metodo contro nuovo**, sugli stessi
 *  warrant e sulla stessa cache di mercato.
 *
 *  **Perche' serve.** Cambiare come si costruisce il gruppo di confronto sposta
 *  ogni prezzo della pagina, e «mi sembra piu' giusto» non e' una verifica. Qui
 *  i due metodi girano fianco a fianco sui warrant veri: si vede **quanti**
 *  cambiano, **di quanto**, e soprattutto **da che parte** — un metodo che sposta
 *  tutto nella stessa direzione e' sospetto quanto uno che non sposta niente.
 *
 *  Il vecchio metodo e' ricostruito qui dentro (`vecchioPool`), non ripescato da
 *  git: e' una differenza di **una riga** — il pool chiede *tutte* le skill
 *  invece delle sole portanti — e tenerla qui rende il confronto leggibile.
 *
 *  Uso:
 *      node server/prova-prezzatura.mjs [quanti]
 *
 *  Ingresso: strumenti/dati/cache-warrant/*.json  (l'indice di mercato)
 *            strumenti/dati/warrant-stash-4.json  (i nostri warrant)
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodifica, prezzaWarrant, skillPortanti } from "./warrant-api.js";

// fileURLToPath e non .pathname: il percorso ha uno spazio ("Wiki AI") e
// .pathname lo lascia come %20, che readdirSync non risolve.
const RADICE = fileURLToPath(new URL("../../", import.meta.url));
const CACHE = RADICE + "strumenti/dati/cache-warrant/";
const DIVINE = 199, MIRROR = 220, MINIMO = 30;

const mercato = {};
for (const f of readdirSync(CACHE).filter((x) => x.startsWith("warrant-cache-"))) {
  Object.assign(mercato, JSON.parse(readFileSync(CACHE + f, "utf8")));
}
const warrant = JSON.parse(readFileSync(RADICE + "strumenti/dati/warrant-stash-4.json", "utf8"));
const slug = (n) => n.toLowerCase().replace(/'/g, "").replace(/ /g, "-");

const chaos0 = (n, DIV) => n >= DIV ? `${(n / DIV).toFixed(1)}d` : `${Math.round(n)}c`;

const chaos = (n) => n >= DIVINE ? `${(n / DIVINE).toFixed(1)}d` : `${Math.round(n)}c`;
const righe = [];
for (const w of warrant) {
  const b = mercato[slug(w.build.replace(/^Infamous /, ""))];
  if (!b) continue;
  if (!b._righe) b._righe = decodifica(b.listings);
  const vecchio = prezzaWarrant(b, w, DIVINE, MIRROR, MINIMO, { tutteLeSkill: true });
  const nuovo = prezzaWarrant(b, w, DIVINE, MIRROR, MINIMO);
  righe.push({ nome: w.name, vecchio, nuovo });
}

const val = (r) => r.quinto ?? r.prezzo;
console.log(`${righe.length} warrant · prezzo = quinto prezzo del gruppo di confronto (quello che la pagina mostra)\n`);
console.log("nome                          |  pool vecchio>nuovo |  prezzo vecchio>nuovo |  x  | stretto (n)");
console.log("-".repeat(104));
let su = 0, giu = 0, uguali = 0;
const fattori = [];
for (const x of righe.sort((a, b) => val(b.nuovo) - val(a.nuovo))) {
  const a = val(x.vecchio), b = val(x.nuovo);
  if (b > a * 1.05) su++; else if (b < a * 0.95) giu++; else uguali++;
  fattori.push(b / (a || 1));
  const s = x.nuovo.stretto;
  console.log(
    `${x.nome.slice(0, 29).padEnd(29)} | ${String(x.vecchio.pool).padStart(8)} > ${String(x.nuovo.pool).padEnd(8)} | ` +
    `${chaos(a).padStart(9)} > ${chaos(b).padEnd(9)} | ${(b / (a || 1)).toFixed(1).padStart(4)} | ` +
    (s ? `${chaos(s.mediana)} (${s.confronti})${s.trade ? "" : "  \u26a0 senza link"}` : "\u2014"));
}
fattori.sort((p, q) => p - q);
console.log("-".repeat(104));
console.log(`piu' caro su ${su} \u00b7 piu' economico su ${giu} \u00b7 uguale su ${uguali} \u00b7 ` +
            `fattore mediano ${fattori[Math.floor(fattori.length / 2)].toFixed(2)}x`);
