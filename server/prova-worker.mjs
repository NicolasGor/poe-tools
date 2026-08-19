/** Banco di prova del Worker con un KV finto in memoria.
 *  Verifica soprattutto una cosa: che la pagina funzioni **senza chiave**. */
import worker from "./worker.js";
import { readFileSync } from "node:fs";

const dati = new Map();
const env = {
  CHIAVE: "segreto-di-prova",
  GITHUB_REPO: "NicolasGor/poe-tools",
  GITHUB_TOKEN: null,          // assente di proposito: /aggiorna deve dirlo, non esplodere
  WARRANT: {
    async get(k, tipo) {
      if (!dati.has(k)) return null;
      const v = dati.get(k);
      if (tipo === "json") return JSON.parse(v);
      if (tipo === "stream") return new Blob([v]).stream();
      return v;
    },
    async put(k, v) { dati.set(k, v); },
  },
};

const prezzi = JSON.parse(readFileSync(process.argv[2], "utf8"));
const unId = Object.keys(prezzi.schede)[0];
dati.set("prezzi", JSON.stringify({ generato: prezzi.generato, stashDel: prezzi.stashDel, ...prezzi.prezzi, falliti: prezzi.falliti }));
dati.set(`scheda:${unId}`, JSON.stringify(prezzi.schede[unId]));
dati.set("stash", JSON.stringify({ warrant: prezzi.prezzi.warrant, quando: "2026-08-19T10:00:00Z" }));
dati.set("stato:prezzi", JSON.stringify({ generato: prezzi.generato, warrant: prezzi.prezzi.warrant.length, falliti: 0, mancanti: [], lega: prezzi.prezzi.lega }));
dati.set("stato:stash", JSON.stringify({ warrant: prezzi.prezzi.warrant.length, quando: "2026-08-19T10:00:00Z" }));

const chiama = async (rotta, opz = {}) => {
  const t0 = process.cpuUsage();
  const r = await worker.fetch(new Request("http://w" + rotta, opz), env);
  const testo = await r.text();
  const ms = (process.cpuUsage(t0).user + process.cpuUsage(t0).system) / 1000;
  let d = null; try { d = JSON.parse(testo); } catch {}
  return { stato: r.status, kb: testo.length / 1024, ms, d };
};

const righe = [];
const prova = async (etichetta, rotta, opz, atteso) => {
  const e = await chiama(rotta, opz);
  const ok = e.stato === atteso;
  righe.push({ etichetta, stato: e.stato, atteso, kb: e.kb, ms: e.ms, ok });
  return e;
};

// scaldata: la primissima invocazione paga la compilazione JIT, non la rotta
await chiama("/stato"); await chiama("/prezzo");

console.log("=== SENZA CHIAVE (deve funzionare da qualsiasi dispositivo) ===");
await prova("GET /stato",            "/stato", {}, 200);
await prova("GET /prezzo",           "/prezzo", {}, 200);
await prova("GET /dettaglio?id=",    `/dettaglio?id=${unId}`, {}, 200);
await prova("GET /stash",            "/stash", {}, 200);
await prova("GET /liquidita",        "/liquidita?chiavi=a,b", {}, 200);
await prova("GET /dettaglio ignoto", "/dettaglio?id=zzz", {}, 404);
for (const r of righe) console.log(`  ${r.ok ? "✅" : "🔴"} ${r.etichetta.padEnd(24)} ${String(r.stato).padStart(3)} (atteso ${r.atteso})  ${r.kb.toFixed(0).padStart(4)} KB  CPU ${r.ms.toFixed(1)} ms`);

righe.length = 0;
console.log("\n=== SCRITTURE: devono pretendere la chiave ===");
await prova("POST /stash senza k",   "/stash", { method: "POST", body: "{}" }, 403);
await prova("POST /stash con k",     "/stash?k=segreto-di-prova", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ warrant: [{id:"x"}] }) }, 200);
await prova("piano senza k",         "/campione/piano", {}, 403);
await prova("piano con k",           "/campione/piano?k=segreto-di-prova", {}, 200);
for (const r of righe) console.log(`  ${r.ok ? "✅" : "🔴"} ${r.etichetta.padEnd(24)} ${String(r.stato).padStart(3)} (atteso ${r.atteso})  CPU ${r.ms.toFixed(1)} ms`);

console.log("\n=== /aggiorna senza token configurato ===");
const a = await chiama("/aggiorna", { method: "POST" });
console.log(`  ${a.stato === 500 ? "✅" : "🔴"} risponde ${a.stato}: ${a.d?.errore}`);

console.log("\n=== il numero che decide: CPU contro i 10 ms del piano gratuito ===");
const pesante = await chiama(`/dettaglio?id=${unId}`);
console.log(`  la scheda piu' grossa servita: ${pesante.kb.toFixed(0)} KB in ${pesante.ms.toFixed(2)} ms di CPU`);
console.log(`  ${pesante.ms <= 10 ? "✅ dentro i 10 ms" : "🔴 sfondati"}`);
