/**
 * menu — apre e chiude i gruppi della barra di navigazione.
 *
 * **Perche' un file e non uno script per pagina.** La barra e' copiata dentro
 * ogni `index.html` — e' il compromesso che rende ogni pagina autosufficiente —
 * ma il *comportamento* no: nove copie della stessa funzione sarebbero nove
 * posti dove correggere lo stesso difetto. L'HTML si duplica, la logica no.
 *
 * 🔴 **I gruppi funzionano anche senza questo file.** Nel markup il pannello
 * nasce **aperto** (`aria-expanded="true"`, niente `hidden`) e lo chiude lo
 * script: se lo script non arriva si vedono tutti i pannelli spiegati — brutto
 * ma navigabile, invece che elegante e muto con le voci irraggiungibili.
 */
const gruppi = [...document.querySelectorAll(".nav-gruppo")]
  .map((bottone) => {
    const pannello = document.getElementById(bottone.getAttribute("aria-controls"));
    return pannello ? { bottone, pannello } : null;
  })
  .filter(Boolean);

for (const g of gruppi) {
  const barra = g.bottone.closest(".nav");
  const scorrevole = g.bottone.closest(".nav-link");

  /**
   * Ancora il riquadro sotto il suo pulsante.
   *
   * ⚠️ Il `left` non puo' stare nel CSS. Il pannello e' figlio di `.nav` — deve
   * esserlo, perche' `.nav-link` ha `overflow-x:auto` e dentro lo ritaglierebbe
   * — quindi le due ascisse non coincidono, e su schermo stretto quella del
   * pulsante **cambia mentre la barra scorre**.
   *
   * Il riquadro viene poi tirato dentro il bordo destro: ancorato e basta,
   * sull'ultima voce di una barra stretta uscirebbe dallo schermo.
   */
  g.ancora = () => {
    const b = g.bottone.getBoundingClientRect();
    const n = barra.getBoundingClientRect();
    const massimo = n.width - g.pannello.offsetWidth - 8;
    g.pannello.style.left = Math.max(8, Math.min(b.left - n.left, massimo)) + "px";
  };

  g.mostra = (aperto) => {
    g.bottone.setAttribute("aria-expanded", String(aperto));
    g.pannello.hidden = !aperto;
    if (aperto) g.ancora();
  };

  // Da qui in poi il pannello lo governa lo script.
  g.mostra(false);

  g.bottone.addEventListener("click", (e) => {
    e.stopPropagation();
    const apri = g.bottone.getAttribute("aria-expanded") !== "true";
    // 🔴 Chiudere **gli altri** e' il pezzo che con un gruppo solo non serviva:
    // il click sul pulsante ferma la propagazione, quindi il gestore che chiude
    // sul click fuori non scatterebbe mai e i due pannelli resterebbero aperti
    // insieme, sovrapposti.
    for (const altro of gruppi) if (altro !== g) altro.mostra(false);
    g.mostra(apri);
  });

  addEventListener("resize", () => { if (!g.pannello.hidden) g.ancora(); });
  scorrevole?.addEventListener("scroll", () => { if (!g.pannello.hidden) g.ancora(); },
                               { passive: true });
}

// Fuori dai pannelli si chiude tutto; dentro no, altrimenti il click su una
// voce verrebbe annullato prima di navigare.
document.addEventListener("click", (e) => {
  for (const g of gruppi) if (!g.pannello.contains(e.target)) g.mostra(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  for (const g of gruppi) {
    if (g.pannello.hidden) continue;
    g.mostra(false);
    g.bottone.focus();
  }
});
