#!/usr/bin/env node
// Точка входа пакета для сайтов (bin «sat» из dist/cli.js). В репо — scripts/sat.mjs.
import { main } from "./lib/pipeline.ts";

process.exitCode = await main(process.argv.slice(2));
