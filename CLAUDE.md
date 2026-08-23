# Istruzioni per Claude — PoE Tools (sito)

Questa cartella è un **repo git separato e pubblico**, annidato dentro una wiki
locale che non va pubblicata.

## Regola prima di tutte

**Le operazioni git si eseguono solo con la working directory dentro
`poe-tools/`.** Mai `git add` da un livello superiore: la cartella genitore
contiene appunti privati e un `.env` con un token reale. La radice del repo è
qui, e deve restarci.

Prima di ogni commit, verifica cosa stai includendo:

```bash
git -C . status --short
```

Se compare qualcosa che sta fuori da `poe-tools/`, fermati.

## Cosa ci va

Solo il sito: HTML, CSS, JS della UI degli strumenti. **Nessun contenuto della
wiki** — gli appunti di gioco, i personaggi, gli obiettivi restano locali. Se un
dato della wiki serve a uno strumento, si copia il singolo valore, non la pagina.

## Convenzioni

- **Zero dipendenze esterne a runtime**: niente CDN, niente font remoti, niente
  fetch verso altri host. La pagina deve funzionare offline.
  - **Unica eccezione, e solo a queste condizioni: gli `<iframe>` su richiesta.**
    In `strategie/` gli alberi atlas si incorporano in pagina da **poeplanner**
    (`poeplanner.com/atlas-tree/<codice>` apre direttamente un albero: il codice
    e' quello ufficiale, lo stesso che poe.ninja mette nei suoi URL), ma
    l'iframe **non esiste finché non lo si chiede**: viene creato da un pulsante.
    Senza rete la pagina funziona per intero — manca solo un riquadro che nessuno
    ha aperto — e accanto al pulsante c'è sempre il link diretto. Un iframe
    caricato all'apertura sarebbe invece una dipendenza vera, e resta vietato.
- **Il design sta in [stile.css](stile.css), condiviso da tutte le pagine**: token
  (colori, scala tipografica, spaziatura), barra di navigazione, e i componenti
  ricorrenti — `.card`, `.badge`, `.avviso`, `.tabella`, `.kpi`, `.sec`. È un file
  locale, non un CDN: la regola sopra resta rispettata. Nel `<style>` di una pagina
  ci va **solo ciò che è davvero suo** (la mappa dell'atlante, la griglia del gear).
  Se una regola servirebbe a due pagine, il suo posto è `stile.css`.
- **La larghezza della colonna è la variabile `--colonna`**, condivisa fra barra e
  contenuto perché restino allineati. Una pagina che ha bisogno di più spazio mette
  `class="largo"` su `<body>` — non un max-width solo sul contenitore.
- **Le icone si scaricano, non si linkano — tranne quando il contenuto è
  dinamico.** Per una pagina a contenuto fisso gli asset stanno in `<tool>/img/`
  e sono committati. Ma una pagina che **importa build arbitrarie** non può avere
  una copia locale di ogni item del gioco: lì si usa l'archivio remoto
  (`assets.pobb.in/1/<Nome>.webp`), con ripiego sul nome scritto se l'icona manca.
  La regola resta valida per tutto il resto: nessun CDN, nessun host esterno.
- 🔴 **Il filtro sulle ultime 24 ore (`indexed: "1day"`) vale SOLO per i warrant
  sulla pagina Warrant** — detto da Nicolas il 20 agosto: *«nei link del trade
  normali non impostare la cosa del up to 1 day»*. I link normali nascono con il
  solo `status: "securable"`. La ragione del filtro è specifica dei warrant:
  «31 inserzioni simili» lì conta anche chi è fermo
  da giorni: la mediana dell'età di quelle inserzioni è **165 ore**, e su 694
  misurate solo **101** erano del giorno prima. Aprire il link e trovare poco è
  quindi il segnale che quel mercato **adesso** non c'è. Sul trade il menu
  *Listed* resta a un click, quindi la scelta preimpostata non chiude niente.
  ⚠️ **Ma il campionatore quel filtro se lo toglie**: con una finestra che scorre
  un'inserzione «sparirebbe» solo per aver compiuto 25 ore, e le sparizioni
  confonderebbero *venduto* con *invecchiato*.
- **I link in uscita sono ammessi** — un `<a href>` verso `pathofexile.com/trade`
  è navigazione, non una dipendenza: la pagina si carica lo stesso se il sito
  remoto è giù.
- **`server/` è l'eccezione alla regola di sopra, ed è dichiarata.** La pagina
  `warrant/` ha bisogno di due cose che una pagina statica non può fare: leggere
  l'indice di mercato di xddbsns.com (**risponde senza intestazione CORS**: una
  fetch `no-cors` torna `opaque`) e tenere i warrant sincronizzati **fra Mac e
  Steam Deck**. Il mestiere è diviso in tre, e la divisione è imposta da una
  misura:
  - `server/worker.js` gira su **Cloudflare Workers** (gratis) e **non calcola
    niente**: rigira i byte del KV con `get(k, "stream")`, senza mai parsarli.
    🔴 Il piano gratuito dà **10 ms di CPU per invocazione** — validi anche per i
    Cron Trigger — contro i **2.774 ms** che costa una prezzatura;
  - `server/genera-prezzi.mjs` e `server/genera-panorama.mjs` girano dentro
    **GitHub Actions**, dove la CPU non ha tetto, e depositano il risultato;
  - `server/warrant-api.js` è **solo la matematica**, e gira unicamente dentro
    quelle Action. Non è più un server.
  ⚠️ **Non tocca credenziali**: lo stash lo legge
  `strumenti/misure/sincronizza-warrant.mjs` sul Mac, riusando il profilo del
  browser dove il login a pathofexile.com è già fatto; qui arriva solo il JSON, e
  la chiave di scrittura sta nel Portachiavi — **mai in una pagina web**. Se il
  Worker è spento la pagina resta leggibile: spariscono i numeri, non il metodo.
- Un strumento = una cartella con il suo `index.html`, più una scheda nel
  catalogo in `index.html` alla radice.
- 🔴 **E la voce va aggiunta alla barra di *tutte* le pagine**, non solo a quella
  su cui stai lavorando: la barra è copiata dentro ogni `index.html`, **nove**
  volte. Warrant per giorni si è visto **solo dalla homepage** proprio così.
  `node controlla-barre.mjs` lo verifica, e una GitHub Action lo rifà a ogni push
  — perché non è un errore che si nota guardando una pagina: bisogna
  confrontarle fra loro.
- **Una voce di barra può essere un gruppo invece di una pagina.** `Build` lo è:
  un `<button class="nav-gruppo">` con dentro Whisper e Luminary. Tre cose da
  sapere se se ne aggiunge un altro:
  - il pannello `.nav-giu` sta **fuori da `.nav-link`**, che ha `overflow-x:auto`
    e dentro lo ritaglierebbe su schermo stretto;
  - il suo `left` lo scrive `menu.js` all'apertura, perché il pulsante si sposta
    quando la barra scorre — nel CSS sarebbe una costante sbagliata;
  - nel markup il pannello nasce **aperto** (`aria-expanded="true"`, niente
    `hidden`) e lo chiude lo script: senza JS resterebbe altrimenti muto, e le
    sue voci irraggiungibili.
  ⚠️ `controlla-barre.mjs` legge anche i gruppi e le voci dei sottomenu: un
  controllo sui soli `<a>` direbbe «identiche» a una pagina cui manca metà
  sottomenu, che è dove il difetto è più facile da introdurre.
- Il sito dichiara la patch a cui si riferisce. Quando cambia, si aggiorna.
- Niente numeri di gioco inventati: valgono le stesse regole della wiki.
