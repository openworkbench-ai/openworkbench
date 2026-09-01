import { Card, CardHeader, CardTitle, CardContent, Muted } from "@openworkbench/app-ui-kit"
import type { Workout } from "../generated/entities.js"

export default function WorkoutCard(props: Partial<Workout>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.name ?? "Untitled workout"}</CardTitle>
      </CardHeader>
      <CardContent>
        <Muted>Added to plan {props.plan ?? "—"}</Muted>
      </CardContent>
    </Card>
  )
}
