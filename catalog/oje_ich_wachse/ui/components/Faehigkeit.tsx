import { Card, CardContent, Badge, Muted } from "@openworkbench/app-ui-kit";
import type { Faehigkeit } from "../generated/entities.d.ts";

function formatDatum(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("de-DE");
}

export default function FaehigkeitKarte(props: Partial<Faehigkeit>) {
  const beobachtet = formatDatum(props.beobachtet_am);

  return (
    <Card>
      <CardContent className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm">{props.beschreibung}</span>
          {beobachtet ? (
            <Badge variant="accent">✓ {beobachtet}</Badge>
          ) : (
            <Badge variant="outline">offen</Badge>
          )}
        </div>
        {props.notiz ? <Muted>„{props.notiz}“</Muted> : null}
      </CardContent>
    </Card>
  );
}
