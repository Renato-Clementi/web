# BAB-75 — Reporting disponibilità e controllo ore (Odoo 18 HR)

**Fase 4 del piano [BAB-58]. Owner: Chronos. Verificato live il 2026-06-15 sullo
staging Odoo 18 (`babooesco-odoo-staging`).**

Set pilota = **Maggio 2026** (dati Fluida back-fillati, [BAB-91]: 308 hr.attendance)
+ **disponibilità "oggi" 2026-06-15** (timbrature go-live, [BAB-74]).

---

## 1. Viste/dashboard salvate (generabili on demand)

Create 5 viste globali `ir.filters` (visibili a tutti gli utenti HR) sui modelli
di reporting nativi di Odoo 18 — aperte dai menu **Presenze › Reporting** e
**Ferie › Reporting**. Tutte verificate eseguendo il dominio su dati live.

| id | Vista | Modello | Cosa mostra |
|----|-------|---------|-------------|
| 86 | **Presenti oggi** | `hr.attendance` | Timbrature dal giorno corrente, raggruppate per dipendente (`context_today()` dinamico) |
| 87 | **Ore lavorate per dipendente (mese corrente)** | `hr.attendance` | Pivot ore lavorate del mese in corso per dipendente (misura `worked_hours`) |
| 88 | **Timbrature incomplete (checkout mancante)** | `hr.attendance` | Punch senza check_out — lente anomalie/controllo dati |
| 89 | **Ferie/permessi previsti (approvati, da oggi)** | `hr.leave` | Assenze approvate future, per dipendente e tipo |
| 90 | **Saldo ferie/permessi per dipendente** | `hr.leave.allocation` | Allocazioni validate per tipo e dipendente (base del saldo) |

I filtri usano date dinamiche (`context_today()`) → restano corretti ogni giorno
senza modifiche. Additivi e reversibili: nessun record dipendente toccato.

Script riproducibile: `scripts/bab75_filters.ts` (idempotente, `--dry-run` per anteprima).

---

## 2. KPI verificati sul pilota (Maggio 2026)

Script read-only: `scripts/bab75_reporting.ts 2026-05 2026-06-15`.

### Monte ore & controllo ore (ore lavorate vs contrattuali)

- **Monte ore Maggio 2026 = 1.659,1 h** su **14 dipendenti** con timbrature.
- Calendario contrattuale di riferimento: *Tempo Pieno 40 ore/settimana* (8 h/g), id 1.
- Metrica scostamento = `ore lavorate − (giorni con timbratura × 8h)` → misura la
  **completezza giornaliera** (hanno raggiunto le ore contrattuali nei giorni in
  cui erano presenti). Scelta perché il pilota ha copertura parziale (back-fill /
  go-live mid-periodo): non penalizza i giorni prima del go-live. La variante
  "vs giorni lavorativi del mese da calendario" è per la fase steady-state ([BAB-76]).

| Dipendente | Ore lav. | GG | Atteso | Scost. |
|---|---:|---:|---:|---:|
| Lorenzo Pizzi | 170,1 | 20 | 160,0 | **+10,1** |
| Tommaso Ferraris | 161,3 | 20 | 160,0 | +1,3 |
| Michele Beltrami | 160,8 | 19 | 152,0 | +8,8 |
| Francesco Ubbiali | 156,2 | 20 | 160,0 | −3,8 |
| Fabio Favino | 155,7 | 18 | 144,0 | +11,7 |
| Matilda Battistini | 154,1 | 20 | 160,0 | −5,9 |
| Andrea Pirazzi | 153,1 | 20 | 160,0 | −6,9 |
| Tommaso Ferrarese | 135,7 | 17 | 136,0 | −0,3 |
| Matthias Baroni | 111,3 | 15 | 120,0 | −8,7 |
| Federico Guarnori | 109,0 | 14 | 112,0 | −3,0 |
| **Alice Ricca** | **71,7** | 19 | 152,0 | **−80,3 ⚠** |
| Mourad Jaouhari Lebrari | 64,9 | 8 | 64,0 | +0,9 |
| Orient Zekaj | 31,3 | 4 | 32,0 | −0,7 |
| Dima Ditlashok | 23,9 | 3 | 24,0 | −0,1 |

### Saldo ferie/permessi (KPI, tutti i dipendenti)

| Tipo | Allocato | Fruito | **Saldo** |
|---|---:|---:|---:|
| Ferie | 468,0 gg | 0,0 | **468,0 gg** |
| Permessi (ROL / Ex-festività) | 234,0 gg (=1.872 h) | 0,0 | **234,0 gg** |

36 allocazioni validate = **18 dipendenti reali × 2 tipi** (coerente con [BAB-90]).
L'unico account attivo senza allocazione è *Administrator* (id 1, account di
sistema, escluso dall'organico). Fruito = 0 perché le ferie native sono attive da
poco e nessuna richiesta è ancora stata approvata.

### Disponibilità & calendario (oggi 2026-06-15)

- **Presenti (timbrati) oggi: 10** dipendenti.
- **Disponibili (non in ferie/permesso): 18/18** dipendenti reali.
- Assenze approvate oggi: **0**. Calendario ferie/permessi previsti (futuri): **0**
  (nessuna richiesta ancora approvata — atteso, ferie native appena avviate).

---

## 3. Anomalie / integrità dati emerse (i report fanno il loro lavoro)

- **Alice Ricca −80,3 h** = anomalia di **timbrature incomplete**, non di
  sotto-lavoro: molti giorni hanno solo il punch del mattino (~3,5 h, check-out
  ~10:30) e manca la coppia pomeridiana. Da regolarizzare nello scope manuale
  ricorrente ([BAB-76] / policy [BAB-88]).
- Vista 88 *Timbrature incomplete* = 0 punch aperti oggi → il pairing robusto
  ([BAB-89]) tiene; le anomalie residue sono **mezze giornate** (coppie corte),
  non check-out mancanti.
- Federico/Matthias/Mourad/Orient/Dima con pochi giorni = copertura parziale del
  mese (assunzioni/turni/go-live), non errori.

---

## 4. Esito accettazione

✅ **Report disponibilità e controllo ore generabili** → 5 viste salvate live (id 86–90).
✅ **Verificati su set pilota** → KPI Maggio 2026 + disponibilità 2026-06-15 calcolati
e riconciliati con i record live (1.659,1 h; 468 + 234 gg saldo; 14 dip. con presenze).

Operatività continua, anomalie ricorrenti e report schedulato → [BAB-76] (Fase 5).
