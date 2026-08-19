# server/ — il pezzo che la pagina statica non può fare da sola

`warrant-api.js` serve la pagina [warrant/](../warrant/). Fa tre cose e basta:

| Rotta | Cosa fa |
|---|---|
| `POST /prezzo` | scarica l'indice di mercato di xddbsns.com, prezza i warrant sincronizzati e torna una risposta piccola |
| `POST /stash?k=…` | riceve i warrant dal segnalibro (chiave richiesta) |
| `GET /stash`, `GET /stato` | li rilegge, e dice quando è stata l'ultima sincronizzazione |
| `GET /mercato/<archetipo>` | l'indice grezzo, con le intestazioni CORS, per chi preferisce calcolare nel browser |
| `POST /dettaglio` | il pool di **un** mercenario ridotto a `[prezzo, maschera]` (~40 KB): la scheda con le spunte lo filtra in memoria, senza tornare qui a ogni click |
| `GET /campione/piano?k=…` | le otto combinazioni più preziose da fotografare, con la query di ricerca già pronta |
| `POST /campione?k=…` | riceve le fotografie del segnalibro e calcola **quante inserzioni sono sparite** dal giro prima |
| `GET /liquidita?chiavi=…` | la storia delle sparizioni per combinazione |

**Perché non basta la pagina.** Misurato, non dedotto: xddbsns.com risponde
**senza intestazione CORS** (una fetch `no-cors` torna `opaque`), quindi il
browser scarica e non lascia leggere. E un `localStorage` è per-dispositivo: non
fa vedere allo Steam Deck ciò che il Mac ha sincronizzato.

🔴 **Perché il campionatore non gira sul server.** Da sloggati il trade accetta
**un solo gruppo `mercenary`** per query, e le nostre ne hanno quattro o cinque:
da qui tornerebbero solo `400`. Le ricerche le esegue il **segnalibro**, dentro
pathofexile.com, dove la sessione è viva — otto combinazioni per giro, distanziate
di 3,5 secondi.

⚠️ **E cosa misura: le sparizioni, non le vendite.** Un'inserzione che non c'è più
può essere stata comprata, tolta o riprezzata, e le tre non si distinguono. Ma un
libro dove non sparisce niente non sta vendendo, e questo lo dice — mentre l'età
(`indexed`) dice solo da quanto qualcosa è fermo.

⚠️ **Nessuna credenziale passa di qui.** Lo stash lo legge il segnalibro *dentro*
pathofexile.com, dove la sessione è già viva; qui arriva solo il JSON dei warrant.
La `CHIAVE` serve a impedire che un estraneo sovrascriva la lista, non a proteggere
un segreto di gioco.

## Dov'è, adesso

**Cloudflare Workers, piano gratuito** — Worker `warrant`, entrypoint
`server/worker.js`, magazzino **Workers KV** (binding `WARRANT`).

⚠️ **Deno Deploy è stato abbandonato il 19 agosto 2026.** Non per antipatia: da lì
passavano **~110 MB di indici di mercato per ogni prezzatura a freddo**, e il
piano gratuito si è spento con `503 USAGE_EXCEEDED`. Su Cloudflare la **banda non
è fatturata** su nessuno dei due piani, cioè quel modo di fallire lì non esiste.
💡 La sincronizzazione dello stash, che sembrava il costo, erano **pochi KB**: il
peso era tutto nel dato di mercato.

## Chi fa cosa, e perché è diviso così

| Pezzo | Dove gira | Mestiere |
|---|---|---|
| `worker.js` | Cloudflare Workers (gratis) | **non calcola niente**: legge e scrive il KV, e fa partire la Action |
| `genera-prezzi.mjs` | GitHub Actions, su `repository_dispatch` | prezza i warrant e deposita nel KV |
| `genera-panorama.mjs` | GitHub Actions, una volta al giorno | la griglia pubblica → `warrant/panorama.json` |
| `warrant-api.js` | **solo** dentro le Action | la matematica: prezzatura, pesi, combinazioni |

🔴 **Il calcolo non può stare nel Worker, ed è una misura, non un'opinione.** Il
piano gratuito concede **10 ms di CPU per invocazione** — e valgono anche per i
Cron Trigger, non solo per le richieste HTTP. Misurato il 19 agosto 2026 su 39
warrant in 28 archetipi:

| | CPU | contro i 10 ms |
|---|---:|---|
| `/prezzo` | **2.774 ms** | 277× |
| `/dettaglio` (media) | **206 ms** | 21× |
| il Worker che serve dal KV | **0,1-0,3 ms** | ✅ 30-100× sotto |

