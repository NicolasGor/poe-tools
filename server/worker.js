/**
 * worker — il portiere. Gira su Cloudflare Workers, piano gratuito.
 *
 * **Non calcola niente, e non e' una semplificazione: e' il vincolo.** Il piano
 * gratuito concede **10 ms di CPU per invocazione** (e valgono anche per i Cron
 * Trigger, non solo per le richieste HTTP). Misurato il 19 agosto 2026 su 39
 * warrant: `/prezzo` costa **2.774 ms**, `/dettaglio` **206 ms** in media. Non e'
 * un divario che si chiude scrivendo meglio.
 *
 * Quindi il conto lo fa una **GitHub Action** (`server/genera-prezzi.mjs`), che
 * deposita il risultato nel KV; qui si **rigirano i byte del KV** senza mai
 * parsarli. La differenza fra i due mestieri e' tutta in `passa()`.
 *
 * ⚠️ **Perche' non piu' Deno Deploy.** Non per antipatia: da li' passavano ~110 MB
 * di indici di mercato per ogni prezzatura a freddo, e il piano gratuito si e'
 * spento con `503 USAGE_EXCEEDED`. Su Cloudflare la **banda non e' fatturata** su
 * nessuno dei due piani — cioe' quel modo di fallire qui non esiste. La
 * sincronizzazione dello stash, che sembrava il costo, era pochi KB.
 *
 * 🔴 **Nessun segreto sui dispositivi.** La pagina si apre sul Mac, sulla Deck o
 * sul telefono e funziona: **tutte le letture sono aperte** e non chiedono
 * chiave. La `CHIAVE` protegge solo cio' che **scrive** i dati di Nicolas — la
 * sincronizzazione dello stash e il campionatore — che fa il segnalibro, non la
 * pagina. E `/aggiorna` non e' protetto da un segreto ma da un **tempo di
 * attesa**, che e' anche la cosa giusta nel merito: la fonte rigenera i suoi dati
 * ogni ~10 minuti, quindi rifare il conto prima non darebbe un numero diverso.
 */

const ATTESA_MINUTI = 10;   // vedi sopra: e' il ritmo della fonte, non una difesa

const intestazioni = (extra = {}) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "content-type": "application/json; charset=utf-8",
  ...extra,
});

const json = (dati, stato = 200) =>
  new Response(JSON.stringify(dati), { status: stato, headers: intestazioni() });

/**
 * Il mestiere di questo Worker in una funzione: prendere un valore dal KV e
 * rigirarlo **senza parsarlo**. `get(k, "stream")` restituisce i byte cosi' come
 * sono, quindi una scheda da 477 KB costa quanto una da 8 KB — e nessuna delle
 * due tocca il tetto dei 10 ms.
 */
async function passa(env, chiave, seManca, statoSeManca = 404) {
  const flusso = await env.WARRANT.get(chiave, "stream");
  if (!flusso) return json(seManca, statoSeManca);
  return new Response(flusso, { headers: intestazioni() });
}

/* `attesa` e' il `cacheTtl` del KV, cioe' **per quanto una lettura puo' essere
 * vecchia**. Non e' un dettaglio di prestazioni: KV e' consistente solo alla
 * lunga, e la documentazione lo dice — *«writes or updates to the key made in
 * other locations may take up to 60 seconds (or the duration of the cacheTtl) to
 * display»*.
 *
 * 🔴 Misurato il 19 agosto: la prezzatura era pronta dopo **31 secondi**, ma la
 * pagina che aspettava continuava a leggere lo stato vecchio e mostrava «calcolo
 * i prezzi…» per oltre un minuto in piu'. Il lavoro era finito; a essere in
 * ritardo era la notizia. */
const leggi = async (env, k, attesa) =>
  env.WARRANT.get(k, attesa ? { type: "json", cacheTtl: attesa } : "json");

