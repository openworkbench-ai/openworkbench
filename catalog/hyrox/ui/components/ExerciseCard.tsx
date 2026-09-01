import { Card, CardHeader, CardTitle, CardContent, Badge, Stat } from "@openworkbench/app-ui-kit"
import type { Exercise } from "../generated/entities.js"
import { formatStation, formatSeconds } from "./format.js"

export default function ExerciseCard(props: Partial<Exercise>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{formatStation(props.station)}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <Stat value={props.order ?? "—"} label="Order" />
        <Stat value={formatSeconds(props.target_seconds)} label="Target" />
        <Badge variant={props.status === "completed" ? "accent" : "muted"}>{props.status ?? "planned"}</Badge>
      </CardContent>
    </Card>
  )
}
