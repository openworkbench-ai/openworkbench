---
name: entwicklung-erfassen
description: Arbeitsweise für den Oje-ich-wachse-Sprung-Tracker – wie man die aktuelle Woche berechnet, den passenden Sprung findet, Fähigkeiten abhakt und stürmische Wochen ins Tagebuch schreibt. Nutze dies, wenn die Eltern über neue Fähigkeiten, Unruhe/Weinen oder den Stand der Entwicklung berichten.
---

# Entwicklung erfassen (Oje, ich wachse!)

## Wochenrechnung: Wo steht das Kind gerade?

1. Lese das Geburtsdatum des Kindes (Entity `kind`, z. B. Aria, geb. 2026-06-11).
2. Berechne das aktuelle Alter in Wochen: `(heutes Datum − Geburtsdatum) / 7`, auf ganze Wochen gerundet.
3. Rufe `spruenge_anzeigen` auf und finde den Sprung, dessen Fenster (`start_woche`–`ende_woche`) das aktuelle Alter enthält. Das ist der **aktuelle Sprung**; der nächste Sprung beginnt mit seinem `start_woche`.

Hinweise:
- Das Buch rechnet ab dem **berechneten Geburtstermin**; diese App rechnet ab dem tatsächlichen Geburtsdatum. Die Fenster sind Richtwerte – real weichen Kinder oft 1–2 Wochen ab, das ist normal.
- Unruhe, Klammern und mehr Weinen **vor** dem Fenster sind typisch („stürmische Wochen“) und gehören zum Sprung dazu.

## Neue Fähigkeit berichtet → abhaken

1. Bestimme den passenden Sprung (aktueller Sprung, oder den Sprung, den die Eltern nennen).
2. Rufe `sprung_checkliste` mit dessen `id` auf und suche den Punkt, der am besten zur berichteten Fähigkeit passt.
3. Rufe `faehigkeit_beobachten` auf mit:
   - `faehigkeit_id` = die Zeilen-ID des Checklisten-Punkts,
   - `beobachtet_am` = heutiges Datum (bei „gestern“ etc. entsprechend zurückrechnen, ISO-Format),
   - `notiz` = kurzes Detail, das die Eltern erwähnt haben (optional).
4. Passt kein Checklisten-Punkt, lege über die generische Create-Operation eine neue Zeile in `faehigkeit` an: `sprung` = Sprung-ID, `beschreibung` = die beobachtete Fähigkeit in eigenen Worten, `beobachtet_am` = Datum.

## Stürmische / ruhige Tage → Tagebuch

Wenn die Eltern von Unruhe, Klammern, Schlafproblemen oder auffallend guter Laune berichten, rufe `notiz_hinzufuegen` auf:
- `kind_id` = ID des Kindes (bei mehreren Kindern nachfragen, welches gemeint ist),
- `sprung_id` = ID des aktuellen Sprungs (falls einzuordnen),
- `datum` = heutiges Datum,
- `stimmung` = `stürmisch` bei Unruhe/Klammern/Weinen, `ruhig` bei zufriedenen, ausgeglichenen Tagen, sonst `neutral`,
- `text` = die Beobachtung, knapp und im Wortlaut der Eltern.

## Typische Fragen

- „Wo stehen wir gerade? / Welcher Sprung ist dran?“ → Wochenrechnung + `spruenge_anzeigen`, dann konkret antworten (Sprung-Nummer, Titel, wie viele Wochen noch im Fenster).
- „Was kann sie in diesem Sprung Neues lernen?“ → `sprung_checkliste` des aktuellen Sprungs.
- „Was haben wir schon beobachtet?“ → `sprung_checkliste` bzw. generische Listen-Abfrage auf `faehigkeit` (Zeilen mit `beobachtet_am`).
- „Zeig mir das Tagebuch“ → `tagebuch_anzeigen`.

## Grenzen

- Keine medizinischen Einschätzungen oder Diagnosen – das Buch ist ein Beobachtungsleitfaden. Bei Besorgnis erregenden Signalen empfehlen, die Kinderärztin/den Kinderarzt zu kontaktieren.
- Fähigkeiten erscheinen in jeder Reihenfolge und Geschwindigkeit; ein noch nicht abgehakter Punkt ist kein Defizit.