E non è solo la CPU: la memoria è **128 MB su entrambi i piani**, mentre
`decodifica()` da sola ne prende **87 MB** per il solo Manyshot (147.000
inserzioni), più 19 MB di `JSON.parse`. Con un heap da 112 MB il processo muore.

💡 **Il trucco del Worker sta in una funzione**, `passa()`: prende il valore dal
KV con `get(k, "stream")` e lo rigira **senza parsarlo**. Così la scheda più
grossa misurata — 472 KB — costa quanto una da 8 KB.

## Nessun segreto sui dispositivi

**La pagina si apre sul Mac, sulla Deck o sul telefono e funziona.** Tutte le
letture (`/stato`, `/prezzo`, `/dettaglio`, `/stash`, `/liquidita`) sono aperte.

La `CHIAVE` protegge solo ciò che **scrive** i dati di Nicolas — `POST /stash` e
il campionatore — e la usa **il segnalibro**, che se la porta dentro da quando lo
si trascina. La pagina non la chiede mai.

⚠️ **`/aggiorna` non è protetto da un segreto ma da un tempo di attesa** di 10
minuti, che è anche la cosa giusta nel merito: la fonte rigenera i suoi dati ogni
~10 minuti, quindi rifare il conto prima darebbe lo stesso numero. Un segreto lì
avrebbe significato configurare ogni dispositivo.

## Come si mette online

**Su Cloudflare**, dalla cartella `server/`:

```
npx wrangler kv namespace create WARRANT   # incolla l'id in wrangler.toml
npx wrangler secret put CHIAVE             # la stessa del segnalibro
npx wrangler secret put GITHUB_TOKEN       # token con permesso di dispatch sul repo
npx wrangler deploy
```

Poi **una riga sola** in `warrant/index.html`: la costante `SERVER_PREDEFINITO`,
con l'URL del Worker. Deve essere giusta lì dentro e non nelle impostazioni —
altrimenti ogni dispositivo andrebbe configurato, che è esattamente ciò che non
si vuole.

**Su GitHub**, in *Settings → Secrets → Actions*, tre segreti per la Action:
`CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CF_API_TOKEN` (permesso *Workers KV
Storage: Edit*).

⚠️ **I segreti non si scrivono mai in un comando né in `wrangler.toml`**, che è
committato: `wrangler secret put` li chiede a voce. Un token finito in una
trascrizione va revocato, non rimosso.

**Si controlla da `/stato`**: dice `magazzino: "cf-kv"` quando il KV è agganciato,
`chiave: true` quando il segreto è arrivato al runtime, e quando è stato calcolato
l'ultimo risultato.

## Quanto costa in termini di limiti

Deno Deploy free: **1M richieste/mese**, **15 h di CPU/mese**, **20 GB** in
uscita, **1 GiB** di KV. Una prezzatura completa dei 39 warrant tocca ~23
archetipi, cioè qualche decina di MB scaricati **dal server** e pochi secondi di
CPU.

🔴 **«Il tetto è lontanissimo» diceva questa riga, e il 19 agosto 2026 il servizio
si è spento con `503 USAGE_EXCEEDED`.** Due cose che il conto non aveva:

1. l'organizzazione **non era verificata**, e finché non si aggiunge una carta
   Deno concede una **frazione** dei limiti del piano gratuito — quindi il numero
   giusto non era 20 GB;
2. la cache **non esisteva davvero**: a `fetch` veniva passata l'opzione
   `cf: { cacheTtl }`, che è **di Cloudflare** e su Deno viene ignorata in
   silenzio. Ogni click su *Aggiorna prezzi* riscaricava ~23 indici da 1-6 MB.

💡 **La lezione che vale oltre a questo server**: un limite «lontanissimo» calcolato
sul consumo *previsto* non dice niente se non si misura quello *vero*. Qui il
divario era di ordini di grandezza, e nessuno se n'è accorto finché il servizio non
si è fermato.

**Cosa è cambiato dopo.** La parte **pubblica** — griglia degli archetipi,
combinazioni, pesi — non passa più di qui: la calcola `genera-panorama.mjs` dentro
una **GitHub Action**, una volta al giorno, e finisce in `warrant/panorama.json`
(183 KB) servito da Pages sulla stessa origine della pagina. Al server resta solo
ciò che dipende dallo stash di Nicolas.

⚠️ **La cache di 10 minuti non è un dettaglio**: senza, ogni click riscaricherebbe
gli stessi megabyte dal loro server, che è un ottimo modo per diventare sgraditi.
Il loro indice si aggiorna ogni ~10 minuti, quindi chiedere più spesso non darebbe
nemmeno un dato più fresco.
