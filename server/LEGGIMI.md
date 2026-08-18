# server/ — il pezzo che la pagina statica non può fare da sola

`warrant-api.js` serve la pagina [warrant/](../warrant/). Fa tre cose e basta:

| Rotta | Cosa fa |
|---|---|
| `POST /prezzo` | scarica l'indice di mercato di xddbsns.com, prezza i warrant sincronizzati e torna una risposta piccola |
| `POST /stash?k=…` | riceve i warrant dal segnalibro (chiave richiesta) |
| `GET /stash`, `GET /stato` | li rilegge, e dice quando è stata l'ultima sincronizzazione |
| `GET /mercato/<archetipo>` | l'indice grezzo, con le intestazioni CORS, per chi preferisce calcolare nel browser |

**Perché non basta la pagina.** Misurato, non dedotto: xddbsns.com risponde
**senza intestazione CORS** (una fetch `no-cors` torna `opaque`), quindi il
browser scarica e non lascia leggere. E un `localStorage` è per-dispositivo: non
fa vedere allo Steam Deck ciò che il Mac ha sincronizzato.

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
archetipi, cioè qualche decina di MB scaricati **dal server** (l'ingresso non
conta sull'uscita) e pochi secondi di CPU: il tetto è lontanissimo.

⚠️ **La cache di 10 minuti non è un dettaglio**: senza, ogni click riscaricherebbe
gli stessi megabyte dal loro server, che è un ottimo modo per diventare sgraditi.
Il loro indice si aggiorna ogni ~10 minuti, quindi chiedere più spesso non darebbe
nemmeno un dato più fresco.
