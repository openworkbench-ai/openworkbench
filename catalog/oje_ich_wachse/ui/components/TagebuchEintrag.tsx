import { Card, CardHeader, CardTitle, CardContent, Badge } from "@openworkbench/app-ui-kit";
import type { Eintrag } from "../generated/entities.d.ts";

function formatDatum(iso?: string | null): string {
  if (!iso) return "Eintrag";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function TagebuchEintragKarte(props: Partial<Eintrag>) {
  const stürmisch = props.stimmung === "stürmisch";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{formatDatum(props.datum)}</CardTitle>
          {props.stimmung ? (
            <Badge variant={stürmisch ? "destructive" : "muted"}>{props.stimmung}</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <span className="text-sm">{props.text}</span>
      </CardContent>
    </Card>
  );
}
