/**
 * controlla-barre — verifica che la barra di navigazione sia identica ovunque,
 * **sottomenu compresi**.
 *
 * **Perche' serve.** La barra e' copiata dentro **ogni** `index.html`: undici
 * copie della stessa lista. Quando nasce uno strumento e' facile aggiungerne la
 * voce solo dove si sta lavorando — ed e' successo davvero con Warrant, che per
 * giorni si e' visto **solo dalla homepage**. Non e' un errore che si nota
 * guardando una pagina: bisogna confrontarle fra loro, che e' esattamente cio'
 * che un uomo non fa e un controllo si'.
 *
 *   node controlla-barre.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";

const pagine = ["index.html", ...readdirSync(".")
  .filter((d) => statSync(d).isDirectory() && !d.startsWith(".") && d !== "server")
  .map((d) => `${d}/index.html`)]
  .filter((p) => { try { readFileSync(p); return true; } catch { return false; } });

// 🔴 Non basta leggere gli `<a>`: da quando "Build" e' un **gruppo**, la sua
// etichetta sta in un `<button>` e le due voci figlie in un pannello **fuori**
// da `.nav-link`. Un controllo che guardasse solo i link direbbe "identiche"
// anche su una pagina a cui manca meta' sottomenu — cioe' proprio dove il
// difetto e' piu' facile da introdurre, perche' il pannello e' in un altro
// punto del file.
const voci = (p) => {
  const t = readFileSync(p, "utf8");
  const barra = t.match(/<div class="nav-link">([\s\S]*?)\n    <\/div>/);
  if (!barra) return null;
  const prime = [...barra[1].matchAll(/>([^<>]+)<\/(?:a|button)>/g)]
    .map((x) => x[1].trim());
  const giu = [...t.matchAll(/<div class="nav-giu"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g)]
    .flatMap((g) => [...g[1].matchAll(/>([^<>]+)<\/a>/g)].map((x) => `  ↳ ${x[1].trim()}`));
  return [...prime, ...giu];
};

const mappa = new Map(pagine.map((p) => [p, voci(p)]));
const riferimento = mappa.get("index.html");
if (!riferimento) { console.error("🔴 la homepage non ha una barra: non ho un riferimento"); process.exit(1); }

let rotte = 0;
for (const [p, v] of mappa) {
  if (!v) { console.error(`🔴 ${p}: nessuna barra`); rotte++; continue; }
  const mancano = riferimento.filter((x) => !v.includes(x));
  const inPiu = v.filter((x) => !riferimento.includes(x));
  if (mancano.length || inPiu.length) {
    rotte++;
    console.error(`🔴 ${p}` +
      (mancano.length ? `\n     mancano: ${mancano.join(", ")}` : "") +
      (inPiu.length ? `\n     in piu': ${inPiu.join(", ")}` : ""));
  }
}

if (rotte) {
  console.error(`\n${rotte} pagine su ${mappa.size} hanno una barra diversa dalla homepage.`);
  process.exit(1);
}
console.log(`✅ ${mappa.size} barre identiche: ${riferimento.join(" · ")}`);
