// Generated from manifest.json entities -- do not edit by hand.

export interface Plan {
  id: string
  name: string
  notes?: string
  created_at: string
  updated_at: string
}

export interface Workout {
  id: string
  plan: string
  name: string
  created_at: string
  updated_at: string
}

export interface Exercise {
  id: string
  workout: string
  order: number
  station: "run" | "ski_erg" | "sled_push" | "sled_pull" | "burpee_broad_jump" | "rowing" | "farmers_carry" | "sandbag_lunges" | "wall_balls" | "full_simulation"
  target_seconds?: number
  status?: "planned" | "completed"
  created_at: string
  updated_at: string
}

export interface Result {
  id: string
  exercise: string
  duration_seconds: number
  reps?: number
  notes?: string
  created_at: string
  updated_at: string
}
