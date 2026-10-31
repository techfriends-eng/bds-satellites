#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// Точка входа конвейера спутника: разбор аргументов и вызов src/lib/pipeline.ts (стандарт 01).
//   sat run | sync | collect | select | draft | stand | gates | revise | visuals | publish [id …]
import { main } from "../src/lib/pipeline.ts";

process.exitCode = await main(process.argv.slice(2));
