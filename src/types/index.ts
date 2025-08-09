export interface Screenshot {
  id: string
  path: string
  timestamp: number
  thumbnail: string // Base64 thumbnail
}

export interface Solution {
  initial_thoughts: string[]
  thought_steps: string[]
  description: string
  code: string
}

export interface ProblemInfo {
  type: "problem"
  problem_statement: string
  constraints: string[]
  example_input: string
  example_output: string
}

export interface CodeInfo {
  type: "code"
  language: string
  explanation: string
  issues: string[]
  completed_code: string
}