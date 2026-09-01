const STATION_LABELS: Record<string, string> = {
  run: "Run",
  ski_erg: "SkiErg",
  sled_push: "Sled Push",
  sled_pull: "Sled Pull",
  burpee_broad_jump: "Burpee Broad Jump",
  rowing: "Rowing",
  farmers_carry: "Farmers Carry",
  sandbag_lunges: "Sandbag Lunges",
  wall_balls: "Wall Balls",
  full_simulation: "Full Simulation",
}

export function formatStation(station: string | undefined): string {
  if (!station) return "Unknown station"
  return STATION_LABELS[station] ?? station
}

export function formatSeconds(seconds: number | undefined): string {
  if (seconds == null) return "—"
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}
