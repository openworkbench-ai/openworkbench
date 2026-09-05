import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Stat } from "@openworkbench/app-ui-kit"
import type { Match } from "../generated/entities.d.ts"

const STAGE_LABEL: Record<string, string> = {
  round_robin: "Round Robin",
  semifinal: "Semifinal",
  final: "Final",
}

export default function MatchCard(props: Partial<Match>) {
  const stageLabel = STAGE_LABEL[props.stage ?? ""] ?? props.stage ?? "Match"
  const decided = props.played && props.winner

  return (
    <Card>
      <CardHeader>
        <CardTitle>{stageLabel}</CardTitle>
        <CardDescription>
          {decided ? "Result recorded" : "Awaiting result"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-6">
        <Stat value={props.sets_won_a ?? "-"} label="Team A sets" />
        <Stat value={props.sets_won_b ?? "-"} label="Team B sets" />
        {decided ? (
          <Badge variant="accent">Winner: {props.winner}</Badge>
        ) : (
          <Badge variant="muted">Not played</Badge>
        )}
      </CardContent>
    </Card>
  )
}
