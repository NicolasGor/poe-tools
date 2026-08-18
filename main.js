/**
 * Punto d'ingresso per Deno Deploy.
 *
 * Il pannello di Deploy non ha un campo "entrypoint": lo deduce dal repo, e il
 * nome che cerca per primo e' questo. Il codice vero sta in
 * `server/warrant-api.js` — qui non c'e' logica, solo l'indirizzo di casa, cosi'
 * chi apre il repo non si chiede quale dei due file sia quello che gira.
 */
export { default } from "./server/warrant-api.js";
