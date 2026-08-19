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
- **I link in uscita sono ammessi** — un `<a href>` verso `pathofexile.com/trade`
  è navigazione, non una dipendenza: la pagina si carica lo stesso se il sito
  remoto è giù.
- **`server/` è l'eccezione alla regola di sopra, ed è dichiarata.** La pagina
  `warrant/` ha bisogno di due cose che una pagina statica non può fare: leggere
  l'indice di mercato di xddbsns.com (**risponde senza intestazione CORS**: una
  fetch `no-cors` torna `opaque`) e tenere i warrant sincronizzati **fra Mac e
  Steam Deck**. `server/warrant-api.js` fa solo questo — proxy con CORS, un
  magazzino chiave-valore e il calcolo dei prezzi — e gira uguale su Deno Deploy
  o Cloudflare Workers. ⚠️ **Non tocca credenziali**: lo stash lo legge un
  segnalibro dentro pathofexile.com, dove la sessione è già viva, e qui arriva
  solo il JSON risultante. Se il server è spento la pagina resta leggibile:
  spariscono i numeri, non il metodo.
- Un strumento = una cartella con il suo `index.html`, più una scheda nel
  catalogo in `index.html` alla radice.
- 🔴 **E la voce va aggiunta alla barra di *tutte* le pagine**, non solo a quella
  su cui stai lavorando: la barra è copiata dentro ogni `index.html`, undici
  volte. Warrant per giorni si è visto **solo dalla homepage** proprio così.
  `node controlla-barre.mjs` lo verifica, e una GitHub Action lo rifà a ogni push
  — perché non è un errore che si nota guardando una pagina: bisogna
  confrontarle fra loro.
- Il sito dichiara la patch a cui si riferisce. Quando cambia, si aggiorna.
- Niente numeri di gioco inventati: valgono le stesse regole della wiki.
