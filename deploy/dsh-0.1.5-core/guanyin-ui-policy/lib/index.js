import { installUsage } from './usage.js'

export const inject = ['llm', 'sessions']

export function apply(ctx) { installUsage(ctx) }
