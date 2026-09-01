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
  Muted,
} from "@openworkbench/app-ui-kit"
import type { Workout } from "../generated/entities.js"

/** A "list" step's result always comes wrapped this way, not a bare array. */
interface WorkoutListProps {
  rows?: Workout[]
  total?: number
}

export default function WorkoutList(props: WorkoutListProps) {
  const rows = props.rows ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workouts</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Muted>No workouts yet.</Muted>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Plan</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((workout) => (
                <TableRow key={workout.id}>
                  <TableCell>{workout.name}</TableCell>
                  <TableCell>
                    <Muted>{workout.plan}</Muted>
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
