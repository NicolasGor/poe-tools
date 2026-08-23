/**
 * menu — apre e chiude i gruppi della barra di navigazione.
 *
 * **Perche' un file e non uno script per pagina.** La barra e' copiata dentro
 * ogni `index.html` — e' il compromesso che rende ogni pagina autosufficiente —
 * ma il *comportamento* no: nove copie della stessa funzione sarebbero nove
 * posti dove correggere lo stesso difetto. L'HTML si duplica, la logica no.
 *
 * 🔴 **Il gruppo funziona anche senza questo file.** Se lo script non arriva, il
 * pannello resta `hidden` e le sue voci sarebbero irraggiungibili: per questo
 * l'attributo lo toglie **subito** lo script stesso e lo stato di partenza e'
 * scritto in `aria-expanded`. Chi ha JS disattivato vede il pannello **aperto**,
 * che e' il fallimento giusto — brutto ma navigabile, invece di elegante e muto.
 */
document.querySelectorAll(".nav-gruppo").forEach((bottone) => {
  const pannello = document.getElementById(bottone.getAttribute("aria-controls"));
  if (!pannello) return;

  const barra = bottone.closest(".nav");
  const scorrevole = bottone.closest(".nav-link");

  /**
   * Ancora il riquadro sotto il pulsante.
   *
   * ⚠️ Il `left` non puo' stare nel CSS. Il pannello e' figlio di `.nav` — deve
   * esserlo, perche' `.nav-link` ha `overflow-x:auto` e dentro lo ritaglierebbe
   * — quindi le due ascisse non coincidono, e su schermo stretto quella del
   * pulsante **cambia mentre la barra scorre**.
   *
   * Il riquadro viene poi tirato dentro il bordo destro: ancorato e basta,
   * sull'ultima voce di una barra stretta uscirebbe dallo schermo.
   */
  const ancora = () => {
    const b = bottone.getBoundingClientRect();
    const n = barra.getBoundingClientRect();
    const largo = pannello.offsetWidth;
    const massimo = n.width - largo - 8;
    pannello.style.left = Math.max(8, Math.min(b.left - n.left, massimo)) + "px";
  };

  // Da qui in poi il pannello lo governa lo script: prima era visibile apposta,
  // cosi' senza JS le sue voci restano raggiungibili.
  const mostra = (aperto) => {
    bottone.setAttribute("aria-expanded", String(aperto));
    pannello.hidden = !aperto;
    if (aperto) ancora();
  };
  mostra(false);

  bottone.addEventListener("click", (e) => {
    e.stopPropagation();
    mostra(bottone.getAttribute("aria-expanded") !== "true");
  });

  addEventListener("resize", () => { if (!pannello.hidden) ancora(); });
  scorrevole?.addEventListener("scroll", () => { if (!pannello.hidden) ancora(); }, {passive: true});

  // Fuori dal pannello si chiude; dentro no, altrimenti il click su una voce
  // verrebbe annullato prima di navigare.
  document.addEventListener("click", (e) => {
    if (!pannello.contains(e.target)) mostra(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || pannello.hidden) return;
    mostra(false);
    bottone.focus();
  });
});
