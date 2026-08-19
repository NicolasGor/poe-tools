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

**<https://poe-tools.nicolasgor.deno.net>** — Deno Deploy, piano gratuito,
distribuito a ogni push su `main`. Entrypoint `server/warrant-api.js`, database
**Deno KV** agganciato (istanza `warrant`), variabile `CHIAVE` impostata come
*secret*.

⚠️ **Il KV va agganciato a mano**, e senza non è un errore rumoroso: il server
ripiega sulla memoria del processo e i warrant spariscono al primo riavvio.
Si controlla da `/stato`, che risponde `magazzino: "deno-kv"` quando è a posto e
`"memoria-volatile"` quando non lo è. Stessa cosa per la chiave: `chiave: true`
dice che la variabile è arrivata al runtime — ⚠️ **una variabile salvata nel
pannello non basta**, serve un nuovo deploy perché entri nell'app.

## Come è stato messo online (Deno Deploy, gratis)

1. <https://deno.com/deploy> → accedi con GitHub.
2. **New project** → collega `NicolasGor/poe-tools` → entrypoint
   `server/warrant-api.js`. Da lì in poi si ridistribuisce a ogni push.
3. **Settings → Environment Variables** → `CHIAVE` = una stringa a piacere.
   Scegliela tu: non deve passare da nessuna trascrizione.
4. Copia l'URL del progetto (`https://<nome>.deno.dev`) e mettilo nella pagina —
   `warrant/index.html`, costante `API` — oppure aprila una volta con
   `?api=https://<nome>.deno.dev`, che se lo ricorda nel browser.

**Perché non Cloudflare Workers gratis:** il piano free dà **10 ms di CPU per
richiesta**, e il `JSON.parse` di un indice da 5 MB ne consuma molti di più.
Cloudflare Paid (5 $/mese, 30 s) andrebbe: il codice è lo stesso, cambia solo il
magazzino (`env.WARRANT` invece di `Deno.openKv`), già previsto nel file.

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
