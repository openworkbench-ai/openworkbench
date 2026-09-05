import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Eyebrow,
  Muted,
} from "@openworkbench/app-ui-kit";
import type { Sprung } from "../generated/entities.d.ts";

export default function SprungKarte(props: Partial<Sprung>) {
  const wochen =
    props.start_woche != null && props.ende_woche != null
      ? `ca. Woche ${props.start_woche}–${props.ende_woche} ab Geburt`
      : null;

  return (
    <Card>
      <CardHeader>
        <Eyebrow>
          Sprung {props.nummer ?? "?"}
          {wochen ? ` · ${wochen}` : ""}
        </Eyebrow>
        <CardTitle>{props.titel ?? "Sprung"}</CardTitle>
      </CardHeader>
      <CardContent>
        <Muted>{props.thema}</Muted>
      </CardContent>
    </Card>
  );
}