// 30 e' il minimo che Cloudflare accetta: sotto, il valore viene ignorato
const FRESCO = 30;
const scrivi = (env, k, v) => env.WARRANT.put(k, JSON.stringify(v));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    /* 💡 Si chiamava `CHIAVE` e basta, che nel pannello di Cloudflare non dice a
     * cosa serva — rilievo di Nicolas. `CHIAVE_SCRITTURA` lo dice: autorizza a
     * **scrivere** (il segnalibro che manda lo stash, la Action che deposita il
     * risultato). Le letture non la usano e restano aperte.
     * 💡 Il rinomino e' passato per un ripiego temporaneo sul vecchio nome, cosi'
     * da non avere un istante in cui il servizio era rotto: nuovo segreto,
     * verifica, cancellazione del vecchio, e solo allora questa riga. Il ripiego
     * e' sparito il 19 agosto 2026, appena `CHIAVE_SCRITTURA` ha retto una
     * scrittura vera. */
    const chiave = env.CHIAVE_SCRITTURA || "";
    const autorizzato = () => chiave && url.searchParams.get("k") === chiave;

    if (req.method === "OPTIONS") return new Response(null, { headers: intestazioni() });

    try {
      /* ------------------------------------------------------------- lettura */

      // 🔴 Niente chiave: e' la rotta che dice a un dispositivo nuovo se c'e' un
      // risultato e di quando e'. Chiederle un segreto vorrebbe dire che la
      // pagina non si apre da nessuna parte senza configurarla prima.
      if (url.pathname === "/stato") {
        /* ⚠️ **Solo chiavi piccole, e non e' un dettaglio.** La prima versione
         * leggeva `prezzi` e `stash` in `json` per ricavarne due conteggi: 140 KB
         * parsati, **14 ms di CPU misurati** contro i 10 concessi — e per giunta
         * sulla rotta che la pagina interroga ogni pochi secondi mentre aspetta un
         * aggiornamento. I riassunti li scrive chi scrive i dati: la Action per i
         * prezzi, questo Worker per lo stash appena lo riceve. */
        /* ⚠️ Solo **questi quattro** chiedono la lettura fresca: sono i riassunti,
         * pochi byte, e sono ciò su cui la pagina decide se aspettare ancora. I
         * valori grossi — `prezzi`, `scheda:*` — restano con la cache lunga, che
         * su di loro e' un guadagno e non un danno. */
        const [p, s, a, rich, richT] = await Promise.all([
          leggi(env, "stato:prezzi", FRESCO), leggi(env, "stato:stash", FRESCO),
          leggi(env, "aggiornamento", FRESCO), leggi(env, "richiesta-stash", FRESCO),
          leggi(env, "richiesta-trade", FRESCO),
        ]);
        return json({
          ok: true,
          magazzino: env.WARRANT ? "cf-kv" : "assente",
          calcolo: "github-action",
          prezzi: p || null,
          stash: s || null,
          aggiornamento: a || null,
          // il biglietto lasciato dalla pagina: l'agente sul Mac guarda questo
          richiestaStash: rich || null,
          // e il biglietto per il controllo di UN warrant sul trade
          richiestaTrade: richT || null,
          // booleano di proposito: dice se il server ha una chiave, non quale sia
          chiave: !!chiave,
        });
      }

      // i prezzi gia' calcolati. GET e POST fanno la stessa cosa: la pagina
      // vecchia chiamava in POST, e rompere i segnalibri gia' trascinati per una
      // questione di stile non vale il fastidio.
      if (url.pathname === "/prezzo") {
        return passa(env, "prezzi", { errore: "nessun prezzo calcolato: premi «Aggiorna prezzi»" });
      }

      // la scheda di UN mercenario, per id
      if (url.pathname === "/dettaglio") {
        const id = url.searchParams.get("id") || (req.method === "POST" ? (await req.json())?.warrant?.id : null);
        if (!id) return json({ errore: "manca id" }, 400);
        return passa(env, `scheda:${id}`, { errore: "scheda non calcolata per questo mercenario" });
      }

      // da quando ogni warrant e' in casa: `{ id: iso }`. La pagina lo unisce ai
      // prezzi per id — tenerlo separato evita di rigenerare tutto quando cambia.
      if (url.pathname === "/primi-visti") {
        return passa(env, "primi-visti", {}, 200);
      }

      if (url.pathname === "/stash" && req.method === "GET") {
        /* 🔴 **200, non 404: «vuoto» non è «non trovato».** Uno stash mai
         * sincronizzato è una risposta legittima — zero warrant — e chi chiede
         * deve poterla leggere e dirlo con parole sue. Col 404 la Action moriva
         * con uno stack trace (`/stash: HTTP 404`) invece del messaggio che le
         * era stato scritto apposta. Misurato al primo giro vero, il 19 agosto. */
        return passa(env, "stash", { warrant: [], quando: null }, 200);
      }

      /* --------------------------------------------------------- aggiornamento
       * Il click su «Aggiorna prezzi» non calcola qui: fa partire la Action e
       * torna subito. La pagina poi chiede `/stato` finche' `generato` non cambia.
       */
      if (url.pathname === "/aggiorna" && req.method === "POST") {
        if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
          return json({ errore: "il Worker non sa a chi chiedere il calcolo (GITHUB_TOKEN/GITHUB_REPO)" }, 500);
        }
        const [a, sp, ss] = await Promise.all([
          leggi(env, "aggiornamento", FRESCO), leggi(env, "stato:prezzi", FRESCO),
          leggi(env, "stato:stash", FRESCO),
        ]);
        const adesso = Date.now();

        /* 🔴 **L'attesa non vale se lo stash e' cambiato.** Esiste per non rifare
         * lo stesso conto su dati identici — la fonte rigenera ogni ~10 minuti,
         * quindi ripetere prima darebbe lo stesso numero. Ma se i prezzi sono
         * stati calcolati su uno stash **diverso** da quello attuale, il conto da
         * rifare c'e' eccome, e bloccarlo lasciava la pagina ad aspettare un
         * allineamento che non poteva arrivare. Successo davvero il 19 agosto,
         * al primo giro con warrant nuovi: 49 in stash, 47 prezzati. */
        const stashNuovo = ss?.quando && sp?.stashDel !== ss.quando;
        if (!stashNuovo && a?.chiestoIl && adesso - a.chiestoIl < ATTESA_MINUTI * 60000) {
          const restano = Math.ceil((ATTESA_MINUTI * 60000 - (adesso - a.chiestoIl)) / 60000);
          return json({ inAttesa: true, restanoMinuti: restano, chiestoIl: a.chiestoIl,
                        nota: `La fonte rigenera ogni ~${ATTESA_MINUTI} minuti: rifare il conto prima darebbe lo stesso numero.` }, 429);
        }
        /* ⚠️ Con un try/catch suo, non quello generale in fondo: se GitHub non
         * si raggiunge, il catch-all scrive «fetch failed» in pagina — che e'
         * vero e inutile. Chi legge deve sapere *chi* non ha risposto. */
        let r;
        try {
          r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.GITHUB_TOKEN}`,
              accept: "application/vnd.github+json",
              "content-type": "application/json",
              // GitHub rifiuta le richieste senza user-agent con un 403 che non
              // spiega niente: e' costato tempo altrove, si mette e basta.
              "user-agent": "warrant-worker",
            },
            body: JSON.stringify({ event_type: "prezza-warrant" }),
          });
        } catch (e) {
          return json({ errore: `Non riesco a contattare GitHub per far partire il calcolo (${e.message}). I prezzi gia' calcolati restano leggibili.` }, 502);
        }
        if (!r.ok) {
          const dettaglio = (await r.text()).slice(0, 300);
          const spiega = r.status === 401 || r.status === 403
            ? "il token del Worker non e' valido o non ha il permesso sul repository"
            : r.status === 404 ? "repository o evento non trovato: controlla GITHUB_REPO" : "";
          return json({ errore: `GitHub ha risposto ${r.status}${spiega ? " — " + spiega : ""}`, dettaglio }, 502);
        }
        await scrivi(env, "aggiornamento", { chiestoIl: adesso, stato: "in-corso" });
        return json({ ok: true, avviato: true, chiestoIl: adesso });
      }

      /* ------------------------------------------------ richiesta di rilettura
       * La pagina non puo' leggere lo stash — serve la sessione di pathofexile,
       * che vive solo sul Mac — ma puo' **lasciare un biglietto**: qui si scrive
       * che qualcuno l'ha chiesto, e un piccolo agente sul Mac lo raccoglie.
       *
       * 🔴 **Senza chiave, quindi con un tempo di attesa al posto suo.** Una rotta
       * aperta che scrive nel KV e' un modo per farci esaurire le **1.000
       * scritture al giorno** del piano gratuito: con 5 minuti di attesa il
       * massimo teorico e' 288, e in pratica sono una manciata. Chiedere piu'
       * spesso non avrebbe senso comunque — il Mac ci mette ~1 minuto a
       * rispondere. */
      if (url.pathname === "/chiedi-stash" && req.method === "POST") {
        const r = await leggi(env, "richiesta-stash", FRESCO);
        const adesso = Date.now();
        if (r?.quando && adesso - r.quando < 5 * 60000 && !r.servita) {
          return json({ inAttesa: true, chiestoIl: r.quando,
                        nota: "Una richiesta e' gia' in coda: il Mac la raccoglie entro pochi minuti." }, 429);
        }
        await scrivi(env, "richiesta-stash", { quando: adesso, servita: false });
        return json({ ok: true, chiestoIl: adesso });
      }

      /* ------------------------------------- controllo sul trade di UN warrant
       * 🔴 **Perche' passa dal Mac e non da qui.** Il Worker potrebbe chiamare
       * `/api/trade/search` da solo, ma **senza sessione**: e da sloggati GGG
       * rifiuta le query dei mercenari — *«Query is too complex. Logging in will
       * increase this limit»* — cioe' proprio quelle che servono. La sessione ce
       * l'ha il browser di Nicolas, quindi la ricerca la fa
       * `sincronizza-warrant.mjs`, esattamente come gia' fa per lo stash.
       *
       * 💡 E il motivo per cui serve: l'indice di mercato **non porta le date**.
       * Il trade si', e senza quelle una mediana su pochi pezzi la decide una
       * inserzione ferma da tre settimane — misurato su Dorian il 24 agosto.
       */
      if (url.pathname === "/chiedi-trade" && req.method === "POST") {
        const corpo = await req.json().catch(() => ({}));
        if (!corpo.id) return json({ errore: "serve l'id del warrant" }, 400);
        const r = await leggi(env, "richiesta-trade", FRESCO);
        const adesso = Date.now();
        // una alla volta: e' la ricerca del suo account, e mentre gira lui non cerca
        if (r?.quando && adesso - r.quando < 5 * 60000 && !r.servita) {
          return json({ inAttesa: true, id: r.id, nome: r.nome, chiestoIl: r.quando,
                        nota: "Un controllo e' gia' in coda: il Mac lo raccoglie entro un minuto." }, 429);
        }
        await scrivi(env, "richiesta-trade", { quando: adesso, id: corpo.id, nome: corpo.nome || null, servita: false });
        return json({ ok: true, chiestoIl: adesso });
      }

      if (url.pathname === "/controlli") {
        return json({ controlli: (await leggi(env, "controlli", FRESCO)) || {} });
      }

      if (url.pathname === "/controllo" && req.method === "POST") {
        if (!autorizzato()) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const c = await req.json();
        if (!c?.id) return json({ errore: "serve l'id" }, 400);
        const tutti = (await leggi(env, "controlli")) || {};
        tutti[c.id] = { ...c, quando: new Date().toISOString() };
        // ne restano 40: il KV gratuito ha un tetto di scritture, e piu' vecchi
        // di cosi' un controllo non dice piu' niente comunque
        const recenti = Object.keys(tutti)
          .sort((a, b) => String(tutti[b].quando).localeCompare(String(tutti[a].quando)))
          .slice(0, 40);
        await scrivi(env, "controlli", Object.fromEntries(recenti.map((k) => [k, tutti[k]])));
        const r = await leggi(env, "richiesta-trade");
        if (r && !r.servita) await scrivi(env, "richiesta-trade", { ...r, servita: true });
        return json({ ok: true });
      }

      /* -------------------------------------------------------- il campionatore
       * ⚠️ Il piano **non riprezza piu' niente**: prima scaricava gli indici di
       * tutti gli archetipi in tab solo per scegliere quali otto combinazioni
       * fotografare. Le stesse informazioni — chiave, valore, link — sono gia' nel
       * risultato che la Action ha depositato.
       */
      if (url.pathname === "/campione/piano") {
        if (!autorizzato()) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const p = await leggi(env, "prezzi");
        if (!p?.warrant?.length) return json({ errore: "nessun prezzo calcolato" }, 409);
        const quanti = Math.min(Number(url.searchParams.get("quanti") || 8), 20);
        const seguite = (await leggi(env, "campioni:elenco")) || [];
        const prezzati = [...p.warrant].filter((w) => w.chiave).sort((a, b) => b.prezzo - a.prezzo);
        // la continuita' prima del valore: si rifotografa cio' che si sta gia'
        // seguendo, altrimenti ogni giro sarebbe di nuovo il primo
        const piano = [...prezzati.filter((w) => seguite.includes(w.chiave)),
                       ...prezzati.filter((w) => !seguite.includes(w.chiave))].slice(0, quanti);
        return json({ piano: piano.map((w) => ({ chiave: w.chiave, nome: w.nome, build: w.build,
                                                 valore: w.prezzo, trade: w.trade })) });
      }

      if (url.pathname === "/liquidita") {
        const chiavi = (url.searchParams.get("chiavi") || "").split(",").filter(Boolean).slice(0, 40);
        const fuori = {};
        for (const k of chiavi) {
          const v = await leggi(env, "campione:" + k);
          if (!v) continue;
          const storia = v.storia || [];
          const totOre = storia.reduce((n, x) => n + (x.ore || 0), 0);
          const totSparite = storia.reduce((n, x) => n + (x.sparite || 0), 0);
          fuori[k] = { nome: v.nome, quando: v.quando, viste: v.ids.length, storia,
                       spariteOra: totOre ? +(totSparite / totOre * 24).toFixed(1) : null };
        }
        const s = await leggi(env, "stash");
        return json({ campioni: fuori, warrantInStash: s?.warrant?.length ?? 0 });
      }

      /* --------------------------------------------------------- scrittura
       * Le uniche rotte con la chiave, e le usa **solo il segnalibro** — che la
       * porta gia' dentro di se' da quando lo si trascina. La pagina non le
       * chiama mai, ed e' per questo che puo' aprirsi ovunque senza configurare.
       */
      if (url.pathname === "/stash" && req.method === "POST") {
        if (!autorizzato()) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const corpo = await req.json();
        if (!Array.isArray(corpo.warrant)) return json({ errore: "manca warrant[]" }, 400);
        const quando = new Date().toISOString();
        await scrivi(env, "stash", { warrant: corpo.warrant, quando, tab: corpo.tab ?? null });
        // il riassunto accanto al dato: cosi' /stato non deve riparsare 70 KB
        await scrivi(env, "stato:stash", { warrant: corpo.warrant.length, quando });
        /* **Da quando ce l'ho.** GGG non lo dice: lo stash risponde *cosa c'e'
         * adesso*, non da quando. Quindi la data la fa nascere questo punto —
         * l'unico da cui i warrant entrano — la prima volta che un `id` compare.
         *
         * 🔴 **Le voci non si potano mai**, ed e' una scelta: se un mercenario
         * cambia tab, o esce e rientra, sparirebbe e rinascerebbe «nuovo»,
         * cancellando proprio il dato che si vuole tenere. La mappa cresce di
         * qualche decina di byte a warrant — mille voci sono ~80 KB contro i
         * 25 MiB che il KV accetta per valore. */
        const visti = (await leggi(env, "primi-visti")) || {};
        let nuovi = 0;
        for (const w of corpo.warrant) if (w.id && !visti[w.id]) { visti[w.id] = quando; nuovi++; }
        if (nuovi) await scrivi(env, "primi-visti", visti);

        // il biglietto lasciato dalla pagina e' stato raccolto: si annulla, cosi'
        // una richiesta nuova non trova la vecchia ancora in coda
        const rich = await leggi(env, "richiesta-stash");
        if (rich && !rich.servita) await scrivi(env, "richiesta-stash", { ...rich, servita: true });
        return json({ ok: true, salvati: corpo.warrant.length, nuovi });
      }

      /* Il deposito del risultato calcolato dalla Action.
       *
       * 💡 **Perche' non lascio scrivere la Action direttamente nel KV.** Sarebbe
       * bastato, ma avrebbe richiesto un **token API di Cloudflare** in piu' da
       * creare, custodire e un giorno ruotare. Passando di qui basta la `CHIAVE`
       * che gia' esiste: una credenziale in meno al mondo.
       *
       * ⚠️ Una chiave per richiesta, e il corpo **non si parsa mai**: si passa il
       * flusso direttamente a `put()`. Depositare una scheda da 472 KB costa
       * quanto depositarne una da 8, e resta lontanissimo dai 10 ms. */
      if (url.pathname === "/deposita" && req.method === "POST") {
        if (!autorizzato()) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const nome = url.searchParams.get("chiave");
        if (!nome) return json({ errore: "manca il nome della chiave" }, 400);
        // 🔴 Elenco chiuso: senza, la CHIAVE diventerebbe un permesso di scrivere
        // qualunque cosa nel magazzino, compreso lo `stash` che non e' suo mestiere.
        const ammesse = /^(prezzi|stato:prezzi|aggiornamento|richiesta-stash|scheda:[0-9a-f]{8,80})$/;
        if (!ammesse.test(nome)) return json({ errore: `chiave non ammessa: ${nome}` }, 400);
        await env.WARRANT.put(nome, req.body);
        return json({ ok: true, scritta: nome });
      }

      if (url.pathname === "/campione" && req.method === "POST") {
        if (!autorizzato()) return json({ errore: "chiave mancante o sbagliata" }, 403);
        const corpo = await req.json();
        const adesso = new Date().toISOString();
        const esito = [];
        for (const c of corpo.campioni || []) {
          if (!c.chiave || !Array.isArray(c.inserzioni)) continue;
          const vecchio = await leggi(env, "campione:" + c.chiave);
          const ids = c.inserzioni.map((x) => x.id);
          let sparite = null, ore = null;
          if (vecchio) {
            sparite = vecchio.ids.filter((x) => !ids.includes(x)).length;
            ore = +((new Date(adesso) - new Date(vecchio.quando)) / 3600000).toFixed(1);
          }
          const storia = [...(vecchio?.storia || []),
                          ...(sparite === null ? [] : [{ quando: adesso, ore, sparite, viste: vecchio.ids.length }])].slice(-12);
          await scrivi(env, "campione:" + c.chiave, {
            chiave: c.chiave, nome: c.nome, build: c.build, quando: adesso,
            totale: c.totale ?? null, ids, prezzi: c.inserzioni.map((x) => x.prezzo), storia,
          });
          esito.push({ chiave: c.chiave, nome: c.nome, viste: ids.length, sparite, ore });
        }
        const elenco = (await leggi(env, "campioni:elenco")) || [];
        for (const c of esito) if (!elenco.includes(c.chiave)) elenco.push(c.chiave);
        await scrivi(env, "campioni:elenco", elenco.slice(-40));
        return json({ ok: true, campioni: esito });
      }

      return json({ errore: "rotta sconosciuta", rotte: [
        "GET /stato", "GET /prezzo", "GET /dettaglio?id=", "GET /stash", "GET /primi-visti", "POST /stash?k=", "POST /deposita?k=&chiave=", "POST /chiedi-stash",
        "POST /aggiorna", "GET /campione/piano?k=", "POST /campione?k=", "GET /liquidita?chiavi=",
        "POST /chiedi-trade", "GET /controlli", "POST /controllo?k=",
      ] }, 404);
    } catch (e) {
      return json({ errore: String((e && e.message) || e) }, 502);
    }
  },
};
