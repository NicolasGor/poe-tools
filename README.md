# PoE Tools

Sito statico con la UI degli strumenti per Path of Exile 1 (patch 3.29.2).
Servito da GitHub Pages, nessuna build: HTML e CSS scritti a mano.

## Struttura

```
poe-tools/
├── index.html    catalogo degli strumenti
└── <tool>/       una cartella per strumento, con il suo index.html
```

Ogni strumento è autoconcluso: niente dipendenze esterne, niente CDN, tutto
inline. Una pagina che smette di funzionare offline è una pagina rotta.

## Sviluppo

Apri `index.html` nel browser. Non serve altro.
