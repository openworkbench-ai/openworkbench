import { Card, CardHeader, CardTitle, CardContent, Stat, Badge, Muted } from "@openworkbench/app-ui-kit"
import type { Result, Exercise } from "../generated/entities.js"
import { formatStation, formatSeconds } from "./format.js"

interface ResultLoggedProps {
  result?: Result
  exercise?: Exercise
}

export default function ResultLogged(props: ResultLoggedProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{formatStation(props.exercise?.station)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <Stat value={formatSeconds(props.result?.duration_seconds)} label="Time" />
          {props.result?.reps != null ? <Stat value={props.result.reps} label="Reps" /> : null}
          <Badge variant="accent">completed</Badge>
        </div>
        {props.result?.notes ? <Muted>{props.result.notes}</Muted> : null}
      </CardContent>
    </Card>
  )
}
