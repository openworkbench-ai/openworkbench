import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Badge,
  Muted,
} from "@openworkbench/app-ui-kit"
import type { Workout, Exercise } from "../generated/entities.js"
import { formatStation, formatSeconds } from "./format.js"

interface WorkoutDetailProps {
  workout?: Workout
  /** A "list" step's result always comes wrapped this way, not a bare array. */
  exercises?: { rows: Exercise[]; total: number }
}

export default function WorkoutDetail(props: WorkoutDetailProps) {
  const rows = [...(props.exercises?.rows ?? [])].sort((a, b) => a.order - b.order)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.workout?.name ?? "Workout"}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Muted>No exercises yet.</Muted>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Station</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((exercise) => (
                <TableRow key={exercise.id}>
                  <TableCell>{exercise.order}</TableCell>
                  <TableCell>{formatStation(exercise.station)}</TableCell>
                  <TableCell>{formatSeconds(exercise.target_seconds)}</TableCell>
                  <TableCell>
                    <Badge variant={exercise.status === "completed" ? "accent" : "muted"}>
                      {exercise.status ?? "planned"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
