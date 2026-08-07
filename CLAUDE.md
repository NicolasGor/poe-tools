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

- **Zero dipendenze esterne**: niente CDN, niente font remoti, niente fetch verso
  altri host. Tutto inline, tutto funzionante offline.
- Un strumento = una cartella con il suo `index.html`, più una scheda nel
  catalogo in `index.html` alla radice.
- Il sito dichiara la patch a cui si riferisce. Quando cambia, si aggiorna.
- Niente numeri di gioco inventati: valgono le stesse regole della wiki.
