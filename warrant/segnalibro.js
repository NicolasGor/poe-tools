/**
 * Il codice del segnalibro «Sincronizza warrant».
 *
 * **Perche' e' un file e non e' dentro al segnalibro.** Un bookmarklet si porta
 * dentro il codice nel momento in cui lo trascini: ogni correzione avrebbe voluto
 * un nuovo trascinamento, e la prima volta e' gia' bastata a farne trascinare uno
 * rotto. Il segnalibro adesso e' due righe che **scaricano questo file** e lo
 * eseguono: si aggiorna da se'.
 *
 * ⚠️ Gira **dentro pathofexile.com**, ed e' l'unico posto da cui si puo':
 * l'endpoint dello stash e quello di ricerca vogliono la sessione, e nessuna
 * pagina di un altro dominio puo' leggerli (CORS). Qui non passa nessuna
 * credenziale: la sessione resta nel browser, al nostro server arriva solo il
 * risultato.
 *
 * Riceve `A` (indirizzo del server) e `K` (la chiave di scrittura), e fa due cose:
 *   1. **legge i warrant** di tutte le tab e li manda a `/stash`;
 *   2. **fotografa il mercato** delle combinazioni piu' preziose e manda gli id
 *      delle inserzioni a `/campione`, che al giro dopo dira' quante sono sparite.
 */

const LEGA = "Allflame";
const PAUSA_TAB = 600;        // fra una tab e l'altra
const PAUSA_RICERCA = 3500;   // fra una ricerca di mercato e l'altra: mano leggera
const QUANTE_COMBINAZIONI = 8;

const dormi = (ms) => new Promise((r) => setTimeout(r, ms));

async function leggiStash(account) {
  const q = (p) => fetch("/character-window/get-stash-items?" + p, { credentials: "include" }).then((r) => r.json());
  const tabs = await q(`league=${LEGA}&tabs=1&tabIndex=0&accountName=${encodeURIComponent(account)}&realm=pc`);
  const fuori = [];
  for (const tab of tabs.tabs || []) {
    let d;
    try { d = await q(`league=${LEGA}&tabIndex=${tab.i}&accountName=${encodeURIComponent(account)}&realm=pc`); }
    catch (e) { continue; }
    for (const it of d.items || []) {
      if (!/Mercenary Warrant/.test(it.baseType || "")) continue;
      const val = (n) => { const x = (it.properties || []).find((p) => p.name === n); return x ? x.values[0][0] : null; };
      fuori.push({
        id: it.id,
        name: (it.properties[0] || { values: [["?"]] }).values[0][0],
        build: val("Build"), level: val("Mercenary Level"), tab: tab.n,
        skills: (it.mercenarySkills || []).map((s) => ({ s: s.name, sup: (s.supports || []).map((x) => x.name) })),
      });
    }
    await dormi(PAUSA_TAB);
  }
  return fuori;
}

/** Una fotografia del libro di una combinazione: chi c'e' adesso, e a quanto. */
async function fotografa(voce) {
  const q = JSON.parse(decodeURIComponent(voce.trade.split("?q=")[1]));
  const r = await fetch(`/api/trade/search/${LEGA}`, {
    method: "POST", headers: { "content-type": "application/json" },
    credentials: "include", body: JSON.stringify(q),
  });
  if (!r.ok) return null;   // 400 troppo complessa o 429: si salta, non si insiste
  const s = await r.json();
  const ids = (s.result || []).slice(0, 10);
  const base = { chiave: voce.chiave, nome: voce.nome, build: voce.build, totale: s.total, inserzioni: [] };
  if (!ids.length) return base;
  const d = await (await fetch(`/api/trade/fetch/${ids.join(",")}?query=${s.id}`, { credentials: "include" })).json();
  base.inserzioni = (d.result || []).filter(Boolean).map((x) => ({
    id: x.id,
    prezzo: x.listing && x.listing.price ? `${x.listing.price.amount} ${x.listing.price.currency}` : null,
    indexed: x.listing && x.listing.indexed,
  }));
  return base;
}

export default async function (A, K) {
  const account = (document.body.innerText.match(/Logged in as ([^\s]+)/) || [])[1];
  if (!account) { alert("Apri pathofexile.com da loggato, poi riclicca."); return; }

  const warrant = await leggiStash(account);
  const r = await fetch(`${A}/stash?k=${encodeURIComponent(K)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ warrant }),
  });
  if (!r.ok) { alert("Errore nel salvare i warrant: " + (await r.text())); return; }

  let nota = "";
  try {
    const piano = (await (await fetch(`${A}/campione/piano?k=${encodeURIComponent(K)}&quanti=${QUANTE_COMBINAZIONI}`)).json()).piano || [];
    const campioni = [];
    for (const voce of piano) {
      const foto = await fotografa(voce);
      if (foto) campioni.push(foto);
      await dormi(PAUSA_RICERCA);
    }
    if (campioni.length) {
      const c = await (await fetch(`${A}/campione?k=${encodeURIComponent(K)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ campioni }),
      })).json();
      const conStoria = (c.campioni || []).filter((x) => x.sparite !== null);
      nota = conStoria.length
        ? "\n\n" + conStoria.map((x) => `${x.nome}: ${x.sparite} su ${x.viste} sparite in ${x.ore} h`).join("\n")
        : "\n\nPrima fotografia del mercato: il movimento si vede dal prossimo giro.";
    }
  } catch (e) {
    nota = "\n\nCampionamento saltato: " + e.message;
  }
  alert(`${warrant.length} warrant sincronizzati.${nota}`);
}
