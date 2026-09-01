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
import type { Exercise } from "../generated/entities.js"
import { formatStation, formatSeconds } from "./format.js"

/** A "list" step's result always comes wrapped this way, not a bare array. */
interface ExerciseListProps {
  rows?: Exercise[]
  total?: number
}

export default function ExerciseList(props: ExerciseListProps) {
  const rows = props.rows ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>Exercises</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Muted>No exercises yet.</Muted>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Station</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((exercise) => (
                <TableRow key={exercise.id}>
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
