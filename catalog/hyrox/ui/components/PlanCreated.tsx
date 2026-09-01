import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge } from "@openworkbench/app-ui-kit"
import type { Plan, Workout } from "../generated/entities.js"

interface PlanCreatedProps {
  plan?: Plan
  workout?: Workout
}

export default function PlanCreated(props: PlanCreatedProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.plan?.name ?? "New training plan"}</CardTitle>
        {props.plan?.notes ? <CardDescription>{props.plan.notes}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <Badge variant="accent">First workout: {props.workout?.name ?? "Untitled"}</Badge>
      </CardContent>
    </Card>
  )
}
